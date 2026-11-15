"""Hash-checked fix for a stale sender UI block in send-only mode.

After a failed transient interaction, the SDK discards its locked client.
The new client may connect to a clean WeChat surface, but send-only mode has
no chat poll to clear the old status flag. Validate the new surface before
clearing that flag, so queued guarded sends can resume.
"""

import argparse
import ast
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil

BEFORE = '317f176a018ede21078cec0fae63ba80baa31fbfbd1a168147e7b6b6e4fdcfe3'
AFTER = '4624c064b94ac5998c095d8a7b211a75471468e95076ceb973226d686ebea792'
OLD = '''                        client.connect()
                        if not client.is_main_ui_ready:
                            raise RuntimeError("WeChat login or phone confirmation is still required")
                        self._set_status(wechat_connected=True, last_error=None)
'''
NEW = '''                        client.connect()
                        if not client.is_main_ui_ready:
                            raise RuntimeError("WeChat login or phone confirmation is still required")
                        # Send-only mode has no chat poll to clear a prior UI
                        # lock. Validate the new surface before clearing it.
                        if self.status().get('ui_input_blocked'):
                            client._assert_clean_surface(client._ensure_root())
                        self._set_status(wechat_connected=True, last_error=None,
                                         ui_input_blocked=False)
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def install(runtime, check=False):
    path = runtime / 'bowxt/src/bowxt/service.py'
    current = path.read_bytes()
    if digest(current) == AFTER:
        return 'already_installed'
    if digest(current) != BEFORE or current.count(OLD.encode()) != 1:
        raise ValueError('Unreviewed sender service baseline')
    updated = current.replace(OLD.encode(), NEW.encode(), 1)
    if digest(updated) != AFTER:
        raise ValueError('Sender patch digest differs')
    ast.parse(updated.decode(), filename=str(path))
    if check:
        return 'preflight:' + AFTER
    backup = runtime / 'backups' / ('wechat-ui-block-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copy2(path, backup / 'service.py')
    temp = path.with_name('service.py.ui-block-tmp')
    temp.write_bytes(updated)
    temp.chmod(path.stat().st_mode & 0o777)
    temp.replace(path)
    return 'installed:' + AFTER


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    print(install(args.runtime, args.check))
