import copy,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import groupdesk_runtime as gd

POLICY={'schema_version':1,'lexicons':{'en':['Canto food','double boiled soup']},'combinations':[{'name':'food taste','all':[['food','soup','汤'],['tasty','good','鲜']]}],'exclusions':['food for thought','bus fare','心灵鸡汤','汤姆'],'continuations':['waiting','worth it','好喝'],'continuation_exclusions':['bus','code','good morning'],'exit_terms':['another topic','换个话题'],'hard_exit_terms':['不聊美食'],'context':{'enabled':True,'seconds':180,'max_intervening_messages':3,'anchor_chars':400},'reply_depth':'detailed'}
def bundle(now=1793430000.,enabled=True):
 return {'id':'example-group','external_id':'example-room','policy_contract_version':1,'revision':7,'enabled':enabled,'valid_until':now+75,'interaction':'topic','participation_skill':'group-participation','policy':{'topic_scope':'proactive','participation':'active','persona':'gt-persona','base_questions':False,'base_social':False,'topic_overrides':{},'language':{'mode':'follow','allowed':[],'fallback':'zh-CN','allow_requested':True}},'topics':[{'id':'example-food','name':'Example food','description':'Food','instructions':'Discuss relevant details.','policy':copy.deepcopy(POLICY)}]}
class PureTests(unittest.TestCase):
 def test_literal_combinations_and_exclusions(self):
  self.assertEqual(gd.direct_signal(POLICY,'Canto food is lovely')[0],'explicit')
  self.assertEqual(gd.direct_signal(POLICY,'The soup is tasty')[0],'combination')
  for text in ['food for thought','> Canto food','汤姆去开会','https://example.com/Canto-food']:
   self.assertFalse(gd.direct_signal(POLICY,text)[0])
 def test_shipped_food_exclusions_do_not_continue_live_context(self):
  import sqlite3
  catalog=next((parent/'catalog/topics/china-food/topic.json' for parent in Path(__file__).resolve().parents if (parent/'catalog/topics/china-food/topic.json').exists()),Path('/catalog/topics/china-food/topic.json'))
  rule=json.loads(catalog.read_text())['policy'];root=catalog.parent
  rule['lexicons']={lang:json.loads((root/('lexicon.'+lang+'.json')).read_text()) for lang in ['en','zh-CN']}
  cfg={'managed_groups':{'1':bundle()}};cfg['managed_groups']['1']['topics'][0]['policy']=rule
  db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;gd.init_db(db)
  gd.classify(db,cfg,'1',1,'Canto food is good.','Alice',100)
  for seq,text in enumerate(['This is food for thought.','Alphabet soup is confusing.','The bus fare is good.'],2):
   self.assertEqual(gd.classify(db,cfg,'1',seq,text,'Bob',100+seq)[0],[],text)
 def test_missing_snapshot_is_fail_closed(self):
  with tempfile.TemporaryDirectory() as d:
   c=Path(d)/'connection.json';c.write_text(json.dumps({'url':'https://example.invalid','token':'x'*32,'groups':{'1':'example-room'}}))
   with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',Path(d)/'absent.json'):
    self.assertFalse(gd.available(gd.load_profiles()['1'],time.time()))
 def test_sync_failure_disables_group_without_publishing_token(self):
  with tempfile.TemporaryDirectory() as d:
   c=Path(d)/'connection.json';c.write_text(json.dumps({'url':'https://example.invalid','token':'x'*32,'groups':{'1':'example-room'}}));snapshot=Path(d)/'snapshot.json'
   with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=OSError('offline')):gd.sync()
   saved=snapshot.read_text();self.assertNotIn('x'*32,saved);self.assertFalse(json.loads(saved)['groups']['1']['enabled'])
 def test_language_checks_preserve_quotes_and_reject_clear_mismatches(self):
  p=bundle();p['policy']['language']={'mode':'restricted','allowed':['en'],'fallback':'en','allow_requested':True}
  self.assertTrue(gd.language_allowed(p,'This is the word "汤" in Chinese.'))
  self.assertFalse(gd.language_allowed(p,'这是一条纯中文回复。'))
  self.assertFalse(gd.language_allowed(p,'こんにちは、今日はいい天気ですね。'))
  self.assertFalse(gd.language_allowed(p,'Bonjour je suis heureux avec vous.'))
try:
 from policy import Policy,settings,Denied
 INSTALLED=True
