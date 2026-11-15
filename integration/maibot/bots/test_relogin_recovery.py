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

ROOT=Path(__file__).parent


class ReloginRecoveryTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);self.now=time.time()
        gd=types.ModuleType('groupdesk_runtime')
        gd.SNAPSHOT=self.root/'groupdesk'/'policy.json'
        gd.profile=lambda cfg,chat:cfg['managed_groups'].get(chat)
        gd.available=lambda profile,now:bool(profile and profile.get('enabled'))
        gd.api=lambda path:{'enabled':True,'activation_generation':2}
        names=types.ModuleType('bot_names');names.addressed=lambda cfg,chat,text:'@Tatsumi' in text
        mentions=types.ModuleType('reply_mention');mentions.member_name=lambda name:name if name and not name.startswith('昵称未同步') else None
        modules={'groupdesk_runtime':gd,'bot_names':names,'reply_mention':mentions}
        with patch.dict(sys.modules,modules):
            spec=importlib.util.spec_from_file_location('migration_launch',ROOT/'migration_launch.py')
            launch=importlib.util.module_from_spec(spec);spec.loader.exec_module(launch)
            modules['migration_launch']=launch
            with patch.dict(sys.modules,modules):
                spec=importlib.util.spec_from_file_location('relogin_recovery_tested',ROOT/'relogin_recovery.py')
                self.recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.recovery)
        self.launch=launch
        self.path=self.root/'policy.sqlite3'
        with self.db() as db:
            db.executescript('''CREATE TABLE recovery_sources(seq INTEGER PRIMARY KEY,turn_id TEXT);
                CREATE TABLE sends(turn_id TEXT,status TEXT);''')
        self.rows=[]
        class Agent:
            def __init__(agent):agent.source_status={'connected':True,'checked_at':self.now}
            def namespace(agent,epoch):return 1000000
            def request(agent,route,query):
                if route.endswith('/stats'):return {'epoch':'a'*32,'through':len(self.rows)}
                return {'epoch':'a'*32,'messages':[r for r in self.rows if r['seq']>query['after'] and query['start']<=r['source_at']<=query['end']], 'next_after':None}
        self.profile={'enabled':True,'policy':{'relogin_recovery':True}}
        self.bridge=types.SimpleNamespace(state_dir=self.root,agent=Agent(),chats=[7],
            policy=types.SimpleNamespace(cfg={'managed_groups':{'7':self.profile}},db=self.db),
            health={'robot':{'state':'active','activation_generation':2}},
            control=lambda:{'enabled':True,'send_enabled':True})
        self.conf={'groups':{'7':'shanghai'}}

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path);db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()

    def row(self,seq,at,sender='Alice',text='@Tatsumi hello',self_sent=0,reference=None):
        return {'chat_id':7,'seq':seq,'source_at':at,'is_self':self_sent,'msg_type':1,
                'sender':sender,'content':text,'server_id':str(seq),**({'reference_server_id':reference} if reference else {})}

    def test_uses_existing_offline_observation_then_waits_for_reader_settlement(self):
        (self.root/'hourly-health.json').write_text(json.dumps({'reported_at':self.now-500,'result':{'wechat':False}}))
        self.recovery.step(self.bridge,self.conf,{'running':True,'wechat_connected':False},True,True,self.now)
        journal=self.launch.Journal()
        with journal.db() as db:outage=db.execute('SELECT * FROM relogin_outages').fetchone()
        self.assertEqual(outage['started'],self.now-500)
        self.rows=[self.row(1,self.now-200)]
        self.recovery.step(self.bridge,self.conf,{'running':True,'wechat_connected':True},True,True,self.now+5)
        with journal.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0],0)
        with patch.object(self.launch,'enqueue') as enqueue:
            self.recovery.step(self.bridge,self.conf,{'running':True,'wechat_connected':True},True,True,self.now+126)
        self.assertEqual(enqueue.call_count,1)
        self.assertEqual(enqueue.call_args.kwargs['source'],'relogin')
        with journal.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0],1)

    def test_group_opt_in_and_confirmed_answers_prevent_duplicate_jobs(self):
        incident={'id':'incident','started':self.now-500,'recovered':self.now-100}
        self.rows=[self.row(1,self.now-300),self.row(2,self.now-250,'Bob','@Tatsumi question'),
                   self.row(3,self.now-50,'Tatsumi','@Bob answered',1,'2')]
        journal=self.launch.Journal()
        self.profile['policy']['relogin_recovery']=False
        self.assertEqual(self.recovery.scan(self.bridge,journal,incident,{7:'shanghai'},self.now),{})
        self.profile['policy']['relogin_recovery']=True
        self.assertEqual(self.recovery.scan(self.bridge,journal,incident,{7:'shanghai'},self.now),{'queued':1})
        self.assertEqual(journal.one('incident','catchup','queued')['source_seq'],1)
        self.recovery.scan(self.bridge,journal,incident,{7:'shanghai'},self.now+1)
        with journal.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0],1)

    def test_original_sent_or_uncertain_is_not_requeued(self):
        self.rows=[self.row(1,self.now-300),self.row(2,self.now-250,'Bob','@Tatsumi question')]
        with self.db() as db:
            db.execute('INSERT INTO recovery_sources VALUES(?,?)',(1000001,'sent-turn'))
            db.execute('INSERT INTO sends VALUES(?,?)',('sent-turn','sent'))
            db.execute('INSERT INTO recovery_sources VALUES(?,?)',(1000002,'uncertain-turn'))
            db.execute('INSERT INTO sends VALUES(?,?)',('uncertain-turn','reserved'))
        journal=self.launch.Journal()
        result=self.recovery.scan(self.bridge,journal,{'id':'incident','started':self.now-500,'recovered':self.now-100},{7:'shanghai'},self.now)
        self.assertEqual(result,{'attention':1})
        self.assertIsNone(journal.one('incident','catchup','queued'))


if __name__=='__main__':unittest.main()
