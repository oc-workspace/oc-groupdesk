import asyncio
from contextlib import closing
from dataclasses import dataclass, replace
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from reply_mention import deliver, member_name, strict_migration_reply, target_for_reply


@dataclass
class Receipt:
    seq: int
    chat_id: int
    client_id: str
    delivery_status: str = 'pending'
    delivery_error: str | None = None


class Sender:
    def __init__(self, state='sent', error=None):
        self.calls = []
        self.state = state
        self.error = error

    def send_text(self, chat, text, *, client_id, mentions=()):
        self.calls.append((chat, text, mentions))
        return Receipt(len(self.calls), chat, client_id)

    def wait_delivery(self, receipt, *, timeout):
        if receipt.seq == 1:
            return replace(receipt, delivery_status=self.state, delivery_error=self.error)
        return replace(receipt, delivery_status='sent')


class MentionTests(unittest.TestCase):
    def run_delivery(self, sender, member='A Member', allow_fallback=True):
        guard = AsyncMock(return_value=allow_fallback)
        result = asyncio.run(deliver(sender, 5, 'Hello!', client_id='synthetic',
                                     member=member, before_fallback=guard))
        return result, guard

    def test_submits_one_native_mention_and_keeps_body_separate(self):
        sender = Sender()
        result, guard = self.run_delivery(sender)
        self.assertEqual(sender.calls, [(5, 'Hello!', ('A Member',))])
        self.assertEqual(result.delivery_status, 'sent')
        guard.assert_not_called()

    def test_selection_failure_can_send_plain_body_once(self):
        sender = Sender('failed', "no unique visible exact @ candidate for member 'A Member'")
        result, guard = self.run_delivery(sender)
        self.assertEqual(sender.calls, [(5, 'Hello!', ('A Member',)), (5, 'Hello!', ())])
        self.assertEqual(result.delivery_status, 'sent')
        guard.assert_awaited_once()

    def test_migration_reply_never_falls_back_to_plain_text(self):
        sender = Sender('failed', "no unique visible exact @ candidate for member 'A Member'")
        guard = AsyncMock(return_value=True)
        result = asyncio.run(deliver(sender, 5, 'Hello!', client_id='synthetic',
                                     member='A Member', before_fallback=guard, allow_fallback=False))
        self.assertEqual(result.delivery_status,'failed')
        self.assertEqual(len(sender.calls),1)
        guard.assert_not_called()

    def test_uncertain_or_expired_replies_never_retry(self):
        for state, error, allowed in (
            ('failed', 'unexpected UI error', True),
            ('unverified', None, True),
            ('failed', "WeChat did not expose a rich mention token after selecting 'A Member'", False),
        ):
            with self.subTest(state=state, error=error):
                sender = Sender(state, error)
                result, _ = self.run_delivery(sender, allow_fallback=allowed)
                self.assertEqual(len(sender.calls), 1)
                self.assertEqual(result.delivery_status, state)

    def test_member_must_be_from_reply_source_and_same_group(self):
        source = '1' * 32
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'test.sqlite'

            class Policy:
                def db(self):
                    db = sqlite3.connect(path)
                    db.row_factory = sqlite3.Row
                    return closing(db)

            policy = Policy()
            with policy.db() as db:
                db.execute('CREATE TABLE turns(id TEXT, chat_id TEXT, reply_member TEXT)')
                db.execute('INSERT INTO turns VALUES (?, ?, ?)', (source, '5', 'A Member'))
                db.commit()
            self.assertEqual(target_for_reply(policy, 'bowxt-in-turn-' + source, 5), 'A Member')
            self.assertIsNone(target_for_reply(policy, 'bowxt-in-turn-' + source, 6))
            self.assertIsNone(target_for_reply(policy, 'A Member', 5))
            with policy.db() as db:
                db.execute('CREATE TABLE migration_backfill_turns(turn_id TEXT PRIMARY KEY)')
                db.execute('INSERT INTO migration_backfill_turns VALUES (?)',(source,))
                db.commit()
            self.assertTrue(strict_migration_reply(policy,source))
            self.assertFalse(strict_migration_reply(policy,'2'*32))

    def test_unsafe_recipient_yields_plain_reply(self):
        for display in ('昵称未同步-01234567', '所有人', '＠All', 'x' * 80, 'A\nB'):
            self.assertIsNone(member_name(display))
        sender = Sender()
        self.run_delivery(sender, member=None)
        self.assertEqual(sender.calls, [(5, 'Hello!', ())])

    def test_real_maibot_packet_preserves_explicit_reply_anchor(self):
        from src.services import send_service

        anchor = SimpleNamespace(
            platform='wechat_linux', message_id='bowxt-in-turn-' + '1' * 32,
            message_info=SimpleNamespace(group_info=SimpleNamespace(group_id='bowxt:5')),
        )
        anchor.deepcopy = lambda: anchor
        stream = SimpleNamespace(
            platform='wechat_linux', account_id='synthetic', group_id='bowxt:5',
            group_name='Synthetic group', user_id=None, session_id='test',
            context=None, scope=None,
        )
        body = send_service.MessageSequence([send_service.TextComponent('Hello!')])
        with (patch.object(send_service._chat_manager, 'get_session_by_session_id', return_value=stream),
              patch.object(send_service, 'get_bot_account', return_value='synthetic-bot')):
            reply = send_service._build_outbound_session_message(
                body, 'test', processed_plain_text='Hello!', reply_message=anchor,
            )
            packet = asyncio.run(reply.to_maim_message())
            self.assertEqual(packet.message_info.additional_config['gt_reply_source_id'], anchor.message_id)
            anchor.message_info.group_info.group_id = 'bowxt:6'
            cross_group = send_service._build_outbound_session_message(
                body, 'test', processed_plain_text='Hello!', reply_message=anchor,
            )
            self.assertNotIn('gt_reply_source_id', cross_group.message_info.additional_config)


if __name__ == '__main__':
    unittest.main()
