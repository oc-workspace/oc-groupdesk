"""Send a WeChat reply addressed to the admitted message's sender."""

import asyncio
import hashlib
import re
import unicodedata

from bowxt import SafetyPolicy
from reply_length import shorten


def member_name(display):
    # Upstream stores at most 80 characters. A possibly truncated name is
    # unsafe to look up. The Reader's placeholder is not a WeChat nickname.
    if not isinstance(display, str) or not 0 < len(display) < 80:
        return None
    if any(unicodedata.category(char) in {'Cc', 'Cs'} for char in display):
        return None
    member = ' '.join(display.split())
    folded = unicodedata.normalize('NFKC', member).casefold().lstrip('@ ')
    if not folded or folded.startswith('昵称未同步-') or folded in {
        'all', 'everyone', '所有人', '全体成员', '全体成員',
    }:
        return None
    return member


def target_for_reply(policy, source_message_id, chat_id):
    if not isinstance(source_message_id, str):
        return None
    match = re.fullmatch(r'bowxt-in-turn-([0-9a-f]{32})', source_message_id)
    if not match:
        return None
    with policy.db() as db:
        row = db.execute(
            'SELECT reply_member FROM turns WHERE id=? AND chat_id=?',
            (match[1], str(chat_id)),
        ).fetchone()
    return member_name(row['reply_member']) if row else None


def strict_migration_reply(policy, turn_id):
    if not isinstance(turn_id, str) or not re.fullmatch(r'[0-9a-f]{32}', turn_id):
        return False
    with policy.db() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_backfill_turns'").fetchone():
            return False
        return bool(db.execute('SELECT 1 FROM migration_backfill_turns WHERE turn_id=?',(turn_id,)).fetchone())


def mention_failed_before_send(receipt, queued, chat_id, client_id, member):
    if (receipt.delivery_status != 'failed' or receipt.seq != queued.seq
            or receipt.chat_id != chat_id or receipt.client_id != client_id):
        return False
    # Bowxt only returns these exact errors from its member selector, before
    # pasting the body or pressing Enter, and after temporary input cleanup.
    return receipt.delivery_error in {
        f'no unique visible exact @ candidate for member {member!r}',
        f'WeChat did not expose a rich mention token after selecting {member!r}',
    }


async def deliver(agent, chat_id, text, *, client_id, member, before_fallback, allow_fallback=True):
    if not member:
        queued = await asyncio.to_thread(agent.send_text, chat_id, text, client_id=client_id)
        return await asyncio.to_thread(agent.wait_delivery, queued, timeout=60)

    max_chars = SafetyPolicy().max_text_length
    body = shorten(text, max_chars - len(member) - 2)
    queued = await asyncio.to_thread(
        agent.send_text, chat_id, body, mentions=(member,), client_id=client_id,
    )
    receipt = await asyncio.to_thread(agent.wait_delivery, queued, timeout=60)
    if (not allow_fallback or not mention_failed_before_send(receipt, queued, chat_id, client_id, member)
            or not await before_fallback()):
        return receipt
    fallback_id = 'plain-' + hashlib.sha256(client_id.encode()).hexdigest()
    queued = await asyncio.to_thread(
        agent.send_text, chat_id, shorten(text, max_chars), client_id=fallback_id,
    )
    return await asyncio.to_thread(agent.wait_delivery, queued, timeout=60)
