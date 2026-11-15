import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

SOURCE = Path(__file__).with_name('auto_welcome.py')
gd = types.ModuleType('groupdesk_runtime')
gd.SNAPSHOT = Path('/tmp/auto-welcome-test/snapshot.json')
gd.available = lambda profile, now: profile.get('enabled', False)
gd.profile = lambda cfg, chat: cfg['managed_groups'][chat]
sys.modules['groupdesk_runtime'] = gd
spec = importlib.util.spec_from_file_location('auto_welcome_tested', SOURCE)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class Agent:
    def __init__(self):
        self.rows = []
        self.sent = []
        self.delivery = 'pending'

    def request(self, path, query):
        assert path == '/v1/stream'
        if query['after'] == 'tail':
            return {'epoch': 'fixture', 'watermark': max([r['seq'] for r in self.rows], default=0),
                    'messages': [], 'next_after': None}
        rows = [r for r in self.rows if r['seq'] > query['after']]
        return {'epoch': 'fixture', 'watermark': max([r['seq'] for r in self.rows], default=0),
                'messages': rows, 'next_after': None}

    def send_text(self, chat, text, *, mentions, client_id):
        self.sent.append((chat, text, mentions, client_id))
        return types.SimpleNamespace(seq=42)

    def get_message(self, seq):
        assert seq == 42
        return types.SimpleNamespace(delivery_status=self.delivery, delivery_error=None)


class AutoWelcomeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        gd.SNAPSHOT = Path(self.tmp.name) / 'snapshot.json'
        self.profile = {'enabled': True, 'policy': {'auto_welcome': True,
            'language': {'mode': 'follow', 'fallback': 'zh-CN'}}}
        self.agent = Agent()
        self.bridge = types.SimpleNamespace(
            agent=self.agent, policy=types.SimpleNamespace(cfg={'managed_groups': {'1': self.profile}}),
            send_lock=types.SimpleNamespace(locked=lambda: False),
            control=lambda: {'send_enabled': True}, health={'robot': {'state': 'active'}})
        self.conf = {'groups': {'1': 'fixture'}}
        self.status = {'running': True, 'wechat_connected': True, 'queue_depth': 0}
        self.now = 1800000000

    def join(self, seq=1, names=None):
        return {'seq': seq, 'chat_id': 1, 'msg_type': 10000, 'is_self': 0,
                'source_at': self.now - 2,
                'content': w.PREFIX + json.dumps({'inviter': 'Inviter',
                    'newcomers': names or ['Newcomer']}, ensure_ascii=False)}

    def step(self):
        w.step(self.bridge, self.conf, self.status, True, True, self.now)

    def test_inviter_is_never_mentioned_and_malformed_notice_is_ignored(self):
        self.assertEqual(w.parse_join(self.join(names=['Newcomer'])), ['Newcomer'])
        self.assertIsNone(w.parse_join(self.join(names=['Inviter'])))
        bad = self.join()
        bad['content'] = w.PREFIX + '[]'
        self.assertIsNone(w.parse_join(bad))
        bad['msg_type'] = 1
        self.assertIsNone(w.parse_join(bad))

    def test_enable_begins_at_tail_then_sends_once_and_settles(self):
        self.agent.rows = [self.join(1)]
        self.step()
        self.assertEqual(self.agent.sent, [])
        self.agent.rows.append(self.join(2))
        self.step()
        self.assertEqual(len(self.agent.sent), 1)
        self.assertEqual(self.agent.sent[0][2], ['Newcomer'])
        self.agent.delivery = 'sent'
        self.step()
        self.assertEqual(len(self.agent.sent), 1)
        with w.Journal().db() as db:
            self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()['status'], 'sent')

    def test_disabled_group_resets_cursor_and_queued_work(self):
        self.step()
        self.profile['policy']['auto_welcome'] = False
        self.step()
        with w.Journal().db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM cursors').fetchone()[0], 0)
        self.profile['policy']['auto_welcome'] = True
        self.agent.rows = [self.join()]
        self.step()
        self.assertEqual(self.agent.sent, [])

    def test_ui_block_keeps_queued_job_without_submitting(self):
        self.step()
        self.agent.rows = [self.join()]
        self.status['ui_input_blocked'] = True
        self.step()
        self.assertEqual(self.agent.sent, [])
        self.status['ui_input_blocked'] = False
        self.step()
        self.assertEqual(len(self.agent.sent), 1)

    def test_stale_reservation_requires_review_instead_of_resending(self):
        self.step()
        self.agent.rows = [self.join()]
        self.status['ui_input_blocked'] = True
        self.step()
        with w.Journal().db() as db:
            db.execute('UPDATE jobs SET status="reserved",reserved_at=?', (self.now - 121,))
        self.status['ui_input_blocked'] = False
        self.step()
        self.assertEqual(self.agent.sent, [])
        with w.Journal().db() as db:
            self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()['status'], 'attention')


if __name__ == '__main__':
    unittest.main()