except ImportError:INSTALLED=False
@unittest.skipUnless(INSTALLED,'MaiBot policy required')
class AdmissionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1793430000.;self.cfg=settings();self.cfg['managed_groups']={'1':bundle(self.now)};self.p=Policy(self.tmp.name,self.cfg,lambda:self.now)
 def ingest(self,seq,text,sender='Alice',chat='1',at=False):return self.p.ingest(seq,sender,text,chat_id=chat,at_me=at)
 def test_data_edit_changes_matching_without_code_change(self):
  self.assertEqual(self.ingest(1,'A new culinary phrase today.'),'filtered')
  self.cfg['managed_groups']['1']['topics'][0]['policy']['lexicons']['en'].append('culinary phrase')
  self.assertEqual(self.ingest(2,'A new culinary phrase today.'),'queued')
 def test_unselected_topic_and_other_group_do_not_inherit(self):
  self.assertEqual(self.ingest(1,'Canto food is good.'),'queued')
  self.assertEqual(gd.topics(self.cfg,'2','Canto food is good.'),[])
  with self.p.db() as d:d.execute('delete from pending')
  self.now+=10;self.assertEqual(self.ingest(2,'But people are waiting.','Bob'),'queued')
  self.now+=3.1;t=self.p.dispatch();self.assertIn('Canto food',t['context']);self.assertIn('Example food',t['priority_topics'])
 def test_disabled_or_expired_group_denies_named_tasks(self):
  self.cfg['managed_groups']['1']['enabled']=False
  self.assertEqual(self.ingest(1,'小T hello',at=True),'groupdesk_unavailable')
  self.cfg['managed_groups']['1']['enabled']=True;self.now+=76
  self.assertEqual(self.ingest(2,'小T hello',at=True),'groupdesk_unavailable')
 def test_revision_change_cancels_pending_and_blocks_send(self):
  self.ingest(1,'Canto food is good.');self.cfg['managed_groups']['1']['revision']=8;self.now+=4
  self.assertIsNone(self.p.dispatch())
  self.ingest(2,'小T hello',at=True);self.now+=2;t=self.p.dispatch();self.cfg['managed_groups']['1']['revision']=9
  with self.assertRaisesRegex(Denied,'groupdesk_revision'):self.p.reserve_send('no-send',t['id'],chat_id='1')
 def test_context_for_any_topic_uses_configured_data_and_does_not_extend(self):
  self.ingest(1,'Canto food is good.')
  with self.p.db() as d:d.execute('delete from pending')
  start=self.now;self.now+=30;self.ingest(2,'It is worth it.','Bob')
  with self.p.db() as d:self.assertEqual(d.execute('select ts from managed_topic_context').fetchone()[0],start)
  self.now+=151;self.cfg['managed_groups']['1']['valid_until']=self.now+75
  self.assertEqual(self.ingest(3,'It is worth it.','Carol'),'filtered')
 def test_quiet_mode_only_accepts_mentions_and_keeps_budgets(self):
  self.cfg['managed_groups']['1']['policy']['participation']='quiet'
  self.assertEqual(self.ingest(1,'Canto food is good.'),'mention_only')
  self.assertEqual(self.ingest(2,'小T hello',at=True),'queued')
  self.assertEqual(self.p.snapshot()['model_calls_today'],0)

try:
 from src.llm_models.model_client.base_client import ResponseRequest
 from src.llm_models.payload_content.context_item import ContextItemBuilder
 from src.config.model_configs import ModelInfo
 NATIVE=True
except ImportError:NATIVE=False
@unittest.skipUnless(NATIVE,'MaiBot native request classes required')
class BindingTests(unittest.IsolatedAsyncioTestCase):
 async def test_native_guard_binds_managed_skill_language_and_selected_topics(self):
  from policy import Policy,settings
  import group_guard
  with tempfile.TemporaryDirectory() as d:
   now=[1793430000.];cfg=settings();cfg['managed_groups']={'1':bundle(now[0])};p=Policy(d,cfg,lambda:now[0])
   p.ingest(1,'Synthetic','小T, Canto food sounds good',chat_id='1');now[0]+=3;t=p.dispatch();group_guard.TURN.set(t['id']);group_guard.GREETING_INPUT.set(None)
   item=ContextItemBuilder().add_text_content('[GT_REQUEST_ID:'+t['id']+']').build()
   r=ResponseRequest(model_info=ModelInfo(name='test',model_identifier='test',api_provider='test',model_type='llm'),context_items=[item],max_tokens=300)
   with patch.object(group_guard,'policy',return_value=p):
    async with group_guard.guarded_attempt('replyer','test',r) as a:
     text='\n'.join(getattr(part,'text','') for i in r.context_items for part in i.parts)
     self.assertIn('GroupDesk可信群策略',text);self.assertIn('输出语言策略',text);self.assertIn('本轮话题指导',text);a.record(type('Usage',(),{'total_tokens':100})())
 def test_neutral_binding_does_not_load_private_gt_skill(self):
  from persona_runtime import bind_request
  p=bundle();p['policy']['persona']='neutral'
  r=ResponseRequest(model_info=ModelInfo(name='test',model_identifier='test',api_provider='test',model_type='llm'),context_items=[],max_tokens=100)
  with patch('persona_runtime.load_persona',side_effect=AssertionError('Must not load GT')):b=bind_request(r,managed_profile=p)
  self.assertIn('中性自然表达',b['text'])

if __name__=='__main__':unittest.main()
