"""Native runtime tests with fake transport, synthetic names and no network."""
import asyncio,importlib.util,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
from policy import Policy,settings
import latency
try:
 from src.llm_models.payload_content.context_item import ContextItemBuilder
 NATIVE=True
except ModuleNotFoundError:NATIVE=False

@unittest.skipUnless(NATIVE,'Pinned MaiBot image required')
class NativeWaitTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.now=1793502000.;self.p=Policy(self.tmp.name,settings(),lambda:self.now)
  self.p.ingest(1,'Synthetic member','小T，你好！',chat_id='1');self.now+=.2;self.turn=self.p.dispatch()
 def test_request_binding_preserves_persona_and_deduplicates_wait_instructions(self):
  from src.llm_models.payload_content.context_item import RoleType
  request=SimpleNamespace(context_items=[ContextItemBuilder().set_role(RoleType.System).add_text_content('[GT_PERSONA_SKILL_BINDING:fixture]').build(),ContextItemBuilder().add_text_content('synthetic input').build()])
  latency.bind(self.p,request,self.turn['id'],'planner');latency.bind(self.p,request,self.turn['id'],'planner')
  texts=[getattr(part,'text','') for item in request.context_items for part in item.parts]
  self.assertEqual(sum(t.startswith('[GT_WAIT_POLICY]') for t in texts),1)
  self.assertTrue(any('[GT_PERSONA_SKILL_BINDING:fixture]' in t for t in texts))
 def test_native_reply_tool_saves_prepared_apology_and_still_sends_only_body(self):
  import group_guard
  from src.maisaka.builtin_tool import reply
  from unittest.mock import AsyncMock
  token=group_guard.TURN.set(self.turn['id']);self.addCleanup(group_guard.TURN.reset,token)
  runtime=SimpleNamespace(session_id='synthetic',log_prefix='[synthetic]',record_planner_reply=Mock())
  ctx=SimpleNamespace(runtime=runtime,build_success_result=Mock(return_value=SimpleNamespace()),build_failure_result=Mock(side_effect=AssertionError('Unexpected send failure')))
  mid='bowxt-in-turn-'+self.turn['id']
  with patch.object(group_guard,'policy',return_value=self.p),patch.object(group_guard,'authorize_fast_reply',return_value=True),patch.object(reply.send_service,'_send_to_target_with_message',new=AsyncMock(return_value=SimpleNamespace())) as send:
   result=asyncio.run(reply.execute_reply(ctx,{'msg_id':mid,'reply_text':'你好！','reply_reference':'synthetic','wait_apology':'抱歉久等，刚才绕了个弯。'},call_id='synthetic',target_message=SimpleNamespace(message_id=mid)))
  self.assertTrue(result.stop_after_execution);send.assert_awaited_once()
  self.assertEqual(send.call_args.kwargs['processed_plain_text'],'你好！')
  with self.p.db() as db:self.assertEqual(db.execute('SELECT wait_apology FROM turns').fetchone()[0],'抱歉久等，刚才绕了个弯。')
 def bridge_module(self):
  path=Path(os.environ.get('GT_TEST_BRIDGE','/bridge/app.py'))
  spec=importlib.util.spec_from_file_location('synthetic_latency_bridge',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  return module
 def outgoing(self,elapsed,text):
  m=self.bridge_module();bridge=object.__new__(m.Bridge);bridge.policy=self.p
  bridge.chats={1:SimpleNamespace(id=1,name='Synthetic group')};bridge.control=lambda:{'enabled':True,'send_enabled':True}
  bridge.ledger=m.Ledger(Path(self.tmp.name)/'delivery.sqlite3');bridge.send_lock=asyncio.Lock()
  bridge.health={'verified_sends':0};bridge.agent=SimpleNamespace(send_text=Mock(return_value=SimpleNamespace()),wait_delivery=Mock(return_value=SimpleNamespace(delivery_status='sent',seq=2)))
  packet=m.incoming_packet(SimpleNamespace(chat_id=1,direction='incoming',message_type='text',sender='Synthetic member',timestamp=None,seq='synthetic',content='synthetic'),1,'Synthetic group')
  packet.message_segment=m.Seg('text',text);packet.message_info.additional_config['gt_limit_turn']=self.turn['id']
  self.now=1793502000.+elapsed
  import traceback
  with patch.object(m.LOG,'error',side_effect=lambda *args:traceback.print_exc()):
   asyncio.run(bridge.outgoing(packet))
  return bridge,packet
 def test_real_bridge_fast_send_has_no_apology(self):
  bridge,_=self.outgoing(299.9,'这是正文。');bridge.agent.send_text.assert_called_once()
  self.assertEqual(bridge.agent.send_text.call_args.args[1],'这是正文。')
 def test_real_bridge_late_send_is_one_message_and_duplicate_is_suppressed(self):
  bridge,packet=self.outgoing(301,'这是正文。');bridge.agent.send_text.assert_called_once()
  text=bridge.agent.send_text.call_args.args[1];self.assertTrue(text.startswith('抱歉久等'));self.assertTrue(text.endswith('这是正文。'))
  asyncio.run(bridge.outgoing(packet));bridge.agent.send_text.assert_called_once()
  with self.p.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM sends').fetchone()[0],1)
 def test_native_provider_accepts_the_new_request_timeout(self):
  from src.config.model_configs import APIProvider
  p=APIProvider(name='isolated',base_url='https://example.invalid',api_key='synthetic',client_type='gemini',timeout=310,max_retry=2)
  self.assertEqual(p.timeout,310)
 def test_replyer_remains_admitted_after_a_300_second_planner(self):
  import group_guard
  from src.llm_models.model_client.base_client import ResponseRequest
  from src.config.model_configs import ModelInfo
  # Use an ordinary direct question, whose Replyer is allowed.
  with self.p.db() as db:db.execute('UPDATE turns SET greeting=0 WHERE id=?',(self.turn['id'],))
  def request():
   return ResponseRequest(model_info=ModelInfo(name='synthetic',model_identifier='synthetic',api_provider='synthetic',model_type='llm'),context_items=[ContextItemBuilder().add_text_content('[GT_REQUEST_ID:'+self.turn['id']+']').build()],max_tokens=768)
  async def exercise():
   group_guard.TURN.set(None)
   with patch.object(group_guard,'policy',return_value=self.p):
    async with group_guard.guarded_attempt('planner','synthetic',request()) as attempt:
     self.now+=300;attempt.record(SimpleNamespace(total_tokens=30))
    async with group_guard.guarded_attempt('replyer','synthetic',request()) as attempt:
     attempt.record(SimpleNamespace(total_tokens=30))
  asyncio.run(exercise());self.assertEqual(self.p.snapshot()['model_calls_today'],2)

if __name__=='__main__':unittest.main()
