import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from chatlog_reader.engine import Engine

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.account='wxid_self_test'
        self.storage=self.root/'source'/self.account/'db_storage'
        (self.storage/'contact').mkdir(parents=True);(self.storage/'message').mkdir()
        self.groups=[{'chat_id':1,'name':'Synthetic A'},{'chat_id':2,'name':'Synthetic B'}]
        connection=sqlite3.connect(self.storage/'contact/contact.db')
        connection.execute('CREATE TABLE contact(username TEXT,local_type INTEGER,nick_name TEXT,remark TEXT)')
        connection.executemany('INSERT INTO contact VALUES(?,?,?,?)',[
            ('native-a@chatroom',2,'Synthetic A',''),('native-b@chatroom',2,'Synthetic B',''),
            ('private@chatroom',2,'Private group',''),('wxid_self',1,'Bot',''),
            ('wxid_alice',1,'Alice','PRIVATE ANNOTATION'),('wxid_bob',1,'Bob','')])
        connection.commit();connection.close()
        self.message=self.storage/'message/message_0.db'
        connection=sqlite3.connect(self.message)
        connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
        connection.executemany('INSERT INTO Name2Id VALUES(?)',[(n,) for n in ['wxid_self','wxid_alice','wxid_bob','native-a@chatroom','native-b@chatroom','private@chatroom']])
        for native_id in ['native-a@chatroom','native-b@chatroom','private@chatroom']:
            table=self.table(native_id)
            connection.execute('CREATE TABLE '+table+'(local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content BLOB,server_id INTEGER,packed_info_data BLOB)')
        connection.commit();connection.close()
        self.add('native-a@chatroom',2,'wxid_alice:\n摸鱼',101)
        self.add('native-a@chatroom',3,'摸鱼',102)
        self.add('native-a@chatroom',1,'Own normal reply',103)
        self.add('native-b@chatroom',2,'Other authorized group',104)
        self.add('private@chatroom',2,'DO NOT INDEX THIS PRIVATE CONTENT',105)
        self.engine=Engine({'account':self.account,'groups':self.groups},self.root/'source',self.root/'state',self.root/'secrets')
        self.engine.key=b'x'*32
        self.engine.load_key=lambda:None
        def fixture_decrypt(source,_output):
            connection=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)
            connection.row_factory=sqlite3.Row
            return connection
        self.engine.decrypt=fixture_decrypt
    def table(self,native_id):return 'Msg_'+hashlib.md5(native_id.encode()).hexdigest()
    def add(self,group,sender,text,server):
        connection=sqlite3.connect(self.message)
        connection.execute('INSERT INTO '+self.table(group)+' VALUES(1,?,?,?,?,NULL)',(int(time.time())-10,sender,text,server))
        connection.commit();connection.close()
    def test_tail_is_memory_only_and_preserves_the_live_archive(self):
        from unittest.mock import patch
        self.engine.sync()
        before = self.engine.store.page(1,0,200)
        with patch.object(self.engine.store,'connect',side_effect=AssertionError('tail opened archive')), patch.object(self.engine,'decrypt',side_effect=AssertionError('tail decrypted raw database')), patch('chatlog_reader.engine.time.time',return_value=before['messages'][0]['observed_at']+1):
            tail = self.engine.tail(1)
        self.assertEqual(tail['watermark'],3)
        self.assertEqual(tail['epoch'],before['epoch'])
        self.assertEqual(tail['messages'],[])
        self.assertIsNone(tail['next_after'])
        self.assertEqual(before,self.engine.store.page(1,0,200))
    def test_tail_does_not_fail_on_an_oversized_first_historical_message(self):
        connection=sqlite3.connect(self.message)
        connection.execute('UPDATE '+self.table('native-a@chatroom')+' SET message_content=? WHERE server_id=101',('x'*2_600_000,))
        connection.commit();connection.close()
        self.engine.sync()
        with self.assertRaises(OverflowError):self.engine.page(1,0,1)
        self.assertEqual(self.engine.tail(1)['watermark'],3)
    def test_tail_rejects_unconfigured_groups_and_unhealthy_sources(self):
        self.engine.sync()
        with self.assertRaises(KeyError):self.engine.tail(999)
        self.engine.last_success=0
        with self.assertRaises(RuntimeError):self.engine.tail(1)
    def test_empty_group_tail_uses_its_own_cached_watermark(self):
        connection=sqlite3.connect(self.message)
        connection.execute('DELETE FROM '+self.table('native-b@chatroom'))
        connection.commit();connection.close()
        self.engine.sync()
        self.assertEqual(self.engine.tail(1)['watermark'],3)
        self.assertEqual(self.engine.tail(2)['watermark'],0)
    def test_indexer_excludes_unconfigured_conversations(self):
        self.engine.sync();self.assertTrue(self.engine.status()['ok'])
        self.assertEqual(self.engine.store.counts(),{'1':3,'2':1})
        with self.engine.store.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM messages WHERE content LIKE "%PRIVATE CONTENT%"').fetchone())
    def test_native_sender_prefix_is_removed_and_people_remain_distinct(self):
        self.engine.sync();rows=self.engine.page(1,0,200)['messages']
        self.assertEqual([r['content'] for r in rows[:2]],['摸鱼','摸鱼'])
        self.assertEqual([r['sender'] for r in rows[:2]],['Alice','Bob'])
        self.assertNotEqual(rows[0]['native_key'],rows[1]['native_key'])
        self.assertNotIn('PRIVATE ANNOTATION',json.dumps(rows))
    def test_own_messages_are_proven_by_the_verified_account_identity(self):
        self.engine.sync();rows=self.engine.page(1,0,200)['messages']
        self.assertEqual([r['is_self'] for r in rows],[0,0,1])
    def test_refresh_is_incremental_and_idempotent(self):
        self.engine.sync();before=self.engine.page(1,0,200)['messages']
        self.engine.sync();self.assertEqual(before,self.engine.page(1,0,200)['messages'])
        self.add('native-a@chatroom',3,'New message',106)
        self.engine.sync();after=self.engine.page(1,0,200)['messages']
        self.assertEqual(len(after),4)
        self.assertEqual([r['seq'] for r in before],[r['seq'] for r in after[:3]])
    def test_existing_row_enrichment_preserves_source_identity(self):
        self.engine.sync();old=self.engine.page(1,0,200)['messages'][0]
        connection=sqlite3.connect(self.message)
        connection.execute('UPDATE '+self.table('native-a@chatroom')+' SET message_content="Updated text" WHERE server_id=101')
        connection.commit();connection.close()
        self.engine.sync();new=self.engine.page(1,0,200)['messages'][0]
        self.assertEqual(new['seq'],old['seq']);self.assertEqual(new['observed_at'],old['observed_at'])
        self.assertEqual(new['content'],'Updated text')
    def test_ambiguous_group_names_fail_closed(self):
        connection=sqlite3.connect(self.storage/'contact/contact.db')
        connection.execute('INSERT INTO contact VALUES("ambiguous@chatroom",2,"Synthetic A","")')
        connection.commit();connection.close()
        self.engine.sync()
        self.assertFalse(self.engine.status()['ok'])
        self.assertEqual(self.engine.last_error,'group_mapping_ambiguous')
    def test_old_archive_is_not_served_as_current_after_a_long_failure(self):
        self.engine.sync();self.engine.last_success=time.time()-31
        with self.assertRaises(RuntimeError):self.engine.page(1,0,200)
    def test_summary_outputs_are_tagged_without_using_the_ui_archive(self):
        self.add('native-a@chatroom',1,'群聊存档总结 · "Synthetic A"\nA summary',107)
        self.engine.sync();rows=self.engine.page(1,0,200)['messages']
        self.assertEqual(rows[-1]['is_summary'],1)

if __name__=='__main__':unittest.main()
