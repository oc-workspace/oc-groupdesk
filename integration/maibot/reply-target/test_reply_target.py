import asyncio
from copy import deepcopy
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, AsyncMock, patch

import group_guard
import reply_target


class ReplyTargetTests(unittest.TestCase):
    def setUp(self):
        self.identifier = 'a' * 32
        self.mid = 'bowxt-in-turn-' + self.identifier
        self.turn = dict(id=self.identifier, chat_id='26992', policy_revision='11')
        self.p = NS(active_turn=lambda: self.turn, cfg={}, clock=lambda: 1000)
        self.message = NS(message_id=self.mid, platform='wechat_linux', message_info=NS(
            additional_config={'gt_limit_turn': self.identifier, 'gt_chat_id': '26992'},
            group_info=NS(group_id='bowxt:26992')))
        self.runtime = NS(find_source_message_by_id=Mock(side_effect=lambda mid: self.message if mid == self.mid else None))
        token = group_guard.TURN.set(self.identifier)
        self.addCleanup(group_guard.TURN.reset, token)
        patcher = patch.object(group_guard, 'policy', return_value=self.p)
        patcher.start(); self.addCleanup(patcher.stop)

    def test_missing_target_recovers_exact_admitted_source(self):
        self.assertEqual(reply_target.resolve(self.runtime, {}), (self.mid, True))
        self.runtime.find_source_message_by_id.assert_called_once_with(self.mid)

    def test_empty_string_can_recover(self):
        self.assertEqual(reply_target.resolve(self.runtime, {'msg_id': ' '}), (self.mid, True))

    def test_explicit_target_is_never_replaced(self):
        for value in ['old-message', self.mid, 123, []]:
            self.assertEqual(reply_target.resolve(self.runtime, {'msg_id': value}), (value, False))
        self.runtime.find_source_message_by_id.assert_not_called()

    def test_unbound_and_stale_contexts_do_not_recover(self):
        for value in [None, 'b' * 32, '[GT_REQUEST_ID:' + self.identifier + ']']:
            group_guard.TURN.set(value)
            self.assertEqual(reply_target.resolve(self.runtime, {}), (None, False))

    def test_expired_or_absent_turn_does_not_recover(self):
        self.turn = None
        self.assertEqual(reply_target.resolve(self.runtime, {}), (None, False))

    def test_cross_group_platform_and_metadata_mismatches_rejected(self):
        original = deepcopy(self.message)
        mutations = [lambda m: setattr(m, 'platform', 'other'),
                     lambda m: setattr(m, 'message_id', 'other'),
                     lambda m: m.message_info.additional_config.update(gt_chat_id='1'),
                     lambda m: m.message_info.additional_config.update(gt_limit_turn='b' * 32),
                     lambda m: setattr(m.message_info.group_info, 'group_id', 'bowxt:1')]
        for mutate in mutations:
            self.message = deepcopy(original); mutate(self.message)
            self.assertEqual(reply_target.resolve(self.runtime, {}), (None, False))

    def test_absent_session_source_rejected(self):
        self.message = None
        self.assertEqual(reply_target.resolve(self.runtime, {}), (None, False))

    def test_group_lease_revision_disabled_or_expired_rejected(self):
        for managed in [dict(enabled=True, valid_until=1100, revision='12'),
                        dict(enabled=False, valid_until=1100, revision='11'),
                        dict(enabled=True, valid_until=900, revision='11')]:
            self.p.cfg = {'managed_groups': {'26992': managed}}
            self.assertEqual(reply_target.resolve(self.runtime, {}), (None, False))

    def test_native_missing_id_reaches_existing_guarded_send_once(self):
        from src.maisaka.builtin_tool import reply
        self.runtime.session_id = 'synthetic'
        self.runtime.log_prefix = '[synthetic]'
        self.runtime.record_planner_reply = Mock()
        ctx = NS(runtime=self.runtime, build_success_result=Mock(return_value=NS()),
                 build_failure_result=Mock(side_effect=AssertionError('Unexpected reply failure')))
        with patch.object(group_guard, 'authorize_fast_reply', return_value=True), \
             patch.object(reply.send_service, '_send_to_target_with_message', new=AsyncMock(return_value=NS())) as send:
            result = asyncio.run(reply.execute_reply(ctx, {
                'reply_reference': 'Synthetic regression: missing msg_id',
                'reply_text': 'Good evening.'}, call_id='synthetic-missing-target'))
        self.assertTrue(result.stop_after_execution)
        send.assert_awaited_once()
        self.assertIs(send.call_args.kwargs['reply_message'], self.message)
        self.assertEqual(send.call_args.kwargs['processed_plain_text'], 'Good evening.')


if __name__ == '__main__':
    unittest.main()
