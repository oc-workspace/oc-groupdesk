"""Synthetic groups, controlled clocks, fake transports; never call a real model."""
import asyncio,copy,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
import timeout_policy as tp
import groupdesk_runtime as gd
from policy import Policy,settings
from test_groupdesk_runtime import bundle

SHORT={'planner_seconds':60,'request_seconds':70,'direct_ttl_seconds':180,'wait_apology_seconds':60}
LONG={'planner_seconds':450,'request_seconds':460,'direct_ttl_seconds':600,'wait_apology_seconds':300}

class TimeoutContractTests(unittest.TestCase):
 def test_apology_threshold_is_whole_minutes_and_v2_requires_the_field(self):
  for seconds in [60,120,300,1800]:self.assertEqual(tp.validate({**SHORT,'wait_apology_seconds':seconds},require_apology=True)['wait_apology_seconds'],seconds)
  for seconds in [0,30,61,1801,True,120.5]:
   with self.assertRaises(ValueError):tp.validate({**SHORT,'wait_apology_seconds':seconds})
  old={k:v for k,v in SHORT.items() if k!='wait_apology_seconds'}
  self.assertEqual(tp.validate(old)['wait_apology_seconds'],300)
  with self.assertRaises(ValueError):tp.validate(old,require_apology=True)
 def test_v2_bundle_does_not_silently_accept_a_missing_apology_threshold(self):
  b=bundle();b['timeout_policy_contract_version']=2;b['policy']['timeouts']={k:v for k,v in SHORT.items() if k!='wait_apology_seconds'}
  with self.assertRaises(ValueError):gd.validate_bundle(b,b['external_id'])
  b['timeout_policy_contract_version']=1;gd.validate_bundle(b,b['external_id'])
 def test_policy_bounds_and_relationships_are_strict(self):
  for value in [tp.DEFAULTS,SHORT,LONG,{'planner_seconds':30,'request_seconds':40,'direct_ttl_seconds':105},{'planner_seconds':600,'request_seconds':660,'direct_ttl_seconds':1800}]:
   self.assertEqual(tp.validate(value),{**tp.DEFAULTS,**value})
  for value in [{**SHORT,'planner_seconds':True},{**SHORT,'request_seconds':60},{**SHORT,'direct_ttl_seconds':120},{**SHORT,'planner_seconds':601},{**SHORT,'hidden':1},{'planner_seconds':60}]:
   with self.assertRaises(ValueError):tp.validate(value)
 def test_bundle_requires_valid_policy_before_it_can_be_confirmed(self):
  b=bundle();b['timeout_policy_contract_version']=1;b['policy']['timeouts']=SHORT
  gd.validate_bundle(b,b['external_id'])
  for value in [None,{**SHORT,'request_seconds':60}]:
   b['policy']['timeouts']=value
   with self.assertRaises(ValueError):gd.validate_bundle(b,b['external_id'])
  b['timeout_policy_contract_version']=3
  with self.assertRaises(ValueError):gd.validate_bundle(b,b['external_id'])
 def test_sync_ack_declares_applied_timeout_contract(self):
  b=bundle();b['timeout_policy_contract_version']=2;b['policy']['timeouts']=SHORT
  acks=[]
  def api(path,body=None):
   if path.startswith('/config/'):return b
   if path=='/ack':acks.append(body);return {'ok':True}
   raise AssertionError(path)
  with tempfile.TemporaryDirectory() as d:
   connection=Path(d)/'connection.json';connection.write_text(json.dumps({'url':'https://example.invalid','token':'isolated-test-token','groups':{'1':b['external_id']}}))
   with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',Path(d)/'snapshot.json'),patch.object(gd,'api',side_effect=api):gd.sync()
  self.assertEqual(acks[0]['timeout_policy_version'],2)

class GroupQueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1793502000.;self.cfg=settings()
  self.cfg['managed_groups']={}
  for chat,value in [('1',SHORT),('2',LONG)]:
   b=bundle(self.now);b['valid_until']=self.now+4000;b['policy']['timeouts']=copy.deepcopy(value)
   self.cfg['managed_groups'][chat]=b
  self.p=Policy(self.tmp.name,self.cfg,lambda:self.now)
 def enqueue(self,chat='1',seq=1,sender='Synthetic member'):
  return self.p.ingest(seq,sender,'小T，解释一下网络拥塞？',chat_id=chat,at_me=True)
 def test_each_group_uses_its_own_absolute_deadline(self):
  received=self.now;self.assertEqual(self.enqueue(),'queued');self.now+=5;turn=self.p.dispatch()
  self.assertEqual(turn['expires'],received+180)
  self.assertEqual(tp.for_group(self.cfg,'2'),LONG)
 def test_pending_expiration_is_per_group_and_includes_time_already_queued(self):
  received=self.now;self.assertEqual(self.enqueue(),'queued');self.assertEqual(self.enqueue('2',2,'Another member'),'queued')
  self.now+=181;turn=self.p.dispatch();self.assertEqual(turn['chat_id'],'2');self.assertEqual(turn['expires'],received+600)
  with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM pending').fetchone()[0],0)
 def test_followup_does_not_restart_the_group_clock(self):
  received=self.now;self.enqueue();self.now+=50;self.enqueue(seq=2);self.now+=5
  turn=self.p.dispatch();self.assertEqual(turn['expires'],received+180)
 def test_active_deadline_does_not_extend_when_group_settings_change(self):
  self.enqueue();self.now+=5;turn=self.p.dispatch()
  self.cfg['managed_groups']['1']['policy']['timeouts']=LONG
  self.assertEqual(self.p.active_turn()['expires'],turn['expires'])
 def test_changed_group_revision_cancels_pending_work(self):
  self.enqueue();self.cfg['managed_groups']['1']['revision']+=1;self.now+=5
  self.assertIsNone(self.p.dispatch());self.assertEqual(self.p.snapshot()['pending'],0)
 def test_legacy_group_retains_existing_global_deadline(self):
  del self.cfg['managed_groups']['1']['policy']['timeouts']
  self.cfg['direct_turn_ttl_seconds']=420
  received=self.now;self.enqueue();self.now+=5
  self.assertEqual(self.p.dispatch()['expires'],received+420)

class GroupApologyTests(unittest.TestCase):
 setUp=GroupQueueTests.setUp
 def turn(self,chat):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
  p=Policy(temp.name,self.cfg,lambda:self.now);received=self.now
  self.assertEqual(p.ingest(1,'Synthetic member','小T，解释一下网络拥塞？',chat_id=chat,at_me=True),'queued')
  self.now+=5;return p,p.dispatch(),received
 def test_two_groups_have_different_apology_thresholds_at_the_same_elapsed_time(self):
  import latency
  a,ta,ra=self.turn('1');b,tb,rb=self.turn('2')
  self.now=ra+90;body,info=latency.decorate(a,ta['id'],'This is the answer.');self.assertTrue(info['late']);self.assertTrue(body.startswith('Sorry for the wait.'))
  self.now=rb+90;body,info=latency.decorate(b,tb['id'],'This is the answer.');self.assertFalse(info['late']);self.assertEqual(body,'This is the answer.')
 def test_exact_threshold_is_normal_and_only_strictly_greater_is_late(self):
  import latency
  p,t,received=self.turn('1')
  for elapsed,late in [(59.99,False),(60,False),(60.01,True)]:
   self.now=received+elapsed;_,info=latency.decorate(p,t['id'],'This is the answer.');self.assertEqual(bool(info['late']),late)
 def test_queue_time_is_part_of_the_apology_clock(self):
  import latency
  received=self.now;self.p.ingest(1,'Synthetic member','小T，解释一下网络拥塞？',chat_id='1',at_me=True)
  self.now+=45;t=self.p.dispatch();self.now=received+60.01
  _,info=latency.decorate(self.p,t['id'],'This is the answer.');self.assertTrue(info['late']);self.assertAlmostEqual(info['elapsed_seconds'],60.01,places=4)
 def test_v1_policy_preserves_the_existing_global_five_minute_setting(self):
  import latency
  self.cfg['wait_apology_seconds']=300;self.cfg['managed_groups']['2']['policy']['timeouts'].pop('wait_apology_seconds')
  p,t,received=self.turn('2')
  for elapsed,late in [(121,False),(300,False),(300.01,True)]:
   self.now=received+elapsed;_,info=latency.decorate(p,t['id'],'This is the answer.');self.assertEqual(bool(info['late']),late)
 def test_threshold_beyond_lifetime_does_not_extend_the_task(self):
  import latency
  from policy import Denied
  self.cfg['managed_groups']['1']['policy']['timeouts']['wait_apology_seconds']=600
  p,t,received=self.turn('1');self.now=received+170
  body,info=latency.decorate(p,t['id'],'This is the answer.');self.assertFalse(info['late']);self.assertEqual(body,'This is the answer.')
  self.now=received+181
  with self.assertRaises(Denied):p.reserve_send('synthetic-expired',t['id'],'1')
 def test_prepared_persona_apology_remains_in_the_single_output(self):
  import latency
  p,t,received=self.turn('1')
  with p.db() as db:db.execute('UPDATE turns SET wait_apology=? WHERE id=?',('Sorry, I took the scenic route.',t['id']))
  self.now=received+61;body,info=latency.decorate(p,t['id'],'This is the answer.')
  self.assertEqual(body,'Sorry, I took the scenic route.\n\nThis is the answer.');self.assertEqual(info['apology_source'],'persona_model')

