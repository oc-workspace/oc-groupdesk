"""Regression for a second explicit question beyond the merge window."""
import tempfile
import unittest
from unittest.mock import patch
import policy
import reply_frequency


class NativeQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now=1795497000.
        cfg=policy.settings()
        cfg['managed_groups']={}
        cfg['group_priority_topics']={}
        self.p=policy.Policy(self.temp.name,cfg,lambda:self.now)
        self.p._quota=lambda *args,**kwargs:None
        self.rule={'enabled':True,'within_minutes':10}
        self.mock=patch.object(reply_frequency,'catchup',return_value=self.rule)
        self.mock.start();self.addCleanup(self.mock.stop)
    def ingest(self,seq,text,member='native-A'):
        return self.p.ingest(seq,'Synthetic member',text,self.now,True,chat_id='16',
            sender_id=member,reply_source_seq=100000+seq)
    def test_new_question_after_merge_window_is_durable_and_keeps_its_own_native_target(self):
        self.assertEqual(self.ingest(1,'Please explain the first question?'),'queued')
        self.now+=self.p.cfg['merge_window_seconds']+1
        self.assertEqual(self.ingest(2,'Please explain a different question?'),'frequency_waiting')
        with self.p.db() as db:
            waiting=db.execute('SELECT * FROM frequency_waiting WHERE seq=2').fetchone()
            self.assertEqual(waiting['reply_source_seq'],100002)
            self.assertEqual(waiting['received_at'],self.now)
            self.assertEqual(db.execute('SELECT count(*) FROM pending').fetchone()[0],1)
            db.execute('DELETE FROM pending')
        # A new process sees the same record. Releasing it does not restart TTL.
        self.p=policy.Policy(self.temp.name,self.p.cfg,lambda:self.now)
        self.p._quota=lambda *args,**kwargs:None
        self.assertTrue(reply_frequency.pump(self.p))
        with self.p.db() as db:
            row=db.execute('SELECT * FROM pending').fetchone()
            self.assertEqual(row['reply_source_seq'],100002)
            self.assertEqual(row['received_at'],self.now)
            self.assertEqual(row['frequency_deadline'],self.now+600)
            self.assertEqual(db.execute('SELECT status FROM frequency_waiting WHERE seq=2').fetchone()[0],'pending')
    def test_repeated_same_ingress_cannot_create_duplicate_deferred_tasks(self):
        self.ingest(1,'First question?')
        self.now+=self.p.cfg['merge_window_seconds']+1
        self.ingest(2,'A new question?')
        self.assertEqual(self.ingest(2,'A new question?'),'duplicate')
        with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM frequency_waiting').fetchone()[0],1)
    def test_expired_deferred_request_is_not_revived(self):
        self.ingest(1,'First question?')
        self.now+=self.p.cfg['merge_window_seconds']+1
        self.ingest(2,'Another question?')
        self.now+=601
        with self.p.db() as db:db.execute('DELETE FROM pending')
        self.assertFalse(reply_frequency.pump(self.p))
        with self.p.db() as db:self.assertEqual(db.execute('SELECT status FROM frequency_waiting WHERE seq=2').fetchone()[0],'expired')
    def test_next_turn_waits_for_failed_runtime_cleanup_instead_of_racing_it(self):
        import chat_reliability
        self.ingest(1,'First question?')
        self.now+=5
        turn=self.p.dispatch()
        self.assertIsNotNone(turn)
        self.assertTrue(chat_reliability.finish(self.p,turn['id']))
        self.ingest(2,'Another question?',member='native-B')
        self.now+=3
        self.assertIsNone(self.p.dispatch())
        self.now+=8
        self.assertIsNotNone(self.p.dispatch())
    def test_off_switch_keeps_the_configured_no_catchup_behavior(self):
        self.ingest(1,'First question?')
        self.now+=self.p.cfg['merge_window_seconds']+1
        self.rule['enabled']=False
        self.assertEqual(self.ingest(2,'Another question?'),'reply_window')
        with self.p.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM frequency_waiting').fetchone()[0],0)


if __name__=='__main__':unittest.main()
