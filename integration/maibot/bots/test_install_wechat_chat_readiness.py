import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import install_wechat_chat_readiness as readiness


class SenderReadinessTest(unittest.TestCase):
    def test_single_pane_chat_is_ready_but_login_screen_is_not(self):
        namespace = {
            'find_search_box': lambda root, profile: root.get('search'),
            'find_editor': lambda root, profile: root.get('editor'),
            'find_message_list': lambda root, profile: root.get('messages'),
        }
        exec('class Client:\n' + readiness.NEW, namespace)
        client = namespace['Client']()
        client.profile = None
        for controls, expected in [
            (None, False),
            ({'search': True}, True),
            ({'editor': True, 'messages': True}, True),
            ({'editor': True}, False),
            ({'messages': True}, False),
        ]:
            client._root = controls
            self.assertEqual(client.is_main_ui_ready, expected)

    def test_backup_guard_and_idempotence(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = Path(folder)
            path = runtime / 'bowxt/src/bowxt/client.py'
            path.parent.mkdir(parents=True)
            original = ('from __future__ import annotations\nclass Client:\n' + readiness.OLD).encode()
            path.write_bytes(original)
            updated = original.replace(readiness.OLD.encode(), readiness.NEW.encode())
            with patch.object(readiness, 'BEFORE', hashlib.sha256(original).hexdigest()), \
                 patch.object(readiness, 'AFTER', hashlib.sha256(updated).hexdigest()):
                result = readiness.install(runtime)
                self.assertTrue(result.startswith('installed:'))
                self.assertEqual(readiness.install(runtime), 'already_installed')
                backups = list((runtime / 'backups').glob('*/client.py'))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_bytes(), original)
            path.write_bytes(original + b'# unreviewed\n')
            with self.assertRaisesRegex(ValueError, 'Unreviewed sender baseline'):
                readiness.install(runtime)


if __name__ == '__main__':
    unittest.main()
