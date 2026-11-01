import tempfile,unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import recovery
from policy import Policy,settings

class RecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.now=1793490000.;self.cfg=settings();self.p=Policy(self.temp.name,self.cfg,lambda:self.now)
 def original(self,seq=1,text='小T，解释一下 swap？',sender='Alice',chat='1'):
  return self.p.ingest(seq,sender,text,self.now,True,chat)
 def scan(self,incident='incident',rows=(),allowed=('1',)):
  return recovery.reconcile(self.p,incident,self.now,rows,allowed)
 def expire(self):
  self.now+=self.cfg.get('direct_turn_ttl_seconds',self.cfg['turn_ttl_seconds'])+1;self.p.dispatch()
 def count(self,table):
  with self.p.db() as db:return db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
 def test_no_mentions_no_task_and_no_model_or_send(self):
  self.p.ingest(1,'Alice','ordinary talk',self.now,False,'1')
  self.assertEqual(self.scan()['queued'],0);self.assertFalse(recovery.pump(self.p))
  self.assertEqual(self.count('attempts')+self.count('sends')+self.count('pending'),0)
 def test_expired_mention_becomes_a_labelled_new_task(self):
  self.original();self.expire();self.assertEqual(self.scan()['queued'],1)
  self.assertTrue(recovery.pump(self.p));self.now+=5;turn=self.p.dispatch()
  self.assertIn('恢复后补答',recovery.instructions(self.p,turn['id']))
  self.assertEqual(turn['chat_id'],'1');self.assertEqual(turn['text'],'小T，解释一下 swap？')
 def test_successful_reply_is_not_replayed(self):
  self.original();self.now+=5;turn=self.p.dispatch()
  self.p.reserve_send('sent1',turn['id'],'1');self.p.finish_send('sent1','sent')
  self.assertEqual(self.scan()['queued'],0)
 def test_uncertain_delivery_requires_review(self):
  self.original();self.now+=5;turn=self.p.dispatch()
  self.p.reserve_send('uncertain1',turn['id'],'1');self.p.finish_send('uncertain1','uncertain')
  result=self.scan();self.assertEqual(result['queued'],0);self.assertEqual(result['uncertain'],1)
 def test_repeat_scan_does_not_duplicate_batches(self):
  self.original();self.expire();self.scan();self.assertTrue(self.scan()['repeat']);self.assertEqual(self.count('recovery_batches'),1)
 def test_twelve_hour_window_is_anchored_at_recovery(self):
  self.original();self.now+=12*3600+1;self.p.dispatch();self.assertEqual(self.scan()['queued'],0)
 def test_group_allowlist_is_enforced(self):
  self.original(chat='2');self.expire();self.assertEqual(self.scan()['queued'],0)
 def test_same_sender_is_bundled_and_other_sender_separate(self):
  self.original();self.now+=1;self.original(2,'小T，还有什么限制？')
  self.original(3,'小T，为什么掉线？','Bob');self.expire()
  self.assertEqual(self.scan()['queued'],2);self.assertEqual(self.count('recovery_sources'),3)
 def test_original_still_running_is_not_double_answered(self):
  self.original();self.now+=5;turn=self.p.dispatch();self.scan()
  self.assertFalse(recovery.pump(self.p))
  self.p.reserve_send('real',turn['id'],'1');self.p.finish_send('real','sent');self.now+=31
  self.assertFalse(recovery.pump(self.p));self.assertEqual(self.count('sends'),1)
 def test_source_time_survives_duplicate_ingestion(self):
  self.original();at=self.now;self.now+=100;self.original()
  with self.p.db() as db:self.assertEqual(db.execute('SELECT source_at FROM recovery_sources').fetchone()[0],at)
 def test_untracked_history_does_not_guess_whether_answered(self):
  result=self.scan(rows=[dict(seq=12,chat_id='1',sender='Alice',content='小T hello',direction='incoming',message_type='text',source_at=self.now)])
  self.assertEqual(result['untracked'],1);self.assertEqual(result['queued'],0)
 def test_global_budget_is_not_bypassed(self):
  self.original();self.expire();self.scan();self.cfg['daily_tokens']=0
  self.assertFalse(recovery.pump(self.p));self.assertEqual(self.count('pending'),0)
 def test_failed_recovery_task_is_not_retried_in_a_loop(self):
  self.original();self.expire();self.scan();recovery.pump(self.p);self.now+=5;turn=self.p.dispatch();self.p.fail_turn(turn['id'])
  self.assertFalse(recovery.pump(self.p))
  with self.p.db() as db:self.assertEqual(db.execute('SELECT status FROM recovery_batches').fetchone()[0],'review')
 def test_new_live_requests_take_priority(self):
  self.original();self.expire();self.scan();self.original(2,'小T，先回答这条','Bob')
  self.assertFalse(recovery.pump(self.p))
 def test_quota_blocked_jobs_wait_then_expire_instead_of_flooding(self):
  self.original();self.expire();self.scan();self.cfg['daily_replies']=0
  self.assertFalse(recovery.pump(self.p));self.now+=3601;self.assertFalse(recovery.pump(self.p))
  with self.p.db() as db:self.assertEqual(db.execute('SELECT status FROM recovery_batches').fetchone()[0],'expired')
if __name__=='__main__':unittest.main()
