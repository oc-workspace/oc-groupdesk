import unittest,copy
import tempfile,json,os
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
try:
 from src.config.model_configs import ModelInfo,APIProvider
 from src.llm_models.exceptions import ReqAbortException
 import group_guard
 from model_routing import select_route
 NATIVE=True
except ModuleNotFoundError:NATIVE=False

@unittest.skipUnless(NATIVE,'Native MaiBot classes required')
class ModelRoutingTests(unittest.TestCase):
 def setUp(self):
  self.model=ModelInfo(name='task-slot',model_identifier='original-model',api_provider='original',model_type='llm')
  self.provider=APIProvider(name='original',base_url='https://api.example.com/v1',api_key='original-test-key')
  self.turn={'id':'admitted-turn','chat_id':'group-a','policy_revision':'9'}
  self.route={'source':'group','available':True,'credential_id':'key-a','credential_revision':2,'model_id':'model-a'}
  self.profile={'model_routing_contract_version':1,'revision':9,'enabled':True,'valid_until':175,'model_routing':{'text':self.route},'private_text_route':{**self.route,'base_url':'https://api.example.com/v1','api_key':'isolated-key-a'}}
  self.p=SimpleNamespace(active_turn=lambda:self.turn,cfg={'managed_groups':{'group-a':self.profile}},clock=lambda:100)
  self.mock=patch.object(group_guard,'policy',return_value=self.p);self.mock.start();self.addCleanup(self.mock.stop)
  self.token=group_guard.TURN.set('admitted-turn');self.addCleanup(group_guard.TURN.reset,self.token)
 def select(self):return select_route(self.model,self.provider,'planner')
 def test_request_local_route_changes_actual_model_and_key_without_mutating_global_slot(self):
  model,provider=self.select();self.assertEqual(model.name,'task-slot');self.assertEqual(model.model_identifier,'model-a');self.assertEqual(provider.api_key,'isolated-key-a')
  self.assertEqual(self.model.model_identifier,'original-model');self.assertEqual(self.provider.api_key,'original-test-key')
  other=copy.deepcopy(self.profile);other['model_routing']['text'].update(credential_id='key-b',model_id='model-b');other['private_text_route'].update(credential_id='key-b',model_id='model-b',api_key='isolated-key-b')
  self.p.cfg['managed_groups']['group-b']=other;self.turn['chat_id']='group-b'
  b,key=self.select();self.assertEqual(b.model_identifier,'model-b');self.assertEqual(key.api_key,'isolated-key-b');self.assertNotEqual(key.name,provider.name)
 def test_expired_lease_never_falls_back_to_global_key(self):
  self.profile['valid_until']=99
  with self.assertRaises(ReqAbortException):self.select()
 def test_changed_revision_and_stale_turn_are_rejected(self):
  self.turn['policy_revision']='8'
  with self.assertRaises(ReqAbortException):self.select()
  self.turn['policy_revision']='9';group_guard.TURN.set('other-turn')
  with self.assertRaises(ReqAbortException):self.select()
 def test_stale_private_key_cannot_match_new_credential_revision(self):
  self.profile['private_text_route']['credential_revision']=1
  with self.assertRaises(ReqAbortException):self.select()
 def test_disabled_or_unavailable_routes_never_fall_back(self):
  self.route['available']=False
  with self.assertRaises(ReqAbortException):self.select()
  self.route.update(available=True,source='disabled')
  with self.assertRaises(ReqAbortException):self.select()
 def test_legacy_is_explicit_and_preserves_existing_client(self):
  self.route['source']='legacy';model,provider=self.select()
  self.assertIs(model,self.model);self.assertIs(provider,self.provider)

