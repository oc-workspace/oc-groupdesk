import asyncio,copy,importlib.util,json,os,sqlite3,tempfile,time,unittest,uuid
from pathlib import Path
from types import SimpleNamespace as Obj
from unittest.mock import Mock,patch
import interactions_runtime as ir
import groupdesk_runtime as gd

WORDS={'zh-CN':{'checkin':['摸鱼'],'balance':['余额'],'catalog':['兑换列表','可以兑换啥','兑换'],'redeem':['兑换']},'en':{'checkin':['check in'],'balance':['balance'],'catalog':['prizes'],'redeem':['redeem']}}
def profile():
 return {'id':str(uuid.uuid4()),'external_id':'synthetic-room','enabled':True,'revision':8,'valid_until':time.time()+1000,'policy':{'timeouts':{'direct_ttl_seconds':420}},'interactions_contract_version':1,'interactions':{'settings':{'bot_aliases':['小T','bot']},'bindings':[{'id':str(uuid.uuid4()),'name':'每日摸鱼','kind':'daily_checkin','commands':copy.deepcopy(WORDS),'require_mention':False,'language_mode':'follow'}],'prizes':[]}}

class ParserTests(unittest.TestCase):
 def test_exact_commands_and_quotes(self):
  for text in ['我想摸鱼一整天','“摸鱼”','redeemable R001','> 摸鱼','https://x.invalid/摸鱼']:self.assertIsNone(ir.match(text,WORDS),text)
  self.assertEqual(ir.match('摸鱼！！！',WORDS)['action'],'checkin')
 def test_member_language_and_prize_codes(self):
  self.assertEqual(ir.match('REDEEM r001!',WORDS),{'action':'redeem','locale':'en','prize_code':'R001'})
  self.assertEqual(ir.match('兑换飞吻',WORDS)['action'],'catalog')
  self.assertEqual(ir.match('兑换 R002',WORDS)['prize_code'],'R002')
 def test_bot_prefix_and_mention(self):
  self.assertIsNone(ir.match('摸鱼',WORDS,require_mention=True))
  self.assertEqual(ir.match('@小T，摸鱼',WORDS,['小T'],require_mention=True)['action'],'checkin')
  self.assertIsNone(ir.match('不是小T 摸鱼',WORDS,['小T']))
 def test_contract_is_bounded_and_old_empty_backend_works(self):
  ir.validate_bundle({});p=profile();ir.validate_bundle(p)
  for change in [lambda p:p.update(interactions_contract_version=2),lambda p:p['interactions']['bindings'][0].update(kind='run_shell'),lambda p:p['interactions']['settings'].update(bot_aliases=[]),lambda p:p['interactions']['bindings'][0]['commands']['en']['checkin'].extend(['x']*300)]:
   p=profile();change(p)
   with self.assertRaises((ValueError,KeyError)):ir.validate_bundle(p)
 def test_prize_guide_is_public_and_never_authorizes_chat_to_mint(self):
  p=profile();text=ir.guide(p);self.assertIn('不能自行宣布发放',text);self.assertIn('现在还没定奖品',text);self.assertNotIn('api_key',text)
  p['interactions']['prizes']=[{'code':'R001','name':'测试','cost':1000,'available':True}];self.assertIn('R001',ir.guide(p))
  p['interactions']['bindings']=[];self.assertEqual(ir.guide(p),'')

class QueueTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  path=Path(os.environ.get('GT_TEST_BRIDGE','/bridge/app.py'));spec=importlib.util.spec_from_file_location('synthetic_interaction_bridge',path);cls.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.module)
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=profile();self.cfg={'managed_groups':{'1':self.p}}
  self.bridge=Obj(ledger=self.module.Ledger(Path(self.tmp.name)/'delivery.sqlite3'),policy=Obj(cfg=self.cfg),chats={1:Obj(id=1,name='Synthetic group')},control=lambda:{'enabled':True,'send_enabled':True},send_lock=asyncio.Lock(),health={'verified_sends':0})
  self.bridge.agent=Obj(send_text=Mock(return_value=Obj()),wait_delivery=Mock(return_value=Obj(delivery_status='sent',seq=400)))
  self.event_id=str(uuid.uuid4());self.calls=[];self.api_mock=patch.object(gd,'api',side_effect=self.api).start();self.addCleanup(patch.stopall);patch('policy.settings',return_value=self.cfg).start();ir.init(self.bridge.ledger)
 def api(self,path,body=None):
  self.calls.append((path,body))
  if path.endswith('/events'):return {'handled':True,'event_id':self.event_id,'outcome':'checked_in'}
  if path.endswith('/reserve'):return {'send':True,'text':'摸鱼成功，摸到 23 token。'}
  return {'ok':True}
 def message(self,seq=1,**change):return Obj(**{'seq':seq,'chat_id':1,'direction':'incoming','message_type':'text','sender':'Synthetic member','content':'摸鱼','is_at_me':False,**change})
 def enqueue(self,seq=1,**change):return ir.consider(self.bridge,self.message(seq,**change),time.time())
 def step(self):return asyncio.run(ir.step(self.bridge))
 def test_ingress_is_durable_idempotent_and_explicitly_nickname_based(self):
  self.assertTrue(self.enqueue());self.assertTrue(self.enqueue());job=ir.next_job(self.bridge);payload=json.loads(job['payload']);self.assertEqual(payload['actor']['kind'],'group_nickname');self.assertTrue(payload['actor']['id'].startswith('ui-'))
  with self.bridge.ledger.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM interaction_queue').fetchone()[0],1)
 def test_old_outgoing_unknown_or_unlisted_messages_do_not_enter_queue(self):
  for change in [{'chat_id':2},{'direction':'outgoing'},{'sender':None},{'content':'普通聊天'},{'message_type':'image'}]:self.assertFalse(self.enqueue(**change))
  self.assertTrue(ir.consider(self.bridge,self.message(),time.time()-91));self.assertIsNone(ir.next_job(self.bridge))
 def test_expired_or_disabled_group_does_not_handle_commands(self):
  self.p['enabled']=False;self.assertFalse(self.enqueue());self.p['enabled']=True;self.p['valid_until']=0;self.assertFalse(self.enqueue())
 def test_send_is_reserved_once_and_reported_without_second_physical_send(self):
  self.enqueue();self.step();self.assertEqual(ir.next_job(self.bridge)['status'],'sent');self.step();self.assertIsNone(ir.next_job(self.bridge));self.assertFalse(self.step());self.bridge.agent.send_text.assert_called_once()
  self.assertEqual([x[0].split('/')[-1] for x in self.calls],['events','reserve','delivery']);self.assertEqual(self.calls[-1][1],{'status':'sent'})
 def test_restart_during_reserve_or_send_never_replays(self):
  for seq,status in [(1,'reserving'),(2,'sending')]:
   self.enqueue(seq);ir.update(self.bridge,seq,event_id=self.event_id,status=status);ir.init(self.bridge.ledger);self.step()
  self.bridge.agent.send_text.assert_not_called();self.assertEqual([x[1]['status'] for x in self.calls],['uncertain','uncertain'])
 def test_network_failure_after_reserve_is_uncertain_without_resend(self):
  self.enqueue();original=self.api
  def api(path,body=None):
   if path.endswith('/reserve'):raise TimeoutError()
   return original(path,body)
  self.api_mock.side_effect=api;self.step();self.assertEqual(ir.next_job(self.bridge)['status'],'uncertain');self.step();self.bridge.agent.send_text.assert_not_called()
 def test_submission_retry_uses_same_source_and_only_sends_once(self):
  self.enqueue();original=self.api;failed=[False]
  def api(path,body=None):
   if path.endswith('/events') and not failed[0]:failed[0]=True;raise TimeoutError()
   return original(path,body)
  self.api_mock.side_effect=api;self.step();self.step();self.step();self.bridge.agent.send_text.assert_called_once();self.assertEqual(self.calls[0][1]['source_id'],'bowxt:1:1')
 def test_unknown_delivery_result_is_not_retried(self):
  self.bridge.agent.wait_delivery.return_value=Obj(delivery_status='queued',seq=400);self.enqueue();self.step();self.step();self.bridge.agent.send_text.assert_called_once();self.assertEqual(self.calls[-1][1],{'status':'uncertain'})
 def test_paused_sender_and_revision_change_prevent_delivery(self):
  self.enqueue();self.bridge.control=lambda:{'enabled':True,'send_enabled':False};self.assertFalse(self.step());self.assertEqual(self.calls,[])
  self.bridge.control=lambda:{'enabled':True,'send_enabled':True};self.p['revision']+=1;self.step();self.bridge.agent.send_text.assert_not_called();self.assertIsNone(ir.next_job(self.bridge))
 def test_server_existing_reservation_prevents_duplicate_send(self):
  self.enqueue();original=self.api
  self.api_mock.side_effect=lambda path,body=None:{'send':False,'status':'reserved'} if path.endswith('/reserve') else original(path,body)
  self.step();self.bridge.agent.send_text.assert_not_called();self.assertIsNone(ir.next_job(self.bridge))
 def test_actual_receive_hook_acks_game_without_planner_ingestion(self):
  bridge=object.__new__(self.module.Bridge);bridge.__dict__.update(vars(self.bridge));bridge.group_names=[];bridge.group_settings={};bridge.router=Obj(check_connection=lambda _:True);bridge.health.update(last_error=None,last_inbound_seq=None)
  bridge.policy.ingest=Mock();bridge.heartbeat=Mock();message=self.message();message.timestamp='2026-11-01T00:00:00+00:00';delivery=Obj(message=message);bridge.agent.claim=Mock(return_value=[delivery]);bridge.agent.ack=Mock();bridge.agent.nack=Mock()
  async def end(_):raise asyncio.CancelledError()
  with patch.object(self.module,'settings',return_value=self.cfg),patch.object(self.module,'eligible_source',return_value=True),patch.object(self.module,'source_timestamp',return_value=time.time()),patch('recovery.transport'),patch.object(self.module.asyncio,'sleep',side_effect=end):
   with self.assertRaises(asyncio.CancelledError):asyncio.run(bridge.receive_loop())
  bridge.policy.ingest.assert_not_called();bridge.agent.ack.assert_called_once_with(delivery);self.assertIsNotNone(ir.next_job(bridge));self.assertTrue(bridge.ledger.seen(message.seq))

if __name__=='__main__':unittest.main()
