"""Synthetic topic limits and delivery text; no real model or group access."""
import copy,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import reply_length as rl
from policy import Policy,settings,Denied
from test_groupdesk_runtime import bundle

class ReplyLengthTests(unittest.TestCase):
 def setUp(self):
  self.b=bundle();self.cfg={'output_chars':450,'managed_groups':{'1':self.b}}
  self.turn={'chat_id':'1','article':0,'managed_topics':json.dumps(['Example food'])}
 def test_only_admitted_topics_in_this_group_affect_length(self):
  self.b['topics'][0]['policy']['max_reply_chars']=900
  self.assertEqual(rl.for_turn(self.cfg,self.turn),(900,['Example food']))
  self.assertEqual(rl.for_turn(self.cfg,{**self.turn,'chat_id':'2'})[0],450)
  self.assertEqual(rl.for_turn(self.cfg,{**self.turn,'managed_topics':'[]'})[0],450)
  other=copy.deepcopy(self.b['topics'][0]);other.update(id='other',name='Other');other['policy']['max_reply_chars']=1500;self.b['topics'].append(other)
  self.assertEqual(rl.for_turn(self.cfg,self.turn)[0],900)
  self.assertEqual(rl.for_turn(self.cfg,{**self.turn,'managed_topics':json.dumps(['Example food','Other'])})[0],1500)
 def test_unset_inherits_and_explicit_cap_also_limits_articles(self):
  self.assertEqual(rl.for_turn(self.cfg,self.turn)[0],450)
  self.assertEqual(rl.for_turn(self.cfg,{**self.turn,'article':1})[0],2000)
  self.b['topics'][0]['policy']['max_reply_chars']=100
  self.assertEqual(rl.for_turn(self.cfg,{**self.turn,'article':1})[0],100)
 def test_contract_rejects_unknown_or_malformed_caps(self):
  self.b['topic_reply_length_contract_version']=1
  for value in [100,4000,None]:
   self.b['topics'][0]['policy']['max_reply_chars']=value;rl.validate_bundle(self.b)
  for value in [True,99,4001,100.5,'900']:
   self.b['topics'][0]['policy']['max_reply_chars']=value
   with self.assertRaises(ValueError):rl.validate_bundle(self.b)
  self.b['topics'][0]['policy']['max_reply_chars']=900;del self.b['topic_reply_length_contract_version']
  with self.assertRaises(ValueError):rl.validate_bundle(self.b)
 def test_english_is_complete_at_sentence_or_word_boundary(self):
  text='That pipeline makes sense. '+('A useful observation. '*15)+'How does the script absorb the irregularities?'
  result=rl.shorten(text,350);self.assertLessEqual(len(result),350);self.assertTrue(result.endswith('.'))
  self.assertEqual(rl.shorten('abcdefghij klmnopqrstuvwxyz',17),'abcdefghij…')
  self.assertEqual(rl.shorten('Fine.',100),'Fine.')
 def test_url_and_code_are_not_sliced_mid_fragment(self):
  text='Details at https://example.invalid/'+('x'*200)
  self.assertNotIn('https:',rl.shorten(text,100))
  self.assertNotIn('```',rl.shorten('Here is code:\n```python\n'+('x'*200),100))
  self.assertLessEqual(len(rl.shorten('这是一条中文回复。'*100,100)),100)
 def test_trusted_length_instruction_replaces_old_marker(self):
  from src.llm_models.model_client.base_client import ResponseRequest
  from src.llm_models.payload_content.context_item import ContextItemBuilder
  from src.config.model_configs import ModelInfo
  request=ResponseRequest(model_info=ModelInfo(name='test',model_identifier='test',api_provider='test',model_type='llm'),context_items=[ContextItemBuilder().add_text_content('Synthetic user').build()],max_tokens=384)
  p=SimpleNamespace(cfg=self.cfg)
  rl.bind(p,request,self.turn,'replyer');rl.bind(p,request,self.turn,'planner')
  markers=[part.text for item in request.context_items for part in item.parts if getattr(part,'text','').startswith(rl.MARKER)]
  self.assertEqual(len(markers),1);self.assertIn('450',markers[0])
 def test_apology_and_answer_share_topic_limit(self):
  import latency
  with tempfile.TemporaryDirectory() as d:
   now=[1793502000.];cfg=settings();b=bundle(now[0]);b['valid_until']=now[0]+5000;b['topics'][0]['policy']['max_reply_chars']=100
   cfg['managed_groups']={'1':b};p=Policy(d,cfg,lambda:now[0])
   self.assertEqual(p.ingest(1,'Synthetic member','小T, Canto food is tasty?',chat_id='1',at_me=True),'queued')
   now[0]+=5;t=p.dispatch();now[0]+=301
   body,info=latency.decorate(p,t['id'],'A good soup warms the day. '*20,b)
   self.assertTrue(info['late']);self.assertLessEqual(len(body),100);self.assertIn('Sorry',body)
   final,limit=rl.prepare(p,t['id'],body);self.assertEqual(limit,100);self.assertEqual(final,body)

if __name__=='__main__':unittest.main()
