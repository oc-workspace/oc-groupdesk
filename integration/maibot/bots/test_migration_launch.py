import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).with_name('migration_launch.py')


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        gd=types.ModuleType('groupdesk_runtime')
        gd.SNAPSHOT=root/'policy.json';gd.CONNECTION=root/'connection.json'
        gd.profile=lambda cfg,chat:cfg['managed_groups'].get(chat)
        gd.available=lambda profile,now:bool(profile and profile['enabled'])
        gd.api=lambda path:{'enabled':True,'activation_generation':2}
        names=types.ModuleType('bot_names')
        names.addressed=lambda cfg,chat,text:'@Tatsumi' in text
        mentions=types.ModuleType('reply_mention')
        mentions.member_name=lambda name:name if name and not name.startswith('昵称未同步') else None
        with patch.dict(sys.modules,{'groupdesk_runtime':gd,'bot_names':names,'reply_mention':mentions}):
            spec=importlib.util.spec_from_file_location('migration_launch_tested',SOURCE)
            self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.gd=gd
        self.plan={'id':'11111111-1111-4111-8111-111111111111','activation_generation':2,
            'greeting_groups':['shanghai'],'catchup_from':'2026-11-12T06:03:19Z',
            'catchup_through':'2026-11-13T06:03:19Z'}
        self.now=time.time()

    def test_greeting_is_deterministic_and_reserved_work_is_not_requeued(self):
        journal=self.module.Journal();journal.seed(self.plan,{'shanghai':7})
        first=journal.one(self.plan['id'],'greet','queued')
        self.assertIn('想',first['text'])
        journal.seed(self.plan,{'shanghai':7})
        self.assertEqual(first['text'],journal.one(self.plan['id'],'greet','queued')['text'])
        journal.change(first['id'],'reserved')
        self.assertIsNone(journal.one(self.plan['id'],'greet','queued'))

    def test_history_keeps_old_unanswered_mention_and_skips_native_answer(self):
        now=time.time();self.plan['catchup_from']=self.module.datetime.fromtimestamp(now-50000,self.module.timezone.utc).isoformat()
        self.plan['catchup_through']=self.module.datetime.fromtimestamp(now-100,self.module.timezone.utc).isoformat()
        rows=[
            {'chat_id':7,'seq':1,'source_at':now-40000,'is_self':0,'msg_type':1,'sender':'Alice','content':'@Tatsumi 想你啦','server_id':'101'},
            {'chat_id':7,'seq':2,'source_at':now-39000,'is_self':0,'msg_type':1,'sender':'Bob','content':'@Tatsumi 还在吗','server_id':'102'},
            {'chat_id':7,'seq':3,'source_at':now-38000,'is_self':1,'msg_type':1,'sender':'Tatsumi','content':'@Bob 在呢','reference_server_id':'102','server_id':'103'},
            {'chat_id':7,'seq':4,'source_at':now-37000,'is_self':0,'msg_type':1,'sender':'Carol','content':'普通聊天','server_id':'104'},
        ]
        class Agent:
            def request(self,route,query):
                if route.endswith('/stats'):return {'epoch':'a'*32,'through':4}
                return {'epoch':'a'*32,'messages':[r for r in rows if r['seq']>query['after']], 'next_after':None}
        bridge=types.SimpleNamespace(agent=Agent(),policy=types.SimpleNamespace(cfg={'managed_groups':{'7':{'enabled':True}}}))
        journal=self.module.Journal();journal.seed(self.plan,{'shanghai':7})
        self.module.scan(bridge,self.plan,journal,{'shanghai':7})
        job=journal.one(self.plan['id'],'catchup','queued')
        self.assertEqual(job['sender'],'Alice')
        self.assertEqual(job['source_seq'],1)
        self.assertEqual(journal.progress(self.plan)['catchup_scanned'],1)
        self.module.scan(bridge,self.plan,journal,{'shanghai':7})
        self.assertEqual(journal.progress(self.plan)['catchup_scanned'],1)

    def test_old_message_is_admitted_now_and_marked_for_strict_at(self):
        journal=self.module.Journal();journal.seed(self.plan,{'shanghai':7})
        job_id='catch:'+self.plan['id']+':7:source:1'
        with journal.db() as db:
            db.execute('INSERT INTO jobs(id,launch_id,kind,chat_id,external_id,source_seq,sender,text,source_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (job_id,self.plan['id'],'catchup',7,'shanghai',1,'Alice','@Tatsumi where were we?',self.now-86400,'queued'))
        path=Path(self.temp.name)/'policy.sqlite3'
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE pending(id TEXT,sender TEXT);CREATE TABLE turns(id TEXT,sender TEXT,status TEXT,expires REAL);')
        times=[]
        class Policy:
            cfg={};clock=staticmethod(time.time)
            @contextmanager
            def db(self):
                connection=sqlite3.connect(path);connection.row_factory=sqlite3.Row
                try:
                    with connection:yield connection
                finally:connection.close()
            def _quota(self,*args,**kwargs):return None
            def ingest(self,seq,sender,text,received,at_me,chat_id):
                times.append((received,at_me,chat_id,text))
                with self.db() as db:db.execute('INSERT INTO pending VALUES(?,?)',('a'*32,'7:'+self_hash(sender)))
                return 'queued'
        def self_hash(sender):
            import hashlib
            return hashlib.sha256(sender.encode()).hexdigest()[:24]
        bridge=types.SimpleNamespace(policy=Policy(),control=lambda:{'enabled':True,'send_enabled':True},
            health={'robot':{'state':'active','activation_generation':2}})
        self.module.enqueue(bridge,self.plan,journal,journal.one(self.plan['id'],'catchup','queued'))
        self.assertEqual(journal.one(self.plan['id'],'catchup','submitted')['turn_id'],'a'*32)
        self.assertTrue(times[0][1]);self.assertEqual(times[0][2],'7')
        self.assertGreater(times[0][0],self.now-5)
        with sqlite3.connect(path) as db:self.assertEqual(db.execute('SELECT turn_id FROM migration_backfill_turns').fetchone()[0],'a'*32)

    def test_catchup_scans_all_bound_groups_independent_of_greeting_selection(self):
        now=time.time();self.plan['catchup_from']=self.module.datetime.fromtimestamp(now-1000,self.module.timezone.utc).isoformat()
        self.plan['catchup_through']=self.module.datetime.fromtimestamp(now-10,self.module.timezone.utc).isoformat()
        rows={chat:[{'chat_id':chat,'seq':1,'source_at':now-500,'is_self':0,'msg_type':1,
                     'sender':'Member '+str(chat),'content':'@Tatsumi please reply','server_id':str(chat)}] for chat in (7,8)}
        class Agent:
            def request(self,route,query):
                if route.endswith('/stats'):return {'epoch':'a'*32,'through':1}
                return {'epoch':'a'*32,'messages':rows[query['chat']] if query['after']==0 else [],'next_after':None}
        bridge=types.SimpleNamespace(agent=Agent(),policy=types.SimpleNamespace(cfg={'managed_groups':{'7':{'enabled':True},'8':{'enabled':True}}}))
        journal=self.module.Journal();journal.seed(self.plan,{'shanghai':7,'other':8})
        self.module.scan(bridge,self.plan,journal,{'shanghai':7,'other':8})
        self.assertEqual(journal.progress(self.plan)['catchup_scanned'],2)
        with journal.db() as db:self.assertEqual({r[0] for r in db.execute("SELECT chat_id FROM jobs WHERE kind='catchup'")},{7,8})


if __name__=='__main__':unittest.main()
