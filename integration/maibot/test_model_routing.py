import unittest,copy
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
