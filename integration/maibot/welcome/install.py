"""Install only reviewed queue/binding hooks. Digests gate unknown baselines."""
from pathlib import Path
import ast,hashlib,json,sys

root=Path(sys.argv[1]);baseline=json.loads(Path(sys.argv[2]).read_text())
edits={
 'policy.py':[
  ('import latency\n','import latency\nimport newcomer_welcome as welcome\n'),
  ('            latency.init(db)','            latency.init(db)\n            welcome.init(db)'),
  ("            # A pure nudge carries no new task.","            welcome_result=welcome.ingest(self,db,sender,display,text,chat_id,now,timestamp,bool(at_me or NAME.search(text)),candidate(text)=='question')\n            if welcome_result is not None:return welcome_result\n            # A pure nudge carries no new task."),
  ("        if row['fast']:\n", "        if row['welcome_due']:return now<row['welcome_due']\n        if row['fast']:\n"),
  ("            for row in candidates:\n", "            for row in candidates:\n                if welcome.expired(row,now):\n                    db.execute('DELETE FROM pending WHERE id=?',(row['id'],));self.count(db,'welcome_expired');continue\n"),
  ("                expires=latency.deadline(self,row,now)","                expires=latency.deadline(self,row,now)\n                if row['welcome_due']:expires=min(expires,row['welcome_expires'])"),
  ("                db.execute('DELETE FROM pending WHERE id=?',(row['id'],))\n                recent=", "                db.execute('UPDATE turns SET welcome_due=?,welcome_expires=? WHERE id=?',(row['welcome_due'],row['welcome_expires'],row['id']))\n                db.execute('DELETE FROM pending WHERE id=?',(row['id'],))\n                recent="),
 ],
 'group_guard.py':[
  ("            import latency\n            latency.bind(p,request,turn['id'],task)","            import latency\n            latency.bind(p,request,turn['id'],task)\n            import newcomer_welcome\n            newcomer_welcome.bind(p,request,turn,task)"),
 ]}
staged={}
for name,replacements in edits.items():
 path=root/name;source=path.read_text()
 if all(after in source for _,after in replacements):ast.parse(source);continue
 if hashlib.sha256(path.read_bytes()).hexdigest()!=baseline[name]:raise ValueError('Changed baseline: '+name)
 for before,after in replacements:
  if source.count(before)!=1:raise ValueError('Unknown hook in '+name+': '+before)
  source=source.replace(before,after,1)
 ast.parse(source);staged[path]=source
for path,source in staged.items():path.write_text(source)
