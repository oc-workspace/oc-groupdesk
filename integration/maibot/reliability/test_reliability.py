import asyncio
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import chat_reliability as r


class Policy:
    def __init__(self,path):
        self.path=path
        self.cfg={'task_calls_per_turn':{'planner':3,'replyer':2}}
        with self.db() as db:
            db.executescript("""
              CREATE TABLE turns(id TEXT PRIMARY KEY,status TEXT,created REAL,received_at REAL,ended REAL,
                expires REAL,chat_id TEXT,reply_source_seq INTEGER,explicit INTEGER,reply_member TEXT,sender TEXT,policy_revision TEXT);
              CREATE TABLE sends(id TEXT PRIMARY KEY,turn_id TEXT,status TEXT);
              CREATE TABLE attempts(id TEXT PRIMARY KEY,turn_id TEXT,task TEXT,state TEXT);
              CREATE TABLE pending(id TEXT,chat_id TEXT,received_at REAL,first REAL);
              CREATE TABLE frequency_waiting(seq INTEGER,chat_id TEXT,received_at REAL,status TEXT,expires REAL);
              INSERT INTO turns VALUES('old','active',900,900,NULL,1400,'16',10,1,'Member','member','1');
              INSERT INTO turns VALUES('other','sent',800,800,850,900,'5',9,1,'Other','other','1');
            """)
    def clock(self):return 1000
    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path)
        db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.p=Policy(str(Path(self.directory.name)/'state.db'))
    def status(self,turn='old'):
        with self.p.db() as db:return db.execute('SELECT status FROM turns WHERE id=?',(turn,)).fetchone()[0]
    def test_release_only_current_task_after_request_reservation_is_settled(self):
        with self.p.db() as db:db.execute("INSERT INTO attempts VALUES('a','old','planner','reserved')")
        self.assertFalse(r.finish(self.p,'old'))
        with self.p.db() as db:db.execute("UPDATE attempts SET state='settled'")
        self.assertTrue(r.finish(self.p,'old'))
        self.assertEqual(self.status(),'failed')
        self.assertEqual(self.status('other'),'sent')
        self.assertFalse(r.finish(self.p,'old'))
    def test_reserved_sent_and_uncertain_outbounds_are_never_released_or_replayed(self):
        for state in ('reserved','sent','uncertain','failed'):
            with self.p.db() as db:
                db.execute('DELETE FROM sends')
                db.execute("INSERT INTO sends VALUES('send','old',?)",(state,))
            self.assertFalse(r.finish(self.p,'old'))
        self.assertEqual(self.status(),'active')
    def test_ws_delivery_in_flight_is_not_treated_as_an_empty_turn(self):
        r.stage(self.p,'old','sending')
        self.assertFalse(r.finish(self.p,'old'))
        self.assertEqual(self.status(),'active')
    def test_replyer_preserves_one_configured_retry_then_releases(self):
        with self.p.db() as db:db.execute("INSERT INTO attempts VALUES('first','old','replyer','settled')")
        r.model_failed(self.p,'old','replyer',TimeoutError())
        self.assertEqual(self.status(),'active')
        with self.p.db() as db:db.execute("INSERT INTO attempts VALUES('second','old','replyer','settled')")
        r.model_failed(self.p,'old','replyer',TimeoutError())
        self.assertEqual(self.status(),'failed')
    def test_planner_failure_releases_without_waiting_for_the_lease(self):
        r.model_failed(self.p,'old','planner',ValueError())
        self.assertEqual(self.status(),'failed')
    def test_restart_preserves_notice_reservation_and_no_message_text_is_reported(self):
        r.stage(self.p,'old','failed','model_failed')
        with self.p.db() as db:db.execute("UPDATE request_outcomes SET notice_status='reserved'")
        r.stage(self.p,'old','failed','model_failed')
        with self.p.db() as db:
            self.assertEqual(db.execute('SELECT notice_status FROM request_outcomes').fetchone()[0],'reserved')
        data=r.recent(self.p,'16')
        self.assertEqual(len(data),1)
        self.assertNotIn('text',data[0])
        self.assertNotIn('Member',str(data))
    def test_group_status_is_isolated_and_includes_deferred_work(self):
        with self.p.db() as db:
            db.execute("INSERT INTO frequency_waiting VALUES(101,'16',950,'waiting',1200)")
            db.execute("INSERT INTO pending VALUES('pending','5',990,990)")
        data=r.recent(self.p,'16')
        self.assertEqual({item['stage'] for item in data},{'waiting_model','deferred'})
        self.assertNotIn('other',str(data))
        self.assertNotIn('pending',str(data))


