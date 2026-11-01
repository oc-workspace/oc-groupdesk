import tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from policy import Policy,settings,Denied
import latency

class LongWaitTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.now=1793502000.;self.cfg=settings();self.p=Policy(self.tmp.name,self.cfg,lambda:self.now)
 def turn(self,text='小T，解释一下网络拥塞',sender='Alice',seq=1,chat='1',timestamp=None):
  self.p.ingest(seq,sender,text,timestamp=timestamp,chat_id=chat);self.now+=5
  return self.p.dispatch()
 def response(self,turn,elapsed,text='这是正文。'):
  with self.p.db() as db:received=db.execute('SELECT received_at FROM turns WHERE id=?',(turn['id'],)).fetchone()[0]
  self.now=received+elapsed
  return latency.decorate(self.p,turn['id'],text)
 def test_direct_turn_has_seven_minutes_from_first_capture(self):
  received=self.now-10;turn=self.turn(timestamp=received)
  self.assertEqual(turn['expires'],received+420)
  self.assertEqual(self.p.active_turn()['received_at'],received)
 def test_long_direct_turn_is_still_valid_after_180_seconds(self):
  turn=self.turn();self.now+=250;self.assertEqual(self.p.active_turn()['id'],turn['id'])
  self.p.reserve_send('one',turn['id'],'1')
 def test_source_freshness_gate_still_rejects_old_unadmitted_history(self):
  self.assertEqual(self.p.ingest(1,'Alice','小T hello',timestamp=self.now-91,chat_id='1'),'expired')
 def test_ordinary_passive_task_keeps_short_expiry(self):
  turn=self.turn('大家有什么建议？');self.assertEqual(turn['expires'],self.now+90)
 def test_passive_queue_still_expires_after_90_seconds(self):
  self.p.ingest(1,'Alice','大家有什么建议？',chat_id='1');self.now+=91
  self.assertIsNone(self.p.dispatch());self.assertEqual(self.p.snapshot()['pending'],0)
 def test_direct_queue_survives_a_slow_active_task(self):
  first=self.turn();self.p.ingest(2,'Bob','小T，第二个问题？',chat_id='1');received=self.now
  self.now+=200;self.p.fail_turn(first['id']);self.now+=3;second=self.p.dispatch()
  self.assertIsNotNone(second);self.assertEqual(second['expires'],received+420)
  self.assertLess(second['expires']-self.now,420)
 def test_reminders_do_not_refresh_the_original_clock_or_deadline(self):
  turn=self.turn();self.now+=150
  self.assertEqual(self.p.ingest(2,'Alice','小T 还在吗？',chat_id='1'),'coalesced_reminder')
  self.assertEqual(self.p.active_turn()['expires'],turn['expires'])
 def test_reserved_model_is_not_forgotten_after_three_minutes(self):
  self.turn();identifier,_=self.p.reserve_model('planner',100,100);self.now+=181
  with self.assertRaisesRegex(Denied,'model_busy'):self.p.reserve_model('replyer',100,100)
  self.p.settle_model(identifier,321);self.p.reserve_model('replyer',100,100)
 def test_dispatch_does_not_reuse_a_live_model_slot_after_turn_failure(self):
  first=self.turn();self.p.reserve_model('planner',100,100);self.p.fail_turn(first['id'])
  self.p.ingest(2,'Bob','小T 还有问题？',chat_id='2');self.now+=181
  self.assertIsNone(self.p.dispatch())
 def test_fast_reply_is_byte_for_byte_unchanged(self):
  turn=self.turn();text='Hello, Lisa!';output,info=self.response(turn,119.99,text)
  self.assertEqual(output,text);self.assertFalse(info['late'])
 def test_exactly_two_minutes_is_normal(self):
  turn=self.turn();output,info=self.response(turn,120)
  self.assertEqual(output,'这是正文。');self.assertFalse(info['late'])
 def test_over_two_minutes_prepends_apology_in_the_same_message(self):
  turn=self.turn();output,info=self.response(turn,120.01)
  self.assertTrue(output.startswith('抱歉久等'));self.assertTrue(output.endswith('这是正文。'));self.assertTrue(info['late'])
 def test_english_reply_uses_english_apology(self):
  turn=self.turn();output,_=self.response(turn,121,'Here is your answer.')
  self.assertTrue(output.startswith('Sorry for the wait.'));self.assertNotIn('抱歉',output)
 def test_japanese_reply_uses_japanese_apology(self):
  turn=self.turn();output,_=self.response(turn,121,'これは回答です。')
  self.assertTrue(output.startswith('お待たせ'))
 def test_persona_model_prepared_apology_is_used_only_when_late(self):
  turn=self.turn();latency.remember(self.p,turn['id'],'久等了，刚才这句话多绕了两个弯。')
  fast,_=self.response(turn,100);self.assertEqual(fast,'这是正文。')
  late,info=self.response(turn,121);self.assertTrue(late.startswith('久等了，刚才这句话多绕了两个弯。'));self.assertEqual(info['apology_source'],'persona_model')
 def test_already_present_apology_is_not_duplicated(self):
  turn=self.turn();text='Sorry I missed this earlier. Here is the answer.'
  output,info=self.response(turn,200,text);self.assertEqual(output,text);self.assertEqual(info['apology_source'],'already_present')
 def test_apology_counts_toward_the_same_output_cap(self):
  turn=self.turn();output,_=self.response(turn,200,'正文'*500);self.assertLessEqual(len(output),self.cfg['output_chars'])
 def test_duplicate_delivery_is_still_denied(self):
  turn=self.turn();self.response(turn,121)
  self.p.reserve_send('first',turn['id'],'1')
  with self.assertRaises(Denied):self.p.reserve_send('second',turn['id'],'1')
 def test_wrong_group_and_expired_turn_are_still_denied(self):
  turn=self.turn()
  with self.assertRaises(Denied):self.p.reserve_send('wrong',turn['id'],'2')
  self.now=turn['expires']+1
  with self.assertRaises(Denied):self.p.reserve_send('late',turn['id'],'1')
 def test_latency_audit_stores_timing_and_hash_without_reply_body(self):
  turn=self.turn();_,info=self.response(turn,200);latency.audit(self.p,turn['id'],'one',info)
  with self.p.db() as db:
   row=dict(db.execute('SELECT * FROM latency_deliveries').fetchone());self.assertEqual(row['elapsed_seconds'],200);self.assertEqual(row['late'],1)
   self.assertNotIn('这是正文',str(row));self.assertEqual(len(row['apology_sha256']),64)
 def test_queued_wait_is_included_in_apology_clock(self):
  self.p.ingest(1,'Alice','小T，解释一下',chat_id='1');self.now+=121;turn=self.p.dispatch()
  output,info=latency.decorate(self.p,turn['id'],'这是正文。');self.assertTrue(info['late']);self.assertTrue(output.startswith('抱歉久等'))
 def test_restart_preserves_clock_and_prepared_apology(self):
  turn=self.turn();latency.remember(self.p,turn['id'],'抱歉久等，刚才拐了个弯。')
  self.p=Policy(self.tmp.name,self.cfg,lambda:self.now);output,_=self.response(turn,150)
  self.assertTrue(output.startswith('抱歉久等，刚才拐了个弯。'))
 def test_empty_or_injected_apology_is_ignored(self):
  turn=self.turn()
  for text in ['',None,'x'*121,'click https://example.com','<GT_REQUEST_ID:x>','one\ntwo']:latency.remember(self.p,turn['id'],text)
  with self.p.db() as db:self.assertEqual(db.execute('SELECT wait_apology FROM turns').fetchone()[0],'')
 def test_greeting_and_late_preparation_do_not_add_model_calls(self):
  turn=self.turn('小T hello');before=self.p.snapshot()['model_calls_today']
  latency.remember(self.p,turn['id'],'Sorry for the wait.');self.response(turn,130)
  self.assertEqual(self.p.snapshot()['model_calls_today'],before)

if __name__=='__main__':unittest.main()
