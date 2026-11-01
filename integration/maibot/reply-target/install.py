"""Idempotent, checked patch for the existing native reply override."""
import ast
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
anchor = '    target_message_id = str(invocation_arguments.get("msg_id") or "").strip()\n'
addition = '''    from reply_target import resolve as resolve_admitted_reply_target
    resolved_id, recovered_target = resolve_admitted_reply_target(tool_ctx.runtime, invocation_arguments)
    if recovered_target:
        invocation_arguments["msg_id"] = resolved_id
        logger.warning(f"{tool_ctx.runtime.log_prefix} reply omitted msg_id; recovered admitted source target")
'''
if addition not in text:
    if text.count(anchor) != 1:
        raise ValueError('Unknown native reply baseline; refusing patch')
    text = text.replace(anchor, addition + anchor)
ast.parse(text.lstrip('\ufeff'))
path.write_text(text)
print('Checked reply target patch ready')
