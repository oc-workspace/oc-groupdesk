import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from chatlog_reader.watch import FileChanges,EVENT,IN_Q_OVERFLOW,synchronize
import test_engine as fixtures

@unittest.skipUnless(os.name=='posix' and hasattr(os,'pipe2'),'Linux file notification tests')
class WatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'source';self.secrets=self.root/'secrets'
        for path in [self.source/'message',self.source/'contact',self.secrets]:path.mkdir(parents=True)
        self.watcher=FileChanges(self.source,self.secrets);self.addCleanup(self.watcher.close)
        self.assertEqual(self.watcher.snapshot()['mode'],'inotify')
        self.assertEqual(self.watcher.snapshot()['watch_count'],4)
    def test_idle_wait_never_emits_a_scan(self):
        result=[];thread=threading.Thread(target=lambda:result.append(self.watcher.wait()))
        thread.start();time.sleep(.12);self.assertTrue(thread.is_alive())
        self.watcher.wake();thread.join(1);self.assertFalse(thread.is_alive());self.assertEqual(result,['wake'])
    def test_wechat_wal_write_wakes_the_listener(self):
        (self.source/'message/message_0.db-wal').write_bytes(b'synthetic transaction')
        self.assertEqual(self.watcher.wait(1),'event')
    def test_reads_do_not_wake_the_listener(self):
        path=self.source/'message/message_0.db';path.write_bytes(b'synthetic')
        self.watcher.drain();path.read_bytes();list(self.source.iterdir())
        self.assertEqual(self.watcher.wait(.03),'retry')
    def test_unrelated_files_do_not_request_a_database_scan(self):
        (self.source/'message/unrelated.tmp').write_bytes(b'not a database')
        (self.secrets/'vault-private.pem').write_bytes(b'synthetic fixture only')
        self.assertEqual(self.watcher.wait(.03),'retry')
    def test_new_shards_and_atomic_database_replacement_are_detected(self):
        path=self.source/'message/message_12.db';path.write_bytes(b'first')
        self.assertEqual(self.watcher.wait(1),'event')
        temporary=path.with_suffix('.new');temporary.write_bytes(b'replacement');temporary.replace(path)
        self.assertEqual(self.watcher.wait(1),'event')
    def test_contacts_and_encrypted_key_replacements_wake_the_listener(self):
        for path in [self.source/'contact/contact.db-wal',self.secrets/'wechat-key.enc']:
            self.watcher.drain();path.write_bytes(b'synthetic change')
            self.assertEqual(self.watcher.wait(1),'event')
    def test_recreated_message_directory_is_watched_again(self):
        old=self.source/'old-message';(self.source/'message').rename(old);(self.source/'message').mkdir()
        self.assertEqual(self.watcher.wait(1),'event');self.watcher.refresh();self.watcher.drain()
        (self.source/'message/message_0.db-wal').write_bytes(b'new directory transaction')
        self.assertEqual(self.watcher.wait(1),'event')
    def test_queue_overflow_requests_full_reconciliation(self):
        self.assertEqual(self.watcher._decode(EVENT.pack(-1,IN_Q_OVERFLOW,0,0)),'overflow')
    def test_unavailable_notifications_never_fall_back_to_polling(self):
        with patch('chatlog_reader.watch.ctypes.CDLL',side_effect=OSError('synthetic unavailable')):
            unavailable=FileChanges(self.source,self.secrets)
        try:
            self.assertEqual(unavailable.snapshot()['mode'],'unavailable')
            self.assertFalse(unavailable.tracking())
            with self.assertRaises(OSError):unavailable.wait()
        finally:unavailable.close()
    def test_missing_watch_directory_never_reports_healthy_tracking(self):
        self.watcher._update(running=True);self.assertTrue(self.watcher.tracking())
        (self.source/'contact').rmdir();self.watcher.refresh();self.assertFalse(self.watcher.tracking())

