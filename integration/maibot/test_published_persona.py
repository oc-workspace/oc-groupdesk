import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import groupdesk_runtime as gd
from test_groupdesk_runtime import bundle

def published(text='A self-contained style instruction: concise, practical, and respectful.',identifier='version-a'):
 p=bundle();p['persona_contract_version']=1;p['persona_version_id']=identifier
 p['persona_skill']={'version_id':identifier,'persona_id':'persona-a','version':1,'skill_md':text,'sha256':hashlib.sha256(text.encode()).hexdigest()}
 p['identity_instructions']=['Current group identity rules always apply.'];return p

class ContractTests(unittest.TestCase):
 def test_no_binding_keeps_legacy_and_neutral_compatible(self):
  p=bundle();gd.validate_bundle(p,p['external_id']);self.assertIsNone(gd.validate_persona_bundle(p))
 def test_selected_skill_requires_matching_id_digest_and_supported_contract(self):
  p=published();gd.validate_bundle(p,p['external_id'])
  for patch_values in [{'persona_contract_version':2},{'persona_version_id':'stale'},{'persona_skill':{**p['persona_skill'],'skill_md':'modified with a stale digest'}}]:
   bad={**p,**patch_values}
   with self.assertRaises(ValueError):gd.validate_bundle(bad,p['external_id'])
 def test_unbound_group_cannot_load_an_unexpected_skill(self):
  p=published();del p['persona_version_id']
  with self.assertRaises(ValueError):gd.validate_persona_bundle(p)
 def test_sync_acknowledges_loaded_persona_digest_and_no_private_materials(self):
  p=published();acks=[]
  def api(path,body=None):
   if path.startswith('/config/'):return p
   if path=='/ack':acks.append(body);return {'ok':True}
   raise AssertionError(path)
  with tempfile.TemporaryDirectory() as folder:
   c=Path(folder)/'connection.json';snapshot=Path(folder)/'snapshot.json';c.write_text(json.dumps({'groups':{'chat':p['external_id']}}))
   with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=api):result=gd.sync()
   self.assertTrue(result['chat']['enabled']);self.assertEqual(acks[0]['persona_skill_version'],1);self.assertEqual(acks[0]['persona_skill_sha256'],p['persona_skill']['sha256']);self.assertNotIn('skill_md',json.dumps(result))

try:
 from src.config.model_configs import ModelInfo
 from src.llm_models.model_client.base_client import ResponseRequest
 from persona_runtime import bind_request
 NATIVE=True
except ImportError:NATIVE=False

@unittest.skipUnless(NATIVE,'Requires actual native request classes')
class NativeBindingTests(unittest.TestCase):
 def request(self):return ResponseRequest(model_info=ModelInfo(name='test',model_identifier='test',api_provider='test',model_type='llm'),context_items=[],max_tokens=100)
 def content(self,r):return '\n'.join(getattr(p,'text','') for i in r.context_items for p in i.parts)
 def test_published_style_does_not_load_gt_or_depend_on_builtin_selector(self):
  p=published();p['policy']['persona']='neutral';r=self.request()
  with patch('persona_runtime.load_persona',side_effect=AssertionError('No GT loading')):b=bind_request(r,managed_profile=p)
  self.assertIn('self-contained style',b['text']);self.assertIn('Current group identity',b['text']);self.assertEqual(b['sources']['published_skill'],p['persona_skill']['sha256'])
 def test_switching_group_or_version_replaces_only_previous_trusted_system_binding(self):
  r=self.request();first=published('First unique voice, with source-scoped independent instructions.');second=published('Second different voice, with another group and style preferences.','version-b')
  bind_request(r,managed_profile=first);bind_request(r,managed_profile=second);text=self.content(r)
  self.assertNotIn('First unique voice',text);self.assertIn('Second different voice',text);self.assertEqual(text.count('[GT_PERSONA_SKILL_BINDING:'),1)
 def test_corrupt_selected_skill_fails_without_falling_back(self):
  p=published();p['persona_skill']['sha256']='0'*64
  with patch('persona_runtime.load_persona',side_effect=AssertionError('No fallback')):
   with self.assertRaises(ValueError):bind_request(self.request(),managed_profile=p)
