import copy,json,tempfile,unittest,os
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace as NS
import model_routing as routing
import groupdesk_runtime as gd
import test_model_routing as base

@unittest.skipUnless(base.NATIVE,'Native MaiBot classes required')
class StageModelTests(unittest.TestCase):
 def setUp(self):
  base.ModelRoutingTests.setUp(self)
  self.profile['model_stage_routing_contract_version']=1
  self.profile['model_routing']['stages']={}
  self.profile['private_stage_routes']={}
  for stage in routing.STAGES:
   route={**self.route,'credential_id':'key-'+stage,'model_id':'model-'+stage,'client_type':'openai','source':'group_stage'}
   self.profile['model_routing']['stages'][stage]=route
   if stage!='summary':self.profile['private_stage_routes'][stage]={**route,'base_url':'https://'+stage+'.example.com/v1','api_key':'isolated-'+stage+'-key'}
 def test_each_native_stage_uses_its_own_wire_model_url_and_key(self):
  for stage in routing.RUNTIME_STAGES:
   model,provider=routing.select_route(self.model,self.provider,stage)
   self.assertEqual(model.model_identifier,'model-'+stage)
   self.assertEqual(provider.api_key,'isolated-'+stage+'-key')
   self.assertEqual(provider.base_url,'https://'+stage+'.example.com/v1')
   self.assertEqual(model.name,'task-slot')
  self.assertEqual(self.model.model_identifier,'original-model');self.assertEqual(self.provider.api_key,'original-test-key')
 def test_missing_stale_or_disabled_stage_cannot_fall_back_to_base_credentials(self):
  for mutation in ('missing','stale','disabled'):
   public=copy.deepcopy(self.profile['model_routing']['stages']['replyer']);private=copy.deepcopy(self.profile['private_stage_routes']['replyer'])
   if mutation=='missing':self.profile['private_stage_routes']['replyer']=None
   elif mutation=='stale':self.profile['private_stage_routes']['replyer']['credential_revision']=0
   else:self.profile['model_routing']['stages']['replyer']['available']=False
   with self.assertRaises(base.ReqAbortException):routing.select_route(self.model,self.provider,'replyer')
   self.profile['model_routing']['stages']['replyer']=public;self.profile['private_stage_routes']['replyer']=private
 def test_unrecognized_contract_is_rejected(self):
  self.profile['model_stage_routing_contract_version']=2
  with self.assertRaises(base.ReqAbortException):routing.select_route(self.model,self.provider,'planner')
 def test_different_answer_model_disables_fast_send_but_same_binding_can_share_call(self):
  self.assertFalse(routing.shortcut_allowed(self.profile))
  self.profile['model_routing']['stages']['replyer']=copy.deepcopy(self.profile['model_routing']['stages']['planner'])
  self.assertTrue(routing.shortcut_allowed(self.profile))
  self.profile['model_routing']['stages']['replyer']['credential_revision']+=1
  self.assertFalse(routing.shortcut_allowed(self.profile))
 def test_validator_excludes_summary_credentials_and_rejects_incomplete_stage_maps(self):
  routing.validate_stage_routes(self.profile,self.profile['private_stage_routes'])
  private=copy.deepcopy(self.profile['private_stage_routes']);private['summary']={}
  with self.assertRaises(ValueError):routing.validate_stage_routes(self.profile,private)
  del self.profile['private_stage_routes']['utils']
  with self.assertRaises(ValueError):routing.validate_stage_routes(self.profile,self.profile['private_stage_routes'])
 def test_native_selector_passes_answer_key_to_the_real_client_factory(self):
  import asyncio
  from unittest.mock import AsyncMock
  native,slot=base.NativeSelectionRoutingTests.slot(self);slot.task_name='replyer'
  async def exercise():
   with patch.object(native.TempMethodsLLMUtils,'get_model_info_by_name',return_value=self.model),patch.object(native.TempMethodsLLMUtils,'get_provider_by_name',return_value=self.provider),patch.object(native.client_registry,'get_client_class_instance_async',new=AsyncMock(return_value=object())) as factory:
    model,provider,_=await native.LLMRequest._select_model(slot)
    self.assertEqual(model.model_identifier,'model-replyer');self.assertEqual(factory.call_args.args[0].api_key,'isolated-replyer-key')
  asyncio.run(exercise())
 def test_real_dispatch_clears_fast_and_greeting_flags_for_distinct_stage_models(self):
  from policy import Policy,settings
  from test_groupdesk_runtime import bundle
  now=[1793430000.];profile=bundle(now[0]);profile.update(model_stage_routing_contract_version=1,model_routing=self.profile['model_routing'])
  cfg=settings();cfg['managed_groups']={'26992':profile}
  with tempfile.TemporaryDirectory() as d:
   p=Policy(d,cfg,lambda:now[0]);self.assertEqual(p.ingest(1,'Synthetic','小T，晚上好',chat_id='26992'),'queued')
   now[0]+=5;turn=p.dispatch();self.assertFalse(turn['fast']);self.assertFalse(turn['greeting'])
   # Replyer must remain admitted after Planner: a greeting may not stop it.
   attempt,_=p.reserve_model('replyer',100,100,expected_turn_id=turn['id']);p.settle_model(attempt,120)

class StageSyncTests(unittest.TestCase):
 def test_sync_applies_only_verified_stage_credentials_before_ack(self):
  from test_groupdesk_runtime import bundle
  b=bundle();b.update(model_routing_contract_version=1,model_stage_routing_contract_version=1)
  public={'source':'group_stage','available':True,'credential_id':'synthetic','credential_revision':1,'model_id':'text-model','client_type':'openai'}
  b['model_routing']={'text':{'source':'legacy','available':False},'stages':{s:copy.deepcopy(public) for s in routing.STAGES}}
  private={s:{**public,'api_key':'synthetic-private-stage-key','base_url':'https://example.invalid/v1'} for s in routing.RUNTIME_STAGES}
  for mismatch in (False,True):
   credentials=copy.deepcopy(private)
   if mismatch:credentials['utils']['model_id']='wrong-model'
   acknowledgements=[]
   def api(path,body=None):
    if path.startswith('/config/'):return copy.deepcopy(b)
    if path=='/model-credentials':return {'text_route':None,'stage_routes':credentials}
    if path=='/ack':acknowledgements.append(body);return {'ok':True}
    raise AssertionError(path)
   with tempfile.TemporaryDirectory() as d:
    connection=Path(d)/'connection.json';snapshot=Path(d)/'snapshot.json'
    connection.write_text(json.dumps({'url':'https://example.invalid','token':'synthetic-adapter-token','groups':{'26992':'example-room'}}))
    with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=api):result=gd.sync()
    saved=json.loads(snapshot.read_text())['groups']['26992']
    self.assertEqual(bool(saved['enabled']),not mismatch);self.assertNotIn('synthetic-private-stage-key',json.dumps(result));self.assertEqual(os.stat(snapshot).st_mode&0o777,0o600)
    if mismatch:self.assertFalse(acknowledgements);self.assertNotIn('private_stage_routes',saved)
    else:self.assertEqual(acknowledgements[0]['model_stage_routing_version'],1)
