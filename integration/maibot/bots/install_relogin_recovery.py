"""Install the reviewed relogin modules on the existing Tatsumi runtime.

Reject any unreviewed baseline instead of overwriting live hotfixes. Run from
an immutable release directory after the GroupDesk control-plane release.
"""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil

BEFORE={
    'relogin_recovery.py':'f20bec1a3ea9f12a5c17f97827f19c4c0b455866611a9faef302435d29021452',
    'bot_runtime.py':'fd687b638cbe43cd0ff58877ad630c4e671640dd0d78eadea508690d969d0e92',
    'migration_launch.py':'5441de932dd5805790899a018875760ec6803d2953d3a6ef933fa49dc9c2f020',
    'groupdesk_runtime.py':'d488500a276a5c653aec509bd8f8a4c4ff0812c04ee90d345d7289f9771fa7a0',
}


def digest(data):return hashlib.sha256(data).hexdigest()


def install(runtime):
    source=Path(__file__).resolve().parent
    dest=runtime/'limits'
    bridge=(runtime/'bridge/app.py').read_text()
    if 'migration_launch.run(self)' not in bridge or 'strict_migration_reply' not in bridge:
        raise ValueError('Native mention bridge hooks are unavailable')
    candidates={
        'relogin_recovery.py':source/'relogin_recovery.py',
        'migration_launch.py':source/'migration_launch.py',
        'groupdesk_runtime.py':source.parent/'groupdesk_runtime.py',
        'bot_runtime.py':source/'bot_runtime.py',
    }
    changed=[]
    for name,path in candidates.items():
        body=path.read_bytes();ast.parse(body.decode(),filename=str(path))
        current=(dest/name).read_bytes() if (dest/name).exists() else None
        if current is not None and digest(current)==digest(body):continue
        if name=='relogin_recovery.py':
            if current is not None and digest(current)!=BEFORE[name]:raise ValueError('Unreviewed runtime baseline: '+name)
        elif current is None or digest(current)!=BEFORE[name]:
            raise ValueError('Unreviewed runtime baseline: '+name)
        changed.append((name,body))
    if not changed:return 'already_installed'
    backup=runtime/'backups'/('relogin-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700,parents=True,exist_ok=False)
    for name,_ in changed:
        if (dest/name).exists():shutil.copy2(dest/name,backup/name)
    for name,body in changed:
        temp=dest/(name+'.relogin-tmp')
        temp.write_bytes(body);temp.chmod(0o644);temp.replace(dest/name)
    return 'installed:'+','.join(name for name,_ in changed)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('runtime',type=Path)
    print(install(parser.parse_args().runtime))
