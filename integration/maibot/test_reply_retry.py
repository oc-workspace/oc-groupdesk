"""One generation retry uses real admission accounting, never a real provider."""
import asyncio,unittest
from types import SimpleNamespace
import group_guard
import test_guard_integration as guard_tests
from src.llm_models.exceptions import ReqAbortException

class ReplyRetryTests(unittest.IsolatedAsyncioTestCase):
 asyncSetUp=guard_tests.GuardIntegrationTests.asyncSetUp
 turn=guard_tests.GuardIntegrationTests.turn
 request=guard_tests.GuardIntegrationTests.request
 async def test_timeout_then_retry_consumes_slots_without_extending_deadline(self):
  self.p.cfg['calls_per_turn']=5;self.p.cfg['task_calls_per_turn']['replyer']=2
  t=self.turn();deadline=t['expires']
  async def attempt(task):
   async with group_guard.guarded_attempt(task,'maisaka.'+task,self.request('[GT_REQUEST_ID:'+t['id']+']')) as a:a.record(SimpleNamespace(total_tokens=100))
  await attempt('planner')
  with self.assertRaises(ReqAbortException):
   async with group_guard.guarded_attempt('replyer','maisaka.replyer',self.request('[GT_REQUEST_ID:'+t['id']+']')):raise TimeoutError('synthetic timeout')
  self.now+=60
  await attempt('planner');await attempt('replyer')
  with self.assertRaises(ReqAbortException):await attempt('replyer')
  await attempt('utils')
  with self.assertRaises(ReqAbortException):await attempt('fast_model')
  self.assertEqual(self.p.snapshot()['model_calls_today'],5)
  self.assertEqual(self.p.active_turn()['expires'],deadline)
  self.assertEqual(self.p.snapshot()['unreported_attempts_today'],1)

if __name__=='__main__':unittest.main()
