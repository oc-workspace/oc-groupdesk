import unittest,uuid
from unittest.mock import patch
from agent import Agent
class Fake(Agent):
 def __init__(self,statuses):self.statuses=iter(statuses);self.calls=[];self.reports=[]
 def api(self,path,body):self.reports.append(body);return {}
 def local(self,task):self.calls.append(task);return {'greeting_status':next(self.statuses),'chat_id':2,'external_id':'synthetic:2'}
class ReceiptTests(unittest.TestCase):
 def task(self,**kw):return {'id':str(uuid.uuid4()),'kind':'greeting','lease_token':str(uuid.uuid4()),'external_id':'synthetic:2',**kw}
 def test_reserved_and_uncertain_receipts_are_waited_on_without_another_enqueue(self):
  a=Fake(['queued','uncertain','sent'])
  with patch('agent.time.sleep'):a.run_one(self.task())
  self.assertEqual([c['kind'] for c in a.calls],['greeting','greeting_status','greeting_status']);self.assertEqual(a.reports[-1]['status'],'succeeded');self.assertEqual(a.reports[-1]['result']['greeting_status'],'sent')
 def test_late_success_reconciliation_uses_only_the_read_only_operation(self):
  a=Fake(['sent']);a.run_one(self.task(receipt_only=True));self.assertEqual([c['kind'] for c in a.calls],['greeting_status']);self.assertEqual(a.reports[-1]['status'],'succeeded')
 def test_still_uncertain_reconciliation_does_not_loop_or_enqueue(self):
  a=Fake(['uncertain']);a.run_one(self.task(receipt_only=True));self.assertEqual([c['kind'] for c in a.calls],['greeting_status']);self.assertEqual(a.reports[-1]['error_code'],'greeting_pending')
 def test_expired_wait_reports_pending_and_never_claims_success(self):
  a=Fake(['queued'])
  with patch('agent.time.monotonic',side_effect=[0,481]):a.run_one(self.task())
  self.assertEqual(a.reports[-1]['error_code'],'greeting_pending');self.assertEqual([c['kind'] for c in a.calls],['greeting'])
 def test_retry_generation_is_preserved_for_enqueue_and_read_only_receipts(self):
  a=Fake(['queued','sent']);task=self.task(retry_generation=1)
  with patch('agent.time.sleep'):a.run_one(task)
  self.assertEqual([c['retry_generation'] for c in a.calls],[1,1]);self.assertEqual(a.reports[-1]['status'],'succeeded')
  b=Fake(['sent']);b.run_one(self.task(retry_generation=2,receipt_only=True))
  self.assertEqual(b.calls[0]['retry_generation'],2);self.assertEqual(b.calls[0]['kind'],'greeting_status')
if __name__=='__main__':unittest.main()
