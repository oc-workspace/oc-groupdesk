"""Add the summary loop to the reviewed bridge baseline; idempotent and fail closed."""
from pathlib import Path
import ast,hashlib,sys
p=Path(sys.argv[1]);s=p.read_text()
before='from bowxt import AgentClient, ChatType'
after='from summary_runtime import run as run_summaries\n\n'+before
anchor='self.groupdesk_loop(), run_interactions(self))'
replacement='self.groupdesk_loop(), run_interactions(self), run_summaries(self))'
if after not in s or replacement not in s:
    if hashlib.sha256(p.read_bytes()).hexdigest()!=sys.argv[2]:raise ValueError('Bridge baseline changed')
    if s.count(before)!=1 or s.count(anchor)!=1:raise ValueError('Unknown bridge hook')
    s=s.replace(before,after,1).replace(anchor,replacement,1)
ast.parse(s);p.write_text(s)
