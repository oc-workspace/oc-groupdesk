import asyncio,copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from policy import Policy,Denied,settings
import reply_frequency as f
import groupdesk_runtime as gd
from test_reply_limits import bundle

class Validation(unittest.TestCase):
 def test_strict_bounds_and_unique_windows(self):
  self.assertEqual(f.validate(copy.deepcopy(f.DEFAULTS)),f.DEFAULTS)
  for change in [{'windows':[]},{'windows':[{'minutes':0,'max_replies':6}]},{'windows':[{'minutes':True,'max_replies':6}]},{'windows':[{'minutes':5,'max_replies':6}]*2},{'catch_up':{'enabled':1,'within_minutes':10}},{'catch_up':{'enabled':True,'within_minutes':61}},{'extra':1}]:
   with self.subTest(change=change),self.assertRaises(ValueError):f.validate({**copy.deepcopy(f.DEFAULTS),**change})
 def test_contract_and_mixed_revision_fail_closed(self):
  b=bundle();f.validate_bundle(b);b['reply_frequency']={'revision':1,'policy':copy.deepcopy(f.DEFAULTS)}
  with self.assertRaises(ValueError):f.validate_bundle(b)
  b['reply_frequency_contract_version']=1;f.validate_bundle(b)
  other=copy.deepcopy(b);other['reply_frequency']['revision']=2
  with self.assertRaises(ValueError):f.for_config({'managed_groups':{'1':b,'2':other}})
 def test_sync_ack_has_applied_revision(self):
  with tempfile.TemporaryDirectory() as d:
   c=Path(d)/'connection.json';s=Path(d)/'snapshot.json';c.write_text(json.dumps({'groups':{'1':'synthetic-room'}}));b=bundle();b.update(policy_contract_version=1,reply_frequency_contract_version=1,reply_frequency={'revision':7,'policy':copy.deepcopy(f.DEFAULTS)});calls=[]
   def api(path,body=None):calls.append((path,body));return b if path.startswith('/config/') else {'ok':True}
   with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',s),patch.object(gd,'api',side_effect=api):self.assertTrue(gd.sync()['1']['enabled'])
   ack=next(v for k,v in calls if k=='/ack');self.assertEqual(ack['reply_frequency_version'],1);self.assertEqual(ack['reply_frequency_revision'],7)