@unittest.skipUnless(NATIVE,'Native MaiBot classes required')
class NativeSelectionRoutingTests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):ModelRoutingTests.setUp(self)
 def slot(self):
  from src.llm_models import utils_model as native
  from types import MethodType
  slot=SimpleNamespace(_refresh_task_config=lambda:None,model_usage={'task-slot':(0,0,0)},_explicit_model_usage={},task_name='planner',model_for_task=SimpleNamespace(selection_strategy='random',model_list=['task-slot']))
  slot._adjust_model_usage=MethodType(native.LLMRequest._adjust_model_usage,slot)
  return native,slot
 async def test_native_selector_constructs_the_group_provider_and_actual_model(self):
  from unittest.mock import AsyncMock
  native,slot=self.slot();client=object()
  with patch.object(native.TempMethodsLLMUtils,'get_model_info_by_name',return_value=self.model),patch.object(native.TempMethodsLLMUtils,'get_provider_by_name',return_value=self.provider),patch.object(native.client_registry,'get_client_class_instance_async',new_callable=AsyncMock,return_value=client) as factory:
   model,provider,result=await native.LLMRequest._select_model(slot)
   self.assertEqual(model.model_identifier,'model-a');self.assertIs(result,client)
   self.assertEqual(factory.call_args.args[0].api_key,'isolated-key-a');self.assertEqual(slot.model_usage['task-slot'],(0,0,1))
   slot._adjust_model_usage(model.name,usage_penalty_delta=-1);self.assertEqual(slot.model_usage['task-slot'],(0,0,0))
 async def test_native_client_initialization_failure_returns_the_task_slot(self):
  from unittest.mock import AsyncMock
  native,slot=self.slot()
  with patch.object(native.TempMethodsLLMUtils,'get_model_info_by_name',return_value=self.model),patch.object(native.TempMethodsLLMUtils,'get_provider_by_name',return_value=self.provider),patch.object(native.client_registry,'get_client_class_instance_async',new_callable=AsyncMock,side_effect=RuntimeError('isolated client initialization failure')):
   with self.assertRaises(RuntimeError):await native.LLMRequest._select_model(slot)
   self.assertEqual(slot.model_usage['task-slot'],(0,0,0))

class SyncPrivateRouteTests(unittest.TestCase):
 def exercise(self,mismatch=False):
  import groupdesk_runtime as gd
  from test_groupdesk_runtime import bundle
  b=bundle();b['external_id']='room';b['model_routing_contract_version']=1
  route={'source':'group','available':True,'credential_id':'key-a','credential_revision':1,'model_id':'text-a'}
  b['model_routing']={'text':route,'image':{'source':'disabled','available':False}}
  private={**route,'api_key':'isolated-private-route-key','base_url':'https://api.example.com/v1','client_type':'openai'}
  if mismatch:private['credential_revision']=0
  acknowledgements=[]
  def api(path,body=None):
   if path.startswith('/config/'):return b
   if path=='/model-credentials':return {'text_route':private}
   if path=='/ack':acknowledgements.append(body);return {'ok':True}
   raise AssertionError(path)
  with tempfile.TemporaryDirectory() as d:
   connection=Path(d)/'connection.json';snapshot=Path(d)/'snapshot.json'
   connection.write_text(json.dumps({'url':'https://groupdesk.example','token':'isolated-adapter-token','groups':{'chat':'room'}}))
   with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=api):
    summary=gd.sync();saved=json.loads(snapshot.read_text())['groups']['chat']
   self.assertEqual(os.stat(snapshot).st_mode&0o777,0o600)
   self.assertNotIn('isolated-private-route-key',json.dumps(summary))
   return saved,acknowledgements
 def test_confirm_only_after_matching_private_route_is_loaded(self):
  saved,acks=self.exercise();self.assertTrue(saved['enabled']);self.assertEqual(saved['private_text_route']['api_key'],'isolated-private-route-key');self.assertEqual(acks[0]['model_routing_version'],1)
 def test_private_route_mismatch_disables_group_without_confirmation(self):
  saved,acks=self.exercise(True);self.assertFalse(saved['enabled']);self.assertNotIn('private_text_route',saved);self.assertEqual(acks,[])
