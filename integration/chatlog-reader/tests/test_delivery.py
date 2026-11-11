from dataclasses import dataclass,replace
from datetime import datetime,timezone
from pathlib import Path
import tempfile,unittest

from chatlog_runtime import ReaderAgent,ReaderUnavailable
from test_contract import Source,row,NOW,EPOCH

@dataclass(frozen=True,slots=True)
class Receipt:
    seq:int
    chat_id:int
    content:str
    client_id:str
    timestamp:str
    direction:str='outgoing'
    message_type:str='text'
    delivery_status:str='pending'
    verified:bool=False
    delivery_error:str|None=None

class Sender:
    consumer='synthetic-consumer'
    def __init__(self,clock):self.clock=clock;self.sent=[];self.status='unverified';self.overrides={};self.error=None
    def send_text(self,chat,text,**kwargs):
        q=Receipt(len(self.sent)+100,chat,text,kwargs['client_id'],datetime.fromtimestamp(self.clock(),timezone.utc).isoformat())
        self.sent.append(q);return q
    def send_native_quote(self,chat,target_server_id,target_text,text,**kwargs):
        return self.send_text(chat,text,**kwargs)
    def wait_delivery(self,message,**kwargs):
        if self.error:raise self.error
        return replace(message,**{'delivery_status':self.status,**self.overrides})

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=NOW;self.delays=[];self.on_sleep=None
        self.source=Source();self.sender=Sender(lambda:self.now);self.agent=self.make_agent()
    def request(self,path,query):
        v=self.source.request(path,query)
        if query['after']=='tail':v['cutover_at']=self.now
        return v
    def sleep(self,delay):
        self.delays.append(delay);self.now+=delay
        if self.on_sleep:self.on_sleep()
    def make_agent(self):
        a=ReaderAgent(self.sender,self.tmp.name,'http://chatlog-reader:5030','/unused',clock=lambda:self.now,sleeper=self.sleep)
        a.request=self.request;return a
    def send(self,text='Synthetic reply',chat=1):
        return self.agent.send_text(chat,text,client_id='synthetic-'+str(len(self.sender.sent)))
    def confirmed(self,seq=1,text='Synthetic reply',**overrides):
        return {**row(seq),**{'is_self':1,'content':text,'source_at':self.now+1,'observed_at':self.now+2},**overrides}
    def test_source_confirmation_preserves_ui_sender_and_original_receipt(self):
        q=self.send();self.source.rows=[self.confirmed()];self.now+=3
        result=self.agent.wait_delivery(q)
        self.assertEqual(result.delivery_status,'sent');self.assertTrue(result.verified)
        self.assertEqual(self.sender.wait_delivery(q).delivery_status,'unverified');self.assertEqual(len(self.sender.sent),1)
        with self.agent.db() as db:
            proof=dict(db.execute('SELECT * FROM reader_send_checks').fetchone())
        self.assertEqual((proof['ui_status'],proof['source_seq'],proof['server_id']),('unverified',1,'1'))
        self.assertNotIn('Synthetic reply',str(proof))
        self.assertTrue(all(path=='/v1/stream' for path,_ in self.source.calls))
    def test_verified_ui_send_needs_independent_reader_id_before_it_can_be_quoted(self):
        self.sender.status='sent';q=self.send();receipt=self.agent.wait_delivery(q)
        self.assertIsNone(self.agent.confirmed_send_reference(receipt))
        self.source.rows=[self.confirmed()];self.now+=3
        proof=self.agent.confirmed_send_reference(receipt)
        self.assertEqual((proof['epoch'],proof['seq'],proof['server_id']),(EPOCH,1,'1'))
        self.assertEqual(self.agent.confirmed_send_reference(receipt),proof)
    def test_ambiguous_reader_rows_never_yield_a_quote_reference(self):
        self.sender.status='sent';q=self.send();self.source.rows=[self.confirmed(1),self.confirmed(2)];self.now+=3
        self.assertIsNone(self.agent.confirmed_send_reference(self.agent.wait_delivery(q)))
    def test_native_quote_requires_reader_reference_to_exact_target(self):
        original=self.agent.request
        self.agent.request=lambda path,query:{'target':{'content':'Original summary','server_id':'103','unique_text':True}} if path=='/v1/reference' else original(path,query)
        q=self.agent.send_native_quote(1,'103','Original summary','Already summarized',client_id='synthetic-quote')
        receipt=self.sender.wait_delivery(q)
        quoted={**self.confirmed(content='Already summarized',msg_type=49),
            'reference':{'kind':'text_reply','server_id':'103'}}
        self.source.rows=[quoted];self.now+=3
        self.assertIsNone(self.agent.confirmed_native_quote(receipt,'104'))
        self.assertEqual(self.agent.confirmed_native_quote(receipt,'103'),{'seq':1,'server_id':'1'})
    def test_native_quote_does_not_confirm_a_plain_text_send(self):
        original=self.agent.request
        self.agent.request=lambda path,query:{'target':{'content':'Original summary','server_id':'103','unique_text':True}} if path=='/v1/reference' else original(path,query)
        q=self.agent.send_native_quote(1,'103','Original summary','Already summarized',client_id='synthetic-quote')
        self.source.rows=[self.confirmed(content='Already summarized')];self.now+=3
        self.assertIsNone(self.agent.confirmed_native_quote(self.sender.wait_delivery(q),'103'))
    def test_ambiguous_quote_target_is_rejected_before_ui_send(self):
        self.agent.request=lambda path,query:{'target':{'content':'Original summary','server_id':'103','unique_text':False}}
        with self.assertRaises(ReaderUnavailable):
            self.agent.send_native_quote(1,'103','Original summary','Already summarized',client_id='synthetic-quote')
        self.assertEqual(self.sender.sent,[])
    def test_missing_pending_server_ack_and_wrong_source_rows_remain_unverified(self):
        cases=[{'is_self':0},{'msg_type':3},{'server_id':None},{'content':'Other reply'},
               {'source_at':NOW-50},{'source_at':NOW+10000},{'observed_at':NOW-50},{'source_at':float('nan')}]
        for override in cases:
            with self.subTest(override=override):
                self.source.rows=[];q=self.send();r=self.confirmed(**override);self.source.rows=[r];self.now+=3
                self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
        self.assertEqual(len(self.sender.sent),len(cases))
    def test_changed_epoch_or_cross_group_response_never_confirms(self):
        q=self.send();self.source.rows=[self.confirmed()];self.now+=3;self.source.epoch='b'*32
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
        self.source.epoch=EPOCH;old=self.agent.request
        def corrupt(path,query):
            result=old(path,query);result['messages']=[{**r,'chat_id':2} for r in result['messages']];return result
        self.agent.request=corrupt
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
    def test_receipt_identity_mismatch_cannot_borrow_a_confirmation(self):
        q=self.send();self.source.rows=[self.confirmed()];self.now+=3
        for override in [{'chat_id':2},{'client_id':'other'},{'content':'Other'},{'seq':999},{'direction':'incoming'}]:
            with self.subTest(override=override):
                self.sender.overrides=override
                self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
        self.assertEqual(len(self.sender.sent),1)
    def test_no_anchor_and_failed_pending_or_timeout_receipts_are_not_promoted(self):
        q=self.sender.send_text(1,'Synthetic reply',client_id='outside-wrapper');self.source.rows=[self.confirmed()];self.now+=3
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
        q=self.send()
        for status in ['failed','pending','sent']:
            self.sender.status=status;self.assertEqual(self.agent.wait_delivery(q).delivery_status,status)
        self.sender.error=TimeoutError('still pending')
        with self.assertRaises(TimeoutError):self.agent.wait_delivery(q)
        self.assertEqual(len(self.sender.sent),2)
    def test_one_native_message_cannot_confirm_two_ui_jobs(self):
        first=self.send();second=self.send();self.source.rows=[self.confirmed()];self.now+=3
        self.assertEqual(self.agent.wait_delivery(first).delivery_status,'sent')
        self.assertEqual(self.agent.wait_delivery(second).delivery_status,'unverified')
    def test_older_ui_verified_send_without_native_identity_cannot_be_borrowed(self):
        first=self.send();self.sender.status='sent'
        self.assertEqual(self.agent.wait_delivery(first).delivery_status,'sent')
        second=self.send();self.source.rows=[self.confirmed()];self.now+=3;self.sender.status='unverified'
        self.assertEqual(self.agent.wait_delivery(second).delivery_status,'unverified')
    def test_ambiguous_matching_native_messages_do_not_confirm(self):
        q=self.send();self.source.rows=[self.confirmed(1),self.confirmed(2)];self.now+=3
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
    def test_existing_identical_message_before_send_is_excluded(self):
        self.source.rows=[self.confirmed()];q=self.send();self.now+=3
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
    def test_late_observation_of_an_older_send_cannot_confirm_a_new_send(self):
        self.now=NOW+.8;q=self.send()
        self.source.rows=[self.confirmed(source_at=NOW)];self.now+=3
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')
    def test_confirmation_survives_restart_without_reusing_live_cursors(self):
        self.agent.cursor(1);before=self.agent.cursor(1)
        q=self.send();self.source.rows=[self.confirmed()];self.now+=3
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'sent')
        self.source.rows=[];restarted=self.make_agent()
        self.assertEqual(restarted.wait_delivery(q).delivery_status,'sent');self.assertEqual(restarted.cursor(1),before)
    def test_late_event_is_checked_only_after_unverified_send_with_a_fixed_bound(self):
        q=self.send();self.now+=3
        self.on_sleep=lambda:self.source.rows.append(self.confirmed()) if not self.source.rows else None
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'sent')
        self.assertEqual(self.delays,[.25])
    def test_source_failure_does_not_resend_or_replace_the_ui_sender(self):
        self.agent.request=lambda *_:(_ for _ in ()).throw(ReaderUnavailable())
        q=self.send();self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified');self.assertEqual(len(self.sender.sent),1)
    def test_expired_check_is_not_used_for_a_historical_message(self):
        q=self.send();self.source.rows=[self.confirmed()];self.now+=181
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified');self.assertEqual(self.delays,[])
    def test_all_pages_are_checked_before_unique_confirmation(self):
        q=self.send();self.source.rows=[self.confirmed(1),{**row(2),'content':'Other'},self.confirmed(3)];self.now+=3
        original=self.agent.request
        def paginated(path,query):
            value=original(path,query);rows=value['messages'];value['messages']=rows[:2]
            value['next_after']=rows[1]['seq'] if len(rows)>2 else None;return value
        self.agent.request=paginated
        self.assertEqual(self.agent.wait_delivery(q).delivery_status,'unverified')

if __name__=='__main__':unittest.main()