class Execution(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1793430000.;self.start=self.now;self.seq=100
  self.cfg=settings();self.cfg['managed_groups']={}
  for chat in ['1','2']:
   b=bundle(self.now);b['valid_until']=self.now+100000;b['policy']['base_questions']=True;b['reply_frequency_contract_version']=1;b['reply_frequency']={'revision':1,'policy':{'windows':[{'minutes':1,'max_replies':1}],'catch_up':{'enabled':True,'within_minutes':10}}};self.cfg['managed_groups'][chat]=b
  self.p=Policy(self.tmp.name,self.cfg,lambda:self.now)
 def ingest(self,text='小T，请解释这个问题',chat='1',sender='Alice'):
  self.seq+=1;return self.p.ingest(self.seq,sender,text,self.now,chat_id=chat)
 def fill(self,chat='2',sends=False):
  with self.p.db() as db:
   db.execute('INSERT INTO turns(id,sender,kind,created,expires,status,article,explicit,chat_id,received_at) VALUES(?,?,?,?,?,"sent",0,1,?,?)',('previous','other','direct',self.now,self.now+1,chat,self.now))
   if sends:db.execute('INSERT INTO sends VALUES("previous-send","previous",?,?,"direct","sent")',(self.now,self.p.day(self.now)))
 def waiting(self):
  with self.p.db() as db:return [dict(r) for r in db.execute('SELECT * FROM frequency_waiting')]
 def test_global_window_counts_other_groups(self):
  self.fill();self.assertEqual(self.ingest(),'frequency_waiting');self.assertEqual(len(self.waiting()),1)
  with self.p.db() as db:self.assertEqual(self.p._quota(db,'direct',self.now,explicit=True,chat_id='1'),'reply_window')
 def test_deferred_survives_restart_and_dispatches_once_after_capacity(self):
  self.fill();self.assertEqual(self.ingest(),'frequency_waiting');seq=self.seq
  self.assertIsNone(self.p.dispatch());self.p=Policy(self.tmp.name,self.cfg,lambda:self.now);self.now+=61
  turn=self.p.dispatch();self.assertIsNotNone(turn);self.assertEqual(turn['text'],'小T，请解释这个问题');self.assertEqual(turn['expires'],self.start+600)
  self.assertEqual(self.p.ingest(seq,'Alice','小T，请解释这个问题',self.start,chat_id='1'),'duplicate')
  self.assertEqual(self.waiting()[0]['turn_id'],turn['id']);self.assertIsNone(self.p.dispatch())
 def test_ten_minute_expiry_never_resets_from_retry(self):
  self.fill();self.ingest();self.now+=601;self.assertIsNone(self.p.dispatch());self.assertEqual(self.waiting()[0]['status'],'expired')
 def test_off_switch_drops_instead_of_defer(self):
  for b in self.cfg['managed_groups'].values():b['reply_frequency']['policy']['catch_up']['enabled']=False
  self.fill();self.assertEqual(self.ingest(),'reply_window');self.assertFalse(self.waiting())
 def test_switch_off_cancels_existing_wait_and_does_not_resurrect(self):
  self.fill();self.ingest()
  for b in self.cfg['managed_groups'].values():b['reply_frequency']['policy']['catch_up']['enabled']=False
  self.now+=61;self.assertIsNone(self.p.dispatch());self.assertEqual(self.waiting()[0]['status'],'cancelled')
  for b in self.cfg['managed_groups'].values():b['reply_frequency']['policy']['catch_up']['enabled']=True
  self.assertIsNone(self.p.dispatch())
 def test_shortening_ttl_expires_existing_wait(self):
  self.fill();self.ingest()
  for b in self.cfg['managed_groups'].values():b['reply_frequency']['policy']['catch_up']['within_minutes']=1
  self.now+=61;self.assertIsNone(self.p.dispatch());self.assertEqual(self.waiting()[0]['status'],'expired')
 def test_passive_topics_are_not_deferred(self):
  self.fill();self.assertEqual(self.ingest('怎么解决这个问题？'),'reply_window');self.assertFalse(self.waiting())
 def test_confirmed_followup_without_alias_is_deferred(self):
  self.assertEqual(self.ingest(),'queued');self.now+=4;turn=self.p.dispatch();self.p.reserve_send('s',turn['id']);self.p.finish_send('s','sent')
  self.now+=31;self.assertEqual(self.ingest('请继续展开说说'),'frequency_waiting');self.assertFalse(self.waiting()[0]['explicit']);self.now+=31;self.assertIsNotNone(self.p.dispatch())
 def test_window_release_still_respects_daily_cap(self):
  self.cfg['daily_replies']=1;self.fill();self.ingest();self.now+=61;self.assertIsNone(self.p.dispatch())
  with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone()[0],0)
 def test_group_revision_change_cancels_wait(self):
  self.fill();self.ingest();self.cfg['managed_groups']['1']['revision']=2;self.now+=61;self.assertIsNone(self.p.dispatch());self.assertEqual(self.waiting()[0]['status'],'cancelled')
 def test_regular_pending_that_later_hits_limit_uses_same_total_deadline(self):
  self.assertEqual(self.ingest(),'queued');self.fill();self.now+=4;self.assertIsNone(self.p.dispatch());self.now+=57;turn=self.p.dispatch();self.assertIsNotNone(turn);self.assertEqual(turn['expires'],self.start+600)
 def test_no_model_call_while_waiting_and_unambiguous_group(self):
  self.fill();self.ingest();self.now+=20;self.assertIsNone(self.p.dispatch())
  with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone()[0],0)
  self.now+=41;turn=self.p.dispatch();self.assertEqual(turn['chat_id'],'1')
  with self.assertRaises(Denied):self.p.reserve_send('wrong',turn['id'],chat_id='2')
 def test_pending_wait_is_excluded_from_offline_recovery_duplicates(self):
  import recovery
  self.fill();self.ingest()
  result=recovery.reconcile(self.p,'incident',self.now,[],['1','2']);self.assertEqual(result['queued'],0)
 def test_multiple_messages_do_not_extend_first_deadline(self):
  self.fill();self.ingest();self.now+=20;self.ingest('小T，还有一个问题');rows=self.waiting();self.assertEqual(rows[0]['expires'],self.start+600);self.assertEqual(rows[1]['expires'],self.start+620)
 def test_reminders_keep_original_deadline_and_only_one_task(self):
  self.fill();self.ingest();self.now+=20;self.ingest('小T，还在吗？');rows=self.waiting();self.assertEqual(rows[1]['status'],'coalesced');self.assertEqual(rows[1]['expires'],self.start+600)
  self.now+=41;turn=self.p.dispatch();self.assertIsNotNone(turn);self.assertEqual(len({r['turn_id'] for r in self.waiting()}),1)
 def test_submission_after_absolute_deadline_is_rejected(self):
  self.fill();self.ingest();self.now+=61;turn=self.p.dispatch();self.now=self.start+600
  with self.assertRaises(Denied):f.check_submission(self.p,turn['id'])
 def test_post_generation_send_wait_does_not_call_model_or_duplicate_send(self):
  self.assertEqual(self.ingest(),'queued');self.now+=4;turn=self.p.dispatch()
  with self.p.db() as db:db.execute('INSERT INTO sends VALUES("other-send","other-turn",?,?,"direct","sent")',(self.now,self.p.day(self.now)))
  async def sleeper(seconds):self.now+=seconds
  asyncio.run(f.reserve_when_ready(self.p,'new-send',turn['id'],'1',sleeper=sleeper))
  self.assertGreaterEqual(self.now,self.start+64)
  with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM sends WHERE id="new-send"').fetchone()[0],1);self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone()[0],0)
  with self.assertRaises(Denied):self.p.reserve_send('new-send',turn['id'])
 def test_send_wait_is_cancelled_if_sending_disabled(self):
  self.assertEqual(self.ingest(),'queued');self.now+=4;turn=self.p.dispatch()
  with self.assertRaises(Denied):asyncio.run(f.reserve_when_ready(self.p,'no-send',turn['id'],'1',enabled=lambda:False))

if __name__=='__main__':unittest.main()
