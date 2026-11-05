import copy
from datetime import datetime,timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as N
import unittest

from chatlog_reader.store import Store
from chatlog_runtime import ReaderAgent,ReaderUnavailable,OFFSET

NOW=1793600000.0
EPOCH='a'*32

def row(seq=1,chat=1,**extra):
    return dict(seq=seq,chat_id=chat,content='摸鱼',sender='Alice',sender_id='wxid_alice',
        source_at=NOW+1,observed_at=NOW+2,is_self=0,msg_type=1,server_id=str(seq),is_summary=0,**extra)

class Source:
    def __init__(self):
        self.rows=[];self.epoch=EPOCH;self.calls=[]
    def request(self,path,query):
        self.calls.append((path,dict(query)))
        rows=[dict(r) for r in self.rows if r['chat_id']==query['chat']]
        base={'epoch':self.epoch,'last_checked':NOW,'watermark':max([r['seq'] for r in rows],default=0),'next_after':None}
        if query['after']=='tail':return {**base,'messages':[],'cutover_at':NOW}
        rows=[r for r in rows if r['seq']>query['after']]
        if path=='/v1/history':rows=[r for r in rows if query['start']<=r['source_at']<query['end']]
        return {**base,'messages':rows}

class CursorTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.source=Source();self.now=NOW
        self.delegate=N(consumer='maibot-gt',claim=lambda **_:self.fail('UI ingress must not be used'),send_text=lambda *a,**k:'original-send')
        self.agent=self.make_agent()
    def make_agent(self):
        agent=ReaderAgent(self.delegate,self.tmp.name,'http://chatlog-reader:5030','/not-used',clock=lambda:self.now)
        agent.request=self.source.request
        return agent
    def prepare(self):self.agent.claim(chat_ids=[1])
    def test_initial_history_is_not_replayed(self):
        self.source.rows=[row(1),row(2)]
        self.assertEqual(self.agent.claim(chat_ids=[1]),[])
        self.assertEqual(self.agent.cursor(1)['after_seq'],2)
    def test_identical_text_by_different_people_is_not_deduplicated(self):
        self.prepare();self.source.rows=[row(1),{**row(2),'sender':'Bob','sender_id':'wxid_bob'}]
        first=self.agent.claim(chat_ids=[1])[0];self.agent.ack(first)
        second=self.agent.claim(chat_ids=[1])[0]
        self.assertEqual(first.message.content,second.message.content)
        self.assertNotEqual(first.message.seq,second.message.seq)
        self.assertNotEqual(first.message.sender_id,second.message.sender_id)
        self.assertGreater(first.message.seq,OFFSET)
    def test_nack_does_not_skip_to_later_message(self):
        self.prepare();self.source.rows=[row(1),row(2)]
        first=self.agent.claim(chat_ids=[1])[0];self.agent.nack(first,'synthetic',retry_delay=10)
        self.assertEqual(self.agent.claim(chat_ids=[1]),[])
        self.now+=11
        self.assertEqual(self.agent.claim(chat_ids=[1])[0].message.source_seq,1)
    def test_ack_rejects_other_consumers_and_out_of_order_records(self):
        self.prepare();self.source.rows=[row(1)]
        first=self.agent.claim(chat_ids=[1])[0]
        other=copy.deepcopy(first);other.consumer='another'
        with self.assertRaises(ValueError):self.agent.ack(other)
        other=copy.deepcopy(first);other.message.source_seq=2
        with self.assertRaises(ValueError):self.agent.ack(other)
    def test_restart_retains_progress_and_namespace(self):
        self.prepare();self.source.rows=[row(1),row(2)]
        first=self.agent.claim(chat_ids=[1])[0];self.agent.ack(first)
        other=self.make_agent();second=other.claim(chat_ids=[1])[0]
        self.assertEqual(second.message.source_seq,2)
        self.assertEqual(other.namespace(EPOCH),self.agent.namespace(EPOCH))
    def test_archive_epoch_change_uses_fresh_tail_and_distinct_ids(self):
        self.prepare();self.source.rows=[row(1)]
        old=self.agent.claim(chat_ids=[1])[0];self.agent.ack(old)
        self.source.epoch='b'*32
        self.assertEqual(self.agent.claim(chat_ids=[1]),[])
        self.source.rows.append(row(2))
        new=self.agent.claim(chat_ids=[1])[0]
        self.assertNotEqual(new.message.seq-old.message.seq,1)
    def test_late_imported_history_and_own_messages_do_not_trigger_bot(self):
        self.prepare()
        self.source.rows=[{**row(1),'source_at':NOW-100},{**row(2),'is_self':1},row(3)]
        delivery=self.agent.claim(chat_ids=[1])[0]
        self.assertEqual(delivery.message.source_seq,3)
    def test_history_and_live_use_the_same_database_source(self):
        self.prepare();self.source.rows=[row(1)]
        delivery=self.agent.claim(chat_ids=[1])[0]
        history=self.agent.get_history(N(id=1),duration_seconds=20,until=datetime.fromtimestamp(NOW+10,timezone.utc))
        self.assertEqual(history[0].seq,delivery.message.seq)
        self.assertEqual(history[0].timestamp,delivery.message.timestamp)
        self.assertEqual(history[0].source_kind,'wechat_database')
    def test_unavailable_source_never_silently_falls_back_to_ui(self):
        self.prepare()
        self.agent.request=lambda *_:(_ for _ in ()).throw(ReaderUnavailable())
        with self.assertRaises(ReaderUnavailable):self.agent.claim(chat_ids=[1])
    def test_sends_are_delegated_without_a_new_delivery_path(self):
        self.assertEqual(self.agent.send_text(1,'Synthetic'), 'original-send')
    def test_history_cross_group_and_replay_requests_are_rejected(self):
        with self.assertRaises(ValueError):self.agent.claim(chat_ids=[1],replay_existing=True)
        with self.assertRaises(ReaderUnavailable):self.agent.message(row(chat=2),1,EPOCH)
    def test_resume_tail_only_skips_old_live_messages_and_preserves_other_cursor_and_history(self):
        self.prepare();self.source.rows=[row(1),row(2)]
        with self.agent.db() as db:db.execute('INSERT INTO reader_cursors(chat_id,epoch,after_seq,cutover) VALUES(?,?,?,?)',(2,EPOCH,40,NOW))
        # Source fixture normally emits cutover_at only for tail requests.
        self.agent.reset_live_cursors([1])
        self.assertEqual(self.agent.cursor(1)['after_seq'],2)
        with self.agent.db() as db:self.assertEqual(db.execute('SELECT after_seq FROM reader_cursors WHERE chat_id=2').fetchone()[0],40)
        self.source.rows.append(row(3));delivery=self.agent.claim(chat_ids=[1])[0]
        self.assertEqual(delivery.message.source_seq,3)
        history=self.agent.get_history(1,duration_seconds=20,until=datetime.fromtimestamp(NOW+10,timezone.utc))
        self.assertEqual(len(history),3)

    def test_missing_names_remain_missing_in_history(self):
        self.source.rows=[{**row(1),'sender':None}]
        history=self.agent.get_history(1,duration_seconds=20,until=datetime.fromtimestamp(NOW+10,timezone.utc))
        self.assertIsNone(history[0].sender)
        live=self.agent.message(self.source.rows[0],1,EPOCH,live=True)
        self.assertTrue(live.sender.startswith('昵称未同步-'))

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'archive.db','synthetic-account',[{'chat_id':1,'name':'A'},{'chat_id':2,'name':'B'}])
    def record(self,key='one',chat=1,at=NOW):
        return dict(native_key=key,chat_id=chat,sender_id='native-a',sender='Alice',content='Synthetic',
            source_at=at,observed_at=NOW,is_self=0,msg_type=1,server_id=key,is_summary=0)
    def test_scope_and_native_identity_are_enforced(self):
        with self.assertRaises(KeyError):self.store.page(9,0)
        self.store.ingest('shard',1,[self.record()],1)
        with self.assertRaises(ValueError):self.store.ingest('shard',2,[self.record(chat=2)],1)
        self.assertEqual(self.store.counts(),{'1':1,'2':0})
    def test_updating_names_does_not_change_first_observation_or_sequence(self):
        self.store.ingest('shard',1,[self.record()],1)
        old=self.store.page(1,0)['messages'][0]
        self.store.ingest('shard',1,[{**self.record(),'sender':'New display','observed_at':NOW+100}],1)
        new=self.store.page(1,0)['messages'][0]
        self.assertEqual((new['seq'],new['observed_at']),(old['seq'],old['observed_at']))
    def test_half_open_history_and_pagination_have_no_holes(self):
        self.store.ingest('s',1,[self.record(str(i),at=NOW+i) for i in range(4)],4)
        page=self.store.page(1,0,1,start=NOW+1,end=NOW+3)
        second=self.store.page(1,page['next_after'],1,start=NOW+1,end=NOW+3)
        self.assertEqual([page['messages'][0]['source_at'],second['messages'][0]['source_at']],[NOW+1,NOW+2])
        self.assertIsNone(second['next_after'])
    def test_repeated_refresh_does_not_consume_message_sequence_numbers(self):
        for _ in range(5):self.store.ingest('s',1,[self.record()],1)
        self.store.ingest('s',1,[self.record('two')],2)
        self.assertEqual([r['seq'] for r in self.store.page(1,0)['messages']],[1,2])
    def test_account_switch_does_not_reuse_an_existing_archive(self):
        with self.assertRaises(ValueError):Store(Path(self.tmp.name)/'archive.db','another-account',[{'chat_id':1,'name':'A'}])

if __name__=='__main__':unittest.main()