@unittest.skipUnless(os.name=='posix' and hasattr(os,'pipe2'),'Linux file notification tests')
class EventPipelineTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.EngineTests('test_indexer_excludes_unconfigured_conversations');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.engine=self.fixture.engine
        self.secrets=self.fixture.root/'secrets';self.secrets.mkdir()
        self.changes=FileChanges(self.engine.source,self.secrets);self.addCleanup(self.changes.close)
        self.engine.tracking=self.changes.tracking
        self.stop=threading.Event();self.thread=threading.Thread(target=synchronize,args=(self.engine,self.stop,self.changes))
        self.thread.start();self.addCleanup(self.finish)
        self.until(lambda:self.changes.snapshot()['syncs']>=1)
    def finish(self):
        self.stop.set();self.changes.wake();self.thread.join(2);self.assertFalse(self.thread.is_alive())
    def until(self,test):
        end=time.monotonic()+3
        while not test():
            if time.monotonic()>end:self.fail('event was not processed promptly')
            time.sleep(.01)
    def test_idle_health_and_empty_pulls_do_not_read_either_database(self):
        original=self.changes.snapshot()['syncs'];self.engine.last_success=time.time()-3600
        with patch.object(self.engine.store,'connect',side_effect=AssertionError('idle database query')):
            self.assertTrue(self.engine.status()['ok'])
            self.assertGreater(self.engine.status()['last_checked'],time.time()-1)
            self.assertEqual(self.engine.page(1,3,200)['messages'],[])
            time.sleep(.15)
        self.assertEqual(self.changes.snapshot()['syncs'],original)
        self.assertIsNone(self.changes.snapshot()['periodic_scan_seconds'])
    def test_new_sqlite_message_is_indexed_by_the_write_event(self):
        original=self.changes.snapshot()['syncs']
        self.fixture.add('native-a@chatroom',2,'New event-driven message',106)
        self.until(lambda:self.engine.cached_counts.get('1')==4)
        self.assertGreater(self.changes.snapshot()['event_syncs'],0)
        self.assertGreater(self.changes.snapshot()['syncs'],original)
        rows=self.engine.page(1,0,200)['messages'];self.assertEqual(rows[-1]['content'],'New event-driven message')
        seq=rows[-1]['seq'];self.fixture.add('native-a@chatroom',3,'Another event-driven message',107)
        self.until(lambda:self.engine.cached_counts.get('1')==5)
        self.assertEqual(self.engine.page(1,seq,200)['messages'][0]['content'],'Another event-driven message')
    def test_lost_listener_fails_health_without_renewing_old_source(self):
        self.changes._update(backend_error='synthetic failure')
        self.assertFalse(self.engine.status()['ok'])


@unittest.skipUnless(os.name=='posix' and hasattr(os,'pipe2'),'Linux file notification tests')
class RetryLifecycleTests(unittest.TestCase):
    setUp=WatchTests.setUp
    def test_failed_trigger_has_bounded_retries_then_waits_for_another_event(self):
        class Engine:
            def __init__(self):self.signatures={};self.calls=0;self.last_error='synthetic';self.fail=True
            def sync(self):self.calls+=1;self.last_error='synthetic' if self.fail else None
        engine=Engine();stop=threading.Event()
        import chatlog_reader.watch as module
        with patch.object(module,'RETRY_SECONDS',.02):
            thread=threading.Thread(target=synchronize,args=(engine,stop,self.watcher));thread.start()
            try:
                end=time.monotonic()+2
                while engine.calls<5 and time.monotonic()<end:time.sleep(.01)
                self.assertEqual(engine.calls,5);time.sleep(.08);self.assertEqual(engine.calls,5)
                engine.fail=False;(self.source/'message/message_0.db-wal').write_bytes(b'synthetic retry trigger')
                end=time.monotonic()+2
                while engine.calls<6 and time.monotonic()<end:time.sleep(.01)
                self.assertEqual(engine.calls,6);self.assertIsNone(engine.last_error)
            finally:stop.set();self.watcher.wake();thread.join(2)
            self.assertFalse(thread.is_alive())

if __name__=='__main__':unittest.main()