class FinalizeTests(unittest.IsolatedAsyncioTestCase):
    async def test_monitoring_failure_does_not_prevent_loop_completion(self):
        async def broken():raise ValueError('synthetic')
        self.assertEqual(await r.finalize(broken(),'done'),'done')
    async def test_monitoring_timeout_is_bounded_but_external_cancel_propagates(self):
        async def slow():await asyncio.sleep(60)
        original=asyncio.wait_for
        async def bounded(coro,timeout):return await original(coro,timeout=.001)
        with patch.object(r.asyncio,'wait_for',side_effect=bounded):
            self.assertEqual(await r.finalize(slow(),'done'),'done')
        async def cancelled():raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):await r.finalize(cancelled(),'done')


if __name__=='__main__':unittest.main()


class NoticeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import sys
        import types
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.p=Policy(str(Path(self.temp.name)/'notices.db'))
        self.p.cfg['user_interval']=30
        self.p.after_turn=lambda *args:False
        self.p._quota=lambda *args,**kwargs:None
        with self.p.db() as db:
            db.execute("ALTER TABLE turns ADD COLUMN kind TEXT DEFAULT 'direct'")
            db.execute("ALTER TABLE turns ADD COLUMN article INTEGER DEFAULT 0")
            db.execute("ALTER TABLE turns ADD COLUMN fast INTEGER DEFAULT 0")
            db.execute("CREATE TABLE observed(seq INTEGER,text TEXT)")
            db.execute("INSERT INTO observed VALUES(10,'Hello, are you there?')")
        r.finish(self.p,'old')
        self.control={'enabled':True,'send_enabled':True}
        self.messages=[]
        self.delivery='sent'
        def incoming(*args):
            return types.SimpleNamespace(message_info=types.SimpleNamespace(additional_config={}))
        async def outgoing(packet):
            self.messages.append(packet)
            turn=packet.message_info.additional_config['gt_limit_turn']
            with self.p.db() as db:
                db.execute('INSERT INTO sends VALUES(?,?,?)',('notice-'+turn,turn,self.delivery))
                db.execute('UPDATE turns SET status=? WHERE id=?',(self.delivery,turn))
        self.bridge=types.SimpleNamespace(policy=self.p,control=lambda:self.control,chats={16:types.SimpleNamespace(id=16,name='synthetic')},outgoing=outgoing)
        gd=types.SimpleNamespace(profile=lambda *args:{'policy':{},'revision':1},available=lambda *args:True,
            revision=lambda profile:'1',language_allowed=lambda *args:True)
        modules={'groupdesk_runtime':gd,'latency':types.SimpleNamespace(language=lambda *args:'en'),
            'app':types.SimpleNamespace(incoming_packet=incoming,Seg=lambda *args:args)}
        self.modules=patch.dict(sys.modules,modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
    async def test_failure_notice_runs_once_through_existing_sender_with_original_source(self):
        self.assertTrue(await r.send_failure_notice(self.bridge))
        self.assertFalse(await r.send_failure_notice(self.bridge))
        self.assertEqual(len(self.messages),1)
        config=self.messages[0].message_info.additional_config
        with self.p.db() as db:
            turn=db.execute('SELECT reply_source_seq FROM turns WHERE id=?',(config['gt_limit_turn'],)).fetchone()
            self.assertEqual(turn['reply_source_seq'],10)
            self.assertEqual(db.execute('SELECT notice_status FROM request_outcomes WHERE turn_id="old"').fetchone()[0],'sent')
    async def test_uncertain_notice_is_reserved_and_never_replayed(self):
        self.delivery='uncertain'
        self.assertTrue(await r.send_failure_notice(self.bridge))
        self.assertFalse(await r.send_failure_notice(self.bridge))
        self.assertEqual(len(self.messages),1)
        with self.p.db() as db:self.assertEqual(db.execute('SELECT notice_status FROM request_outcomes WHERE turn_id="old"').fetchone()[0],'review')
    async def test_pause_does_not_consume_the_pending_notice(self):
        self.control['send_enabled']=False
        self.assertFalse(await r.send_failure_notice(self.bridge))
        with self.p.db() as db:self.assertEqual(db.execute('SELECT notice_status FROM request_outcomes WHERE turn_id="old"').fetchone()[0],'waiting')
        self.assertEqual(self.messages,[])