try:
 from src.config.model_configs import ModelInfo,APIProvider
 from src.llm_models import utils_model as native
 import group_guard
 NATIVE=True
except ModuleNotFoundError:NATIVE=False

@unittest.skipUnless(NATIVE,'Pinned MaiBot image required')
class NativeGroupTimeoutTests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.now=100.;self.turn={'id':'synthetic-turn','chat_id':'1','policy_revision':'7','expires':700}
  self.profiles={}
  route={'source':'group','available':True,'credential_id':'synthetic-key','credential_revision':1,'model_id':'synthetic-model','client_type':'openai'}
  for chat,value in [('1',SHORT),('2',LONG)]:
   self.profiles[chat]={'enabled':True,'revision':7,'valid_until':1000,'policy':{'timeouts':copy.deepcopy(value)},'model_routing_contract_version':1,'model_routing':{'text':copy.deepcopy(route)},'private_text_route':{**route,'base_url':'https://example.invalid/v1','api_key':'isolated-model-key'}}
  self.p=SimpleNamespace(cfg={'managed_groups':self.profiles},active_turn=lambda:self.turn,clock=lambda:self.now)
  self.mock=patch.object(group_guard,'policy',return_value=self.p);self.mock.start();self.addCleanup(self.mock.stop)
  token=group_guard.TURN.set(self.turn['id']);self.addCleanup(group_guard.TURN.reset,token)
 async def wrapper_timeout(self,task='planner'):
  seen=[]
  async def capture(awaitable,timeout):seen.append(timeout);return await awaitable
  slot=SimpleNamespace(task_name=task,request_type='synthetic',model_for_task=SimpleNamespace(hard_timeout=300 if task=='planner' else 60),_attempt_request_on_model=AsyncMock(return_value='synthetic-response'))
  with patch.object(native.asyncio,'wait_for',side_effect=capture):
   result=await native.LLMOrchestrator._attempt_request_on_model_with_timeout(slot,None,None,None,'synthetic')
  self.assertEqual(result,'synthetic-response');return seen[0]
 async def test_actual_native_wrapper_uses_the_source_groups_planner_limit(self):
  self.assertEqual(await self.wrapper_timeout(),60)
  self.turn['chat_id']='2';self.assertEqual(await self.wrapper_timeout(),450)
 async def test_replyer_retains_its_existing_sixty_second_hard_timeout(self):
  self.turn['chat_id']='2';self.assertEqual(await self.wrapper_timeout('replyer'),60)
 async def test_planner_limit_is_shortened_by_the_original_remaining_deadline(self):
  self.turn['expires']=120
  self.assertEqual(await self.wrapper_timeout(),15)
 async def test_config_change_rejects_stale_active_task(self):
  from src.llm_models.exceptions import ReqAbortException
  self.profiles['1']['revision']=8
  with self.assertRaises(ReqAbortException):await self.wrapper_timeout()
 async def test_shared_key_with_different_timeouts_does_not_reuse_the_wrong_client(self):
  from model_routing import select_route
  from src.llm_models.model_client.base_client import ClientRegistry
  model=ModelInfo(name='synthetic-slot',model_identifier='original',api_provider='original',model_type='llm')
  original=APIProvider(name='original',base_url='https://example.invalid/v1',api_key='isolated',timeout=310)
  a,pa=select_route(model,original,'planner');self.turn['chat_id']='2';b,pb=select_route(model,original,'planner')
  self.assertEqual((pa.timeout,pb.timeout),(70,460));self.assertNotEqual(ClientRegistry._get_client_cache_key(pa),ClientRegistry._get_client_cache_key(pb))
  self.assertEqual(original.timeout,310);self.assertEqual(model.api_provider,'original')
 async def test_explicit_legacy_provider_is_copied_for_the_group_not_mutated(self):
  from model_routing import select_route
  self.profiles['1']['model_routing']['text']['source']='legacy'
  model=ModelInfo(name='synthetic-slot',model_identifier='original',api_provider='original',model_type='llm')
  original=APIProvider(name='original',base_url='https://example.invalid/v1',api_key='isolated',timeout=310)
  _,provider=select_route(model,original,'planner');self.assertEqual(provider.timeout,70);self.assertEqual(original.timeout,310)
  self.assertNotEqual(provider.name,original.name)

if __name__=='__main__':unittest.main()
