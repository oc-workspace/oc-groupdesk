import copy,json,tempfile,unittest,time
from pathlib import Path
from unittest.mock import patch
try:
 from policy import Policy
 NATIVE_POLICY=True
except ImportError:NATIVE_POLICY=False
from test_groupdesk_runtime import bundle as oldbundle
from test_group_identity import bundle
from test_published_persona import NativeBindingTests
from persona_runtime import bind_request,load_persona
@unittest.skipUnless(NATIVE_POLICY,"Requires actual MaiBot policy fixture")
class NativeIdentityTests(NativeBindingTests):
 def profile(self,names):
  p=oldbundle();p.update(bundle(names=names));p.update(enabled=True,valid_until=time.time()+10000,revision=2);p['policy'].update(participation='quiet',topic_scope='proactive');return p
 def test_real_ingest_and_real_at_are_group_scoped(self):
  cfg=json.loads(Path('/limits/policy.json').read_text());cfg['group_priority_topics']={};cfg['managed_groups']={'a':self.profile(['Little T']),'b':self.profile([])}
  with tempfile.TemporaryDirectory() as d:
   p=Policy(d,cfg)
   self.assertEqual(p.ingest(101,'s','Little T explain this?',chat_id='a'),'queued')
   self.assertEqual(p.ingest(102,'s','Little T explain this?',chat_id='b'),'filtered')
   self.assertEqual(p.ingest(103,'other','Explain this?',at_me=True,chat_id='b'),'queued')
   self.assertFalse(p.cfg['managed_groups']['b']['bot_identity']['mention_names'])
 def test_all_native_reply_modes_override_skill_and_old_system_bindings(self):
  for mode in ['ordinary','short','article']:
   p=self.profile(['Little T']);p['policy']['persona']='neutral'
   request=self.request();result=bind_request(request,mode=mode,managed_profile=p)
   self.assertTrue(result['text'].endswith(p['bot_name_instructions'][-1]));self.assertNotIn('GT小跟班',result['text'])
   p2=self.profile(['Other T']);p2['policy']['persona']='neutral';p2['bot_name_instructions']=['You are Other T, not Little T.']
   second=bind_request(request,mode=mode,managed_profile=p2);self.assertNotEqual(second['sha256'],result['sha256']);self.assertEqual(self.content(request).count('[GT_PERSONA_SKILL_BINDING:'),1)
 def test_gt_fallback_has_no_fixed_follower_name(self):
  for mode in ['ordinary','short','article']:
   for identity in ['when_asked','proactive','roleplay']:
    text=load_persona(mode,identity_mode=identity)['text'];self.assertNotIn('GT小跟班',text);self.assertNotIn('GT小跟班／小T／小GT',text)
