"""Install the sole new admission hook against a reviewed source digest."""
from pathlib import Path
import ast,hashlib,sys
p=Path(sys.argv[1]);s=p.read_text()
before="            eligible='topic' if topics else generic"
after=before+"\n            if not eligible and managed is not None and gd.banter_candidate(db,managed,chat_id,seq,text,now,topics):eligible='banter'"
if after not in s:
    if len(sys.argv)<3 or hashlib.sha256(s.encode()).hexdigest()!=sys.argv[2]:raise ValueError('Policy baseline changed')
    if s.count(before)!=1:raise ValueError('Unknown admission anchor')
    s=s.replace(before,after,1)
ast.parse(s);p.write_text(s)
