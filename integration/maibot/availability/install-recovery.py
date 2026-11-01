"""Narrow, idempotent source hooks; reject an unexpected runtime baseline."""
from pathlib import Path
import sys

root=Path(sys.argv[1])
edits={
 'limits/policy.py':[
  ('            gd.init_db(db)','            gd.init_db(db)\n            import recovery\n            recovery.init(db)'),
  ('    def ingest(self, seq, sender, text, timestamp=None, at_me=False,chat_id=\'\'):',
   '''    def ingest(self, seq, sender, text, timestamp=None, at_me=False,chat_id=''):
        result=self._ingest(seq,sender,text,timestamp,at_me,chat_id)
        import recovery
        recovery.track(self,seq,sender,text,timestamp,at_me,chat_id,result)
        return result

    def _ingest(self, seq, sender, text, timestamp=None, at_me=False,chat_id=''):'''),
 ],
 'bridge/app.py':[
  ('                for delivery in deliveries:',
   '''                import recovery
                recovery.transport(self.policy,True)
                for delivery in deliveries:'''),
  ("                LOG.error('Inbound waiting: %s', type(exc).__name__)",
   '''                if self.chats and self.control()['enabled']:
                    import recovery
                    recovery.transport(self.policy,False)
                LOG.error('Inbound waiting: %s', type(exc).__name__)'''),
  ('                    turn = self.policy.dispatch()',
   '''                    if self.control()['send_enabled']:
                        import recovery
                        recovery.pump(self.policy)
                    turn = self.policy.dispatch()'''),
 ],
 'limits/group_guard.py':[
  ('        request.max_tokens=min(request.max_tokens or maximum,maximum)',
   '''        if task in {'planner','replyer'}:
            import recovery
            recovery.bind(p,request,turn['id'])
        request.max_tokens=min(request.max_tokens or maximum,maximum)'''),
 ]}
for name,replacements in edits.items():
 path=root/name;source=path.read_text()
 for before,after in replacements:
  if after in source:continue
  if source.count(before)!=1:raise ValueError('Unexpected recovery hook baseline: '+name)
  source=source.replace(before,after,1)
 compile(source,str(path),'exec')
 path.write_text(source)
