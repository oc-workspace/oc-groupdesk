import json,sqlite3,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import patch
from contextlib import contextmanager
import bot_runtime as r

BOT='00000000-0000-4000-8000-000000000001';INSTANCE='11111111-1111-4111-8111-111111111111'
class LifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.conf={'bot_id':BOT,'wechat_id':'RyuBuddy','runtime_instance_id':INSTANCE,'account_fingerprint':'a'*64,'groups':{'1':'own-group'}}
  self.connection=self.root/'connection.json';self.connection.write_text(json.dumps(self.conf));self.snapshot=self.root/'snapshot.json'
  self.control=self.root/'control.json';self.original=json.dumps({'enabled':True,'send_enabled':True})+'\n';self.control.write_text(self.original)
  self.path=self.root/'state.db'
  with self.db() as c:c.executescript('CREATE TABLE turns(status TEXT,expires REAL);CREATE TABLE outbound(state TEXT,seq INTEGER);CREATE TABLE pending(id TEXT);')
  self.calls=[];self.events=[];self.status={'wechat_connected':True,'queue_depth':0};self.sender_state='sent';self.locked=False
  self.state={'contract':1,'bot_id':BOT,'wechat_id':'RyuBuddy','state':'active','revision':1,'activation_generation':0,'enabled':True}
  self.bridge=N(state_dir=self.root,health={},send_lock=N(locked=lambda:self.locked),router=N(check_connection=lambda p:p=='wechat_linux'),ledger=N(connect=self.db),policy=N(db=self.db))
  self.bridge.agent=N(status=lambda:self.status,get_message=lambda seq:N(delivery_status=self.sender_state),source_status={'connected':True,'checked_at':time.time()},reset_live_cursors=lambda ids:self.events.append(('reset',ids)),request=self.request)
  self.patches=[patch.object(r.gd,'CONNECTION',self.connection),patch.object(r.gd,'SNAPSHOT',self.snapshot),patch.object(r.gd,'api',side_effect=self.api),patch.object(r.gd,'sync',side_effect=lambda:self.events.append(('sync',None)) or {})]
  for p in self.patches:p.start();self.addCleanup(p.stop)
 @contextmanager
 def db(self):
  c=sqlite3.connect(self.path)
  try:
   with c:yield c
  finally:c.close()
 def api(self,path,body=None):
  self.calls.append((path,body));return self.state if path=='/bot-state' else {'ok':True}
 def request(self,path,query):
  self.assertEqual(path,'/v1/status');self.assertEqual(query,{});return {'ok':True}
 def heartbeat(self):return [body for path,body in self.calls if path=='/bot-heartbeat'][-1]
 def pause(self):self.state.update(state='pausing',enabled=False,revision=2)
 def test_first_legacy_activation_preserves_cursors_controls_and_does_not_send(self):
  r.sync(self.bridge);self.assertEqual(self.control.read_text(),self.original);self.assertNotIn(('reset',[1]),self.events);self.assertFalse(self.heartbeat()['stopped']);self.assertTrue(self.heartbeat()['local_ready'])
 def test_pause_disables_profiles_and_local_controls_and_reports_actual_stopped_state(self):
  self.pause();r.sync(self.bridge)
  self.assertFalse(json.loads(self.control.read_text())['enabled']);self.assertFalse(json.loads(self.snapshot.read_text())['groups']['1']['enabled']);self.assertTrue(self.heartbeat()['stopped']);self.assertTrue(self.heartbeat()['local_ready']);self.assertEqual(self.events,[])
 def test_inflight_model_send_lock_pending_ui_or_unknown_reservation_prevent_ack(self):
  self.pause()
  for kind in ['lock','turn','queue','reservation','pending_ui']:
   with self.subTest(kind=kind):
    with self.db() as c:c.execute('DELETE FROM turns');c.execute('DELETE FROM outbound')
    self.locked=kind=='lock';self.status['queue_depth']=1 if kind=='queue' else 0
    with self.db() as c:
     if kind=='turn':c.execute('INSERT INTO turns VALUES("active",?)',(time.time()+30,))
     if kind=='reservation':c.execute('INSERT INTO outbound VALUES("reserved",NULL)')
     if kind=='pending_ui':c.execute('INSERT INTO outbound VALUES("pending",1)')
    self.sender_state='pending';r.sync(self.bridge);self.assertFalse(self.heartbeat()['stopped'])
 def test_completed_unverified_ui_action_does_not_authorize_resend_or_hold_pause_forever(self):
  self.pause()
  with self.db() as c:c.execute('INSERT INTO outbound VALUES("unverified",1)')
  self.bridge.agent.get_message=lambda seq:self.fail('Completed UI action does not need requery')
  r.sync(self.bridge);self.assertTrue(self.heartbeat()['stopped'])
 def test_resume_skips_old_pending_once_and_preserves_private_ledgers(self):
  self.pause();r.sync(self.bridge)
  with self.db() as c:c.execute('INSERT INTO pending VALUES("old")');c.execute('INSERT INTO outbound VALUES("sent",1)')
  self.state.update(state='active',enabled=True,revision=4,activation_generation=1);r.sync(self.bridge)
  self.assertEqual(self.control.read_text(),self.original);self.assertEqual(self.events[:2],[('reset',[1]),('sync',None)])
  with self.db() as c:self.assertEqual(c.execute('SELECT count(*) FROM pending').fetchone()[0],0);self.assertEqual(c.execute('SELECT count(*) FROM outbound').fetchone()[0],1)
  r.sync(self.bridge);self.assertEqual(self.events.count(('reset',[1])),1)
 def test_identity_mismatch_fails_closed_without_loading_other_profile(self):
  self.state['bot_id']='22222222-2222-4222-8222-222222222222'
  with self.assertRaises(ValueError):r.sync(self.bridge)
  self.assertFalse(json.loads(self.snapshot.read_text())['groups']['1']['enabled']);self.assertFalse(self.events)
 def test_operator_local_pause_is_preserved_and_not_declared_ready(self):
  self.control.write_text(json.dumps({'enabled':False,'send_enabled':False}));self.pause();r.sync(self.bridge);self.assertFalse(self.heartbeat()['local_ready'])
 def test_changed_operator_controls_are_never_silently_restored(self):
  self.pause();r.sync(self.bridge);self.control.write_text(json.dumps({'enabled':True,'send_enabled':False}));self.state.update(state='active',enabled=True,activation_generation=1)
  with self.assertRaises(RuntimeError):r.sync(self.bridge)
  self.assertFalse(json.loads(self.control.read_text())['send_enabled']);self.assertFalse(self.events)
 def test_missing_sender_queue_status_never_confirms_stopped(self):
  self.pause();self.status.pop('queue_depth')
  with self.assertRaises(RuntimeError):r.sync(self.bridge)
  self.assertFalse(any(path=='/bot-heartbeat' for path,_ in self.calls))
if __name__=='__main__':unittest.main()
