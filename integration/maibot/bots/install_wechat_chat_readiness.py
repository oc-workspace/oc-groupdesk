"""Install the reviewed narrow-window login-readiness fix for Tatsumi.

The sender is bind-mounted from the bot runtime. Refuse unknown local edits,
back up the exact file, then replace it atomically for the next sender restart.
"""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil

BEFORE = '321d475c1abf0850a04a5062754d55dcad32b765b9bcba96110e9114ffa650a1'
AFTER = 'eef6a529985c7ee2537711bac692f550642f84b35297ac492870feb1a40d877a'
OLD = '''    @property
    def is_main_ui_ready(self) -> bool:
        return bool(self._root and find_search_box(self._root, self.profile))
'''
NEW = '''    @property
    def is_main_ui_ready(self) -> bool:
        if not self._root:
            return False
        if find_search_box(self._root, self.profile):
            return True
        # In the narrow single-pane layout, opening a chat hides Search.
        # A visible editor and message list still identify the logged-in UI.
        return bool(find_editor(self._root, self.profile)
                    and find_message_list(self._root, self.profile))
'''


def digest(body):
    return hashlib.sha256(body).hexdigest()


def install(runtime):
    path = runtime / 'bowxt/src/bowxt/client.py'
    current = path.read_bytes()
    if current.count(OLD.encode()) != 1:
        if current.count(NEW.encode()) == 1 and digest(current) == AFTER:
            return 'already_installed'
        raise ValueError('Unreviewed sender readiness implementation')
    if digest(current) != BEFORE:
        raise ValueError('Unreviewed sender baseline')
    updated = current.replace(OLD.encode(), NEW.encode(), 1)
    ast.parse(updated.decode(), filename=str(path))
    backup = runtime / 'backups' / ('wechat-readiness-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copy2(path, backup / 'client.py')
    temp = path.with_name('client.py.readiness-tmp')
    temp.write_bytes(updated)
    temp.chmod(path.stat().st_mode & 0o777)
    temp.replace(path)
    return 'installed:' + digest(updated)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    print(install(parser.parse_args().runtime))
