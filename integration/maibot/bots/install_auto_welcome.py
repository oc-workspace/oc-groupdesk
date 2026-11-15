"""Hash-checked, backup-first install of the per-group native welcome worker."""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil

BEFORE = {
    'bot_runtime.py': 'f60ac6eb877745544ab57831d55ab45333d9ea6e20ab72d01dc58f9673f56290',
    'groupdesk_runtime.py': '8432fbbdb70c460f54c99baa3c1248463d901427d7476310f7e07dc6c69aa1e5',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def install(runtime, check=False):
    source = Path(__file__).resolve().parent
    destination = runtime / 'limits'
    files = {
        'bot_runtime.py': source / 'bot_runtime.py',
        'groupdesk_runtime.py': source.parent / 'groupdesk_runtime.py',
        'auto_welcome.py': source / 'auto_welcome.py',
    }
    bridge = (runtime / 'bridge/app.py').read_text()
    if 'strict_migration_reply' not in bridge:
        raise ValueError('Native mention sender hook is unavailable')
    changes = []
    for name, path in files.items():
        body = path.read_bytes()
        ast.parse(body.decode(), filename=str(path))
        target = destination / name
        current = target.read_bytes() if target.exists() else None
        if current == body:
            continue
        if name == 'auto_welcome.py':
            if current is not None:
                raise ValueError('Unreviewed auto welcome module')
        elif current is None or digest(current) != BEFORE[name]:
            raise ValueError('Unreviewed runtime baseline: ' + name)
        changes.append((name, body))
    if check:
        return 'preflight:' + ','.join(name for name, _ in changes)
    if not changes:
        return 'already_installed'
    backup = runtime / 'backups' / ('auto-welcome-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, _ in changes:
        target = destination / name
        if target.exists():
            shutil.copy2(target, backup / name)
    for name, body in changes:
        target = destination / name
        temp = target.with_name(name + '.auto-welcome-tmp')
        temp.write_bytes(body)
        temp.chmod(0o644)
        temp.replace(target)
    return 'installed:' + ','.join(name for name, _ in changes)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    print(install(args.runtime, args.check))
