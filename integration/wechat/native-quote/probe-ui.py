"""Inspect one native Quote preview and cancel it; never presses Enter."""
import json
from pathlib import Path
import sys

from bowxt.client import WeChatClient
from bowxt.models import ChatType,Direction,MessageType

target=json.loads(Path(sys.argv[1]).read_text())
client=WeChatClient(auto_connect=True,visual_direction=True)
try:
    if target.get('probe_kind')=='outgoing':
        text=target['target_text']
    else:
        visible=client.get_visible_messages(target['chat'],chat_type=ChatType.GROUP,enrich_senders=False)
        candidates=[m for m in visible if m.bounds and m.type is MessageType.TEXT
            and m.direction is Direction.INCOMING and 12<=len(m.content)<=200]
        if not candidates:raise RuntimeError('No suitable visible incoming message for a non-sending probe')
        text=candidates[-1].content
    ok=client.send_native_quote(target['chat'],text,'probe-only',probe_only=True,
        target_is_own=target.get('probe_kind')=='outgoing')
    print(json.dumps({'probe':'ok' if ok else 'failed','sent':False}))
except Exception as exc:
    print(json.dumps({'probe':'failed','error_type':type(exc).__name__,'reason':str(exc)[:200],'sent':False}))
    raise
finally:
    client.disconnect()
