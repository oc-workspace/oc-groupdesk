"""Idempotently install the request-local Planner timeout on the reviewed native source."""
from pathlib import Path
import ast,hashlib,sys
path=Path(sys.argv[1]);source=path.read_text()
before='        timeout_s = self.model_for_task.hard_timeout'
after='        from timeout_policy import task_timeout\n        timeout_s = task_timeout(self.task_name, self.model_for_task.hard_timeout)'
if after not in source:
    if source.count(before)!=1:raise ValueError('Unexpected native task-timeout baseline')
    # Verify the caller stages exactly the audited source file.
    if len(sys.argv)>2 and hashlib.sha256(source.encode()).hexdigest()!=sys.argv[2]:raise ValueError('Native source digest mismatch')
    source=source.replace(before,after,1)
ast.parse(source.lstrip('\ufeff'));path.write_text(source)
