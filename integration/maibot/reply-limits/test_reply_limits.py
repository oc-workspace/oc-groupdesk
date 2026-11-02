import copy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from policy import Policy,settings
from reply_limits import DEFAULTS,validate,validate_bundle,for_group
import groupdesk_runtime as gd
def bundle(now=1793430000.):
 return {'id':'synthetic-group','external_id':'synthetic-room','revision':1,'enabled':True,'valid_until':now+100000,'interaction':'topic','topics':[],'policy':{'topic_scope':'proactive','participation':'active','persona':'gt-persona','base_questions':False,'base_social':False,'language':{'mode':'follow','allowed':[],'fallback':'zh-CN','allow_requested':True}}}

class ValidationTests(unittest.TestCase):
 def test_bounds_types_and_unknown_fields_are_rejected(self):
  self.assertEqual(validate(DEFAULTS),DEFAULTS)
  for changes in [{'max_rounds':0},{'max_rounds':21},{'max_rounds':True},{'reset_seconds':29},{'followup_seconds':1801},{'enabled':1},{'extra':1}]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):validate({**DEFAULTS,**changes})
 def test_new_fields_require_matching_contract_while_old_backends_remain_compatible(self):
  p=bundle();validate_bundle(p);p['policy']['conversation']={'reply_limits':dict(DEFAULTS)}
  with self.assertRaises(ValueError):validate_bundle(p)
  p['reply_limits_contract_version']=1;validate_bundle(p);p['reply_limits_contract_version']=2
  with self.assertRaises(ValueError):validate_bundle(p)
 def test_unmanaged_defaults_keep_existing_native_configuration(self):
  self.assertEqual(for_group({'conversation_rounds':5,'conversation_reset_seconds':240,'followup_seconds':360},'x')['max_rounds'],5)

 def test_sync_acknowledges_the_applied_reply_limits_capability(self):
  import json
  with tempfile.TemporaryDirectory() as d:
   connection=Path(d)/'connection.json';snapshot=Path(d)/'snapshot.json';connection.write_text(json.dumps({'url':'https://example.invalid','token':'synthetic-token-only','groups':{'1':'synthetic-room'}}))
   p=bundle();p.update(policy_contract_version=1,reply_limits_contract_version=1);p['policy']['conversation']={'enabled':False,'banter_replies':False,'frequency':'low','instructions':'','reply_limits':dict(DEFAULTS)};calls=[]
   def api(path,body=None):
    calls.append((path,body));return p if path.startswith('/config/') else {'ok':True}
   with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=api):result=gd.sync()
   self.assertTrue(result['1']['enabled']);self.assertEqual(next(body for path,body in calls if path=='/ack')['reply_limits_version'],1);self.assertNotIn('synthetic-token-only',snapshot.read_text())

class GroupExecutionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1793430000.;self.cfg=settings();self.cfg['managed_groups']={}
  for chat,max_rounds in [('1',2),('26992',4)]:
   p=bundle(self.now);p['valid_until']=self.now+100000;p['reply_limits_contract_version']=1;p['policy']['conversation']={'enabled':False,'banter_replies':False,'frequency':'low','instructions':'','reply_limits':{**DEFAULTS,'max_rounds':max_rounds}};self.cfg['managed_groups'][chat]=p
  self.p=Policy(self.tmp.name,self.cfg,lambda:self.now);self.seq=0
 def limits(self,chat):return self.cfg['managed_groups'][chat]['policy']['conversation']['reply_limits']
 def ingest(self,text='小T，请接话',chat='26992',sender='Alice'):
  self.seq+=1;return self.p.ingest(self.seq,sender,text,chat_id=chat)
 def send(self,chat='26992',text='小T，请接话'):
  self.assertEqual(self.ingest(text,chat),'queued');self.now+=5;turn=self.p.dispatch();self.assertIsNotNone(turn);sid='send-'+turn['id'];self.p.reserve_send(sid,turn['id']);self.p.finish_send(sid,'sent');return turn
 def test_shanghai_can_continue_four_rounds_while_other_group_stays_at_two(self):
  self.send()
  for _ in range(3):self.now+=31;self.send(text='请继续说下去')
  self.now+=31;self.assertEqual(self.ingest('再接着说下去'),'conversation_rounds')
  with self.p.db() as db:db.execute('INSERT OR REPLACE INTO group_conversation VALUES(?,?,?)',('1',self.now,2))
  with self.p.db() as db:self.assertEqual(self.p._quota(db,'direct',self.now,chat_id='1'),'conversation_rounds')
 def test_explicit_mention_still_reopens_the_conversation(self):
  with self.p.db() as db:db.execute('INSERT OR REPLACE INTO group_conversation VALUES(?,?,?)',('26992',self.now,4))
  self.assertEqual(self.ingest('We expect response within one second in the future.'),'filtered')
  self.send(text='小T，说说话')
  with self.p.db() as db:self.assertEqual(self.p.conversation_for(db,'26992')['rounds'],1)
 def test_each_group_uses_its_own_reset_gap(self):
  self.limits('1')['reset_seconds']=30;self.limits('26992')['reset_seconds']=300
  with self.p.db() as db:
   for chat in ['1','26992']:db.execute('INSERT OR REPLACE INTO group_conversation VALUES(?,?,?)',(chat,self.now-40,4))
   self.assertIsNone(self.p._quota(db,'direct',self.now,chat_id='1'))
   self.assertEqual(self.p._quota(db,'direct',self.now,chat_id='26992'),'conversation_rounds')
 def test_followup_window_is_independent_and_group_scoped(self):
  self.limits('1')['followup_seconds']=30;self.send(chat='1');self.now+=41;self.assertEqual(self.ingest('继续','1'),'filtered')
  self.limits('26992')['followup_seconds']=300;self.send(chat='26992');self.now+=41;self.assertEqual(self.ingest('继续','26992'),'queued')
 def test_disabling_round_cap_keeps_global_send_limits(self):
  self.limits('26992')['enabled']=False
  with self.p.db() as db:
   db.execute('INSERT OR REPLACE INTO group_conversation VALUES(?,?,?)',('26992',self.now,99));self.assertIsNone(self.p._quota(db,'direct',self.now,chat_id='26992'))
  self.send();self.cfg['reply_limits']=[(300,1)]
  with self.p.db() as db:self.assertEqual(self.p._quota(db,'direct',self.now,chat_id='26992'),'reply_window')
 def test_count_at_send_boundary_uses_this_groups_reset_gap(self):
  self.limits('26992')['reset_seconds']=30;self.send();self.now+=41;self.send(text='继续展开说说')
  with self.p.db() as db:self.assertEqual(self.p.conversation_for(db,'26992')['rounds'],1)

if __name__=='__main__':unittest.main()
