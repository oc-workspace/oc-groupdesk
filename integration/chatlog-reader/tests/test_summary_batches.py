import tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone
from types import SimpleNamespace as N
from chatlog_reader.store import Store
from chatlog_runtime import ReaderAgent,ReaderUnavailable

START=1793635200.0;END=START+86400
class SummaryBatchTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.store=Store(Path(self.tmp.name)/'archive.db','synthetic',[{'chat_id':1,'name':'A'},{'chat_id':2,'name':'B'}])
  self.agent=ReaderAgent(N(consumer='synthetic'),self.tmp.name,'http://chatlog-reader:5030','unused',clock=lambda:END+1)
  self.requests=[]
  def request(path,q):
   self.requests.append((path,dict(q)))
   if path.endswith('/stats'):return {**self.store.summary_stats(q['chat'],q['start'],q['end']),'messages':[],'last_checked':END}
   return {**self.store.page(q['chat'],q['after'],q['limit'],q['start'],q['end'],through=q['through'],summary=True),'last_checked':END}
  self.agent.request=request
 def row(self,seq,**kw):
  return dict(native_key=str(seq),chat_id=1,sender_id='synthetic-a',sender='A',content='Synthetic😀',source_at=START+seq,observed_at=START+seq+1,is_self=0,msg_type=1,server_id=str(seq),is_summary=0,**kw)
 def plan(self):return self.agent.summary_plan(1,duration_seconds=86400,until=datetime.fromtimestamp(END,timezone.utc))
 def test_preflight_filters_sources_and_reads_979_rows_without_touching_live_cursors(self):
  self.store.ingest('s',1,[self.row(i) for i in range(1,980)],979)
  self.store.ingest('s',1,[{**self.row(980),'is_summary':1},{**self.row(981),'is_self':1,'server_id':None}],981)
  plan=self.plan();self.assertEqual(plan['count'],979);self.assertEqual(plan['text_chars'],979*len('Synthetic😀'))
  self.assertEqual(plan['planned_batches'],5)
  self.store.ingest('s',1,[self.row(982)],982)
  pages=list(self.agent.summary_pages(1,plan));self.assertEqual(len(pages),5);self.assertEqual(sum(map(len,pages)),979)
  self.assertEqual(len({m.source_seq for page in pages for m in page}),979)
  with self.agent.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM reader_cursors').fetchone()[0],0)
  self.assertEqual(self.requests[0][0],'/v1/history/stats')
 def test_long_average_posts_reduce_page_size_before_reading(self):
  self.store.ingest('s',1,[{**self.row(i),'content':'x'*12000} for i in range(1,12)],11)
  plan=self.plan();self.assertLess(plan['page_limit'],200);self.assertGreater(plan['planned_batches'],1)
 def test_mismatched_count_and_epoch_fail_instead_of_truncating(self):
  self.store.ingest('s',1,[self.row(1)],1);plan=self.plan();plan['count']=2
  with self.assertRaises(ReaderUnavailable):list(self.agent.summary_pages(1,plan))
  plan=self.plan();plan['epoch']='b'*32
  with self.assertRaises(ReaderUnavailable):list(self.agent.summary_pages(1,plan))
 def test_cross_group_or_changed_text_is_refused(self):
  self.store.ingest('s',1,[self.row(1)],1);plan=self.plan()
  with self.assertRaises(ReaderUnavailable):list(self.agent.summary_pages(2,plan))
  self.store.ingest('s',1,[{**self.row(1),'content':'Changed'}],1)
  with self.assertRaises(ReaderUnavailable):list(self.agent.summary_pages(1,plan))
 def test_window_is_half_open_and_count_has_no_message_body(self):
  self.store.ingest('s',1,[{**self.row(1),'source_at':START},{**self.row(2),'source_at':END}],2)
  result=self.store.summary_stats(1,START,END);self.assertEqual(result['count'],1);self.assertNotIn('messages',result)
  with self.assertRaises(KeyError):self.store.summary_stats(3,START,END)
