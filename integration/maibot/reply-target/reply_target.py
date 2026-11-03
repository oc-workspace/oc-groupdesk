"""Repair bounded reply arguments only for the live admitted transport source."""
import re


def resolve(runtime, arguments):
    # An explicit target, even an invalid one, is never silently redirected.
    supplied = arguments.get('msg_id')
    if supplied is not None and (not isinstance(supplied, str) or supplied.strip()):
        return supplied, False
    from group_guard import TURN, policy
    import groupdesk_runtime as gd
    identifier = TURN.get()
    if not isinstance(identifier, str) or not re.fullmatch('[0-9a-f]{32}', identifier):
        return supplied, False
    p = policy()
    turn = p.active_turn()
    if not turn or turn['id'] != identifier or not turn.get('chat_id'):
        return supplied, False
    managed = gd.profile(p.cfg, turn['chat_id'])
    if managed and (not gd.available(managed, p.clock()) or
                    gd.revision(managed) != str(turn.get('policy_revision', ''))):
        return supplied, False
    # find_source_message_by_id searches only this runtime's current session.
    mid = 'bowxt-in-turn-' + identifier
    message = runtime.find_source_message_by_id(mid)
    info = getattr(message, 'message_info', None)
    metadata = getattr(info, 'additional_config', None) or {}
    if (getattr(message, 'message_id', None) != mid or
            getattr(message, 'platform', None) != 'wechat_linux' or
            metadata.get('gt_limit_turn') != identifier or
            metadata.get('gt_chat_id') != turn['chat_id'] or
            getattr(getattr(info, 'group_info', None), 'group_id', None) != 'bowxt:' + turn['chat_id']):
        return supplied, False
    return mid, True


def normalize_reference(runtime, arguments):
    """Accept one observed structured-reference shape after verifying its target.

    Do not stringify arbitrary objects, infer a different target, or accept
    hidden extra options. Ordinary valid string references are untouched.
    """
    reference = arguments.get('reply_reference')
    if not isinstance(reference, dict) or set(reference) != {'message_id', 'reply_direction'}:
        return arguments, False
    target = reference['message_id']
    direction = reference['reply_direction']
    if (not isinstance(target, str) or not isinstance(direction, str)
            or not direction.strip() or len(direction) > 4000):
        return arguments, False
    admitted, verified = resolve(runtime, {})
    if not verified or target.strip() != admitted:
        return arguments, False
    supplied = arguments.get('msg_id')
    if supplied is not None and (not isinstance(supplied, str)
            or (supplied.strip() and supplied.strip() != admitted)):
        return arguments, False
    normalized = dict(arguments)
    normalized['reply_reference'] = direction.strip()
    normalized['msg_id'] = admitted
    return normalized, True
