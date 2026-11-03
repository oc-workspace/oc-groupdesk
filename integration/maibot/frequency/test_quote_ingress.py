"""Verified reader reference flags flow through the real native admission gates."""
import copy,tempfile,unittest
from datetime import datetime
from types import SimpleNamespace as N
from policy import Policy,settings
from chatlog_runtime import ReaderAgent,ReaderUnavailable
from test_reply_limits import bundle
import reply_frequency

class QuotedIngress(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1793430000.
  self.cfg=settings();b=bundle(self.now);b.update(reply_frequency_contract_version=1,reply_frequency={'revision':1,'policy':copy.deepcopy(reply_frequency.DEFAULTS)});b['valid_until']=self.now+10000;self.cfg['managed_groups']={'1':b}
  self.p=Policy(self.tmp.name+'/policy',self.cfg,lambda:self.now);self.a=ReaderAgent(N(consumer='synthetic'),self.tmp.name,'http://chatlog-reader:5030','unused')
 def message(self,bot=True,**change):
  row={'seq':1,'chat_id':1,'content':'这句话我有不同意见','sender':'Synthetic member','sender_id':'synthetic-member','source_at':self.now,'observed_at':self.now,'is_self':0,'msg_type':49,'server_id':'200','is_summary':0,'reference':{'kind':'text_reply','server_id':'100','is_bot':bot,'bot_text':'A previous reply.'},**change}
  return self.a.message(row,1,'a'*32,live=True)
 def ingest(self,m):return self.p.ingest(m.seq,m.sender,m.content,datetime.fromisoformat(m.timestamp).timestamp(),m.is_at_me,chat_id=str(m.chat_id))
 def test_verified_quote_without_name_becomes_explicit_direct_request(self):
  m=self.message();self.assertTrue(m.is_at_me);self.assertEqual(self.ingest(m),'queued');self.now+=4;turn=self.p.dispatch();self.assertEqual(turn['chat_id'],'1');self.assertTrue(turn['explicit']);self.assertEqual(turn['kind'],'direct')
 def test_other_members_quote_does_not_gain_mention_permission(self):
  m=self.message(bot=False);self.assertFalse(m.is_at_me);self.assertNotIn('A previous reply.',m.content);self.assertEqual(self.ingest(m),'filtered')
 def test_verified_quote_obeys_shared_frequency_and_uses_bounded_catchup(self):
  self.cfg['managed_groups']['1']['reply_frequency']['policy']['windows']=[{'minutes':1,'max_replies':1}]
  with self.p.db() as db:db.execute('INSERT INTO turns(id,sender,kind,created,expires,status,article,chat_id) VALUES("older","other","direct",?,? ,"sent",0,"1")',(self.now,self.now+1))
  self.assertEqual(self.ingest(self.message()),'frequency_waiting');self.now+=61;turn=self.p.dispatch();self.assertTrue(turn['explicit']);self.assertEqual(turn['expires'],1793430600.)
 def test_expired_quote_does_not_become_fresh_input(self):
  m=self.message(source_at=self.now-1000);self.assertEqual(self.ingest(m),'expired')
 def test_cross_group_reader_row_is_rejected(self):
  with self.assertRaises(ReaderUnavailable):self.message(chat_id=2)

if __name__=='__main__':unittest.main()
