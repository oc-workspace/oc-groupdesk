"""Local AX collector, transactional archive, overlap recovery and leased MaiBot source.

The capture helper is the only component that touches WeChat. Snapshots and the
archive stay on the owner's device. Installation diagnostics contain codes only.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import uuid


class Blocked(ValueError):
    pass


def private(path, directory=False):
    path = Path(path).expanduser().absolute()
    info = path.lstat()
    if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Blocked('private_storage_required')
    if directory and not path.is_dir() or not directory and not path.is_file():
        raise Blocked('private_storage_required')
    return path


@contextmanager
def capture_lock(directory):
    import fcntl
    root = private(directory, directory=True)
    path = root / 'capture.lock'
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    try:
        private(path)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('collector_already_running') from None
        yield
    finally:
        os.close(fd)


def json_file(path):
    path = private(path)
    if path.stat().st_size > 128000:
        raise Blocked('config_too_large')
    return json.loads(path.read_text())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def check_config(value):
    required = {'contract', 'bot_id', 'account_id', 'wechat_build', 'group', 'roster', 'profile'}
    if not isinstance(value, dict) or set(value) != required or type(value['contract']) is not int or value['contract'] != 1:
        raise Blocked('invalid_config')
    for field in ('bot_id', 'account_id'):
        if not isinstance(value[field], str) or str(uuid.UUID(value[field])) != value[field]:
            raise Blocked('invalid_identity')
    if not isinstance(value['wechat_build'], str) or not value['wechat_build'].isdigit():
        raise Blocked('invalid_build')
    group = value['group']
    if not isinstance(group, dict) or set(group) != {'id', 'name'} or type(group['id']) is not int or not 0 < group['id'] < 2**31 or not isinstance(group['name'], str) or not 1 <= len(group['name']) <= 160:
        raise Blocked('invalid_group')
    roster = value['roster']
    if not isinstance(roster, dict) or not 2 <= len(roster) <= 500:
        raise Blocked('sender_roster_required')
    for label, person in roster.items():
        if not isinstance(label, str) or not label or len(label) > 160 or not isinstance(person, dict) or set(person) != {'id', 'name', 'self'}:
            raise Blocked('invalid_sender')
        if not isinstance(person['name'], str) or not 1 <= len(person['name']) <= 160 or type(person['self']) is not bool:
            raise Blocked('invalid_sender')
        if not isinstance(person['id'], str) or str(uuid.UUID(person['id'])) != person['id']:
            raise Blocked('invalid_sender')
    if len({row['id'] for row in roster.values()}) != len(roster) or sum(p['self'] for p in roster.values()) != 1:
        raise Blocked('ambiguous_sender')
    profile = value['profile']
    if not isinstance(profile, dict) or profile.get('title') != group['name']:
        raise Blocked('invalid_profile')
    for field in ('header', 'account', 'container', 'sender', 'body', 'scroll'):
        selector = profile.get(field)
        if not isinstance(selector, dict) or not isinstance(selector.get('role'), str) or not isinstance(selector.get('path'), list):
            raise Blocked('invalid_profile')
        if len(selector['path']) > 20 or any(type(i) is not int or i < 0 or i > 1000 for i in selector['path']):
            raise Blocked('invalid_profile')
    if not isinstance(profile.get('account_value'), str) or not profile['account_value']:
        raise Blocked('account_guard_required')
    if 'outgoing_row' in profile:
        own = profile['outgoing_row']
        self_label = profile.get('self_sender')
        if not isinstance(own, dict) or not own.get('role') or not (own.get('identifier') or own.get('description')):
            raise Blocked('outgoing_guard_required')
        if not isinstance(self_label, str) or self_label not in roster or not roster[self_label]['self']:
            raise Blocked('outgoing_guard_required')
    if not isinstance(profile.get('row'), dict) or not profile['row'].get('role'):
        raise Blocked('row_guard_required')
    return value


def normalize(config, snapshot):
    if not isinstance(snapshot, dict) or snapshot.get('contract') != 1 or snapshot.get('title') != config['group']['name']:
        raise Blocked('chat_not_verified')
    if type(snapshot.get('at_bottom')) is not bool or type(snapshot.get('at_top')) is not bool:
        raise Blocked('invalid_snapshot')
    rows = snapshot.get('rows')
    if not isinstance(rows, list) or len(rows) > 600:
        raise Blocked('invalid_snapshot')
    output = []
    for row in rows:
        if not isinstance(row, dict) or not {'sender', 'content'} <= set(row) <= {'sender', 'content', 'ui_id', 'timestamp'}:
            raise Blocked('invalid_message')
        label, body = row['sender'], row['content']
        if not isinstance(label, str) or not label.strip() or len(label) > 160:
            raise Blocked('identity_unresolved')
        if not isinstance(body, str) or not body.strip() or len(body) > 16000:
            raise Blocked('unsupported_message')
        person = config['roster'].get(label) or {'id': str(uuid.uuid5(uuid.UUID(config['account_id']), str(config['group']['id'])+'\0'+label)), 'name': label, 'self': False}
        source_at = None
        if 'timestamp' in row:
            try:
                stamp = datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
                if not stamp.tzinfo:
                    raise ValueError()
                source_at = stamp.timestamp()
                if not math.isfinite(source_at) or source_at < 0 or source_at > time.time() + 60:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError, OverflowError):
                raise Blocked('timestamp_unresolved') from None
        identifier = row.get('ui_id')
        if 'message_id' in config['profile'] and (not isinstance(identifier, str) or not 1 <= len(identifier) <= 256):
            raise Blocked('message_id_unresolved')
        signature = digest([person['id'], body, person['self'], source_at, identifier])
        output.append({'signature': signature, 'sender_id': 'mac-ui-' + digest([config['account_id'], config['group']['id'], person['id']])[:32],
                       'sender': person['name'], 'content': body, 'is_self': int(person['self']),
                       'source_at': source_at, 'ui_id': identifier})
    if 'message_id' in config['profile'] and len({row['ui_id'] for row in output}) != len(output):
        raise Blocked('duplicate_ui_identity')
    return output


def overlap(left, right):
    """Unique suffix/prefix alignment, including occurrences of repeated bodies."""
    matches = [count for count in range(1, min(len(left), len(right)) + 1)
               if [x['signature'] for x in left[-count:]] == [x['signature'] for x in right[:count]]]
    if len(matches) > 1:
        raise Blocked('ambiguous_overlap')
    return matches[0] if matches else 0


def anchor_end(left, right):
    # Several matching lengths can describe the same position. Only distinct
    # possible ends are ambiguous (for example a repeated identical message).
    ends = set()
    for count in range(1, min(len(left), len(right)) + 1):
        suffix = [row['signature'] for row in left[-count:]]
        for start in range(len(right) - count + 1):
            if suffix == [row['signature'] for row in right[start:start+count]]:
                ends.add(start + count)
    if len(ends) > 1:
        raise Blocked('ambiguous_overlap')
    return next(iter(ends)) if ends else 0


class Archive:
    def __init__(self, directory, config, clock=time.time):
        self.root = private(directory, directory=True)
        self.config, self.clock = check_config(config), clock
        self.path = self.root / 'messages.sqlite3'
        if self.path.exists():
            private(self.path)
        # The directory is private. Keep journal/temporary files private too.
        old = os.umask(0o077)
        try:
            with self.db() as db:
                db.executescript('''
                    PRAGMA journal_mode=WAL;
                    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),rows_json TEXT NOT NULL,updated REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,signature TEXT NOT NULL,
                      sender_id TEXT NOT NULL,sender TEXT NOT NULL,content TEXT NOT NULL,is_self INTEGER NOT NULL,
                      source_at REAL,observed_at REAL NOT NULL,backfilled INTEGER NOT NULL,eligible INTEGER NOT NULL,ui_id TEXT);
                    CREATE UNIQUE INDEX IF NOT EXISTS stable_ui_id ON messages(ui_id) WHERE ui_id IS NOT NULL;
                    CREATE TABLE IF NOT EXISTS consumers(name TEXT PRIMARY KEY,after_seq INTEGER NOT NULL DEFAULT 0,
                      pending INTEGER,lease_id TEXT,lease_until REAL NOT NULL DEFAULT 0);
                ''')
                db.execute('BEGIN IMMEDIATE')
                previous = db.execute('SELECT value FROM meta WHERE key="binding"').fetchone()
                binding = digest(config)
                if previous and previous[0] != binding:
                    raise Blocked('configuration_changed')
                db.execute('INSERT OR IGNORE INTO meta VALUES("binding",?)', (binding,))
                db.execute('INSERT OR IGNORE INTO meta VALUES("epoch",?)', (uuid.uuid4().hex,))
        finally:
            os.umask(old)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def checkpoint(self):
        with self.db() as db:
            row = db.execute('SELECT * FROM checkpoint WHERE id=1').fetchone()
        return (json.loads(row['rows_json']), row['updated']) if row else (None, None)

    def commit(self, previous, visible, added, backfilled=False, baseline=False):
        now = self.clock()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT rows_json FROM checkpoint WHERE id=1').fetchone()
            if (json.loads(current[0]) if current else None) != previous:
                raise Blocked('concurrent_collector')
            for row in added:
                if row['ui_id'] is not None:
                    existing = db.execute('SELECT signature FROM messages WHERE ui_id=?', (row['ui_id'],)).fetchone()
                    if existing:
                        if existing[0] != row['signature']:
                            raise Blocked('message_identity_changed')
                        continue
                db.execute('''INSERT INTO messages(signature,sender_id,sender,content,is_self,source_at,observed_at,backfilled,eligible,ui_id)
                              VALUES(:signature,:sender_id,:sender,:content,:is_self,:source_at,:now,:backfilled,:eligible,:ui_id)''',
                           {**row, 'now': now, 'backfilled': int(backfilled),
                            'eligible': int(not baseline and not backfilled and not row['is_self'])})
            db.execute('INSERT INTO checkpoint VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET rows_json=excluded.rows_json,updated=excluded.updated',
                       (json.dumps(visible, ensure_ascii=False), now))
        return len(added)

    def page(self, after=0, limit=200):
        with self.db() as db:
            return [dict(row) for row in db.execute('SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?', (after, min(200, limit)))]

    def status(self, state, error=None):
        with self.db() as db:
            counts = db.execute('SELECT count(*) n,coalesce(max(seq),0) last FROM messages').fetchone()
        value = {'contract': 1, 'source': 'macos_gui', 'state': state, 'error': error,
                 'updated_at': self.clock(), 'messages': counts['n'], 'last_seq': counts['last'],
                 'identity_kind': 'local_ui_label', 'time_kind': 'observed_unless_explicit',
                 'group_count': 1}
        path = self.root / 'health.json'
        temporary = self.root / ('health-' + uuid.uuid4().hex + '.tmp')
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
        temporary.replace(path)
        return value


class Capture:
    def __init__(self, executable, config):
        self.executable = private(executable)
        self.config = config

    def call(self, action, **extra):
        value = {'action': action, 'confirmed_read': True, 'wechat_build': self.config['wechat_build'],
                 'profile': self.config['profile'], **extra}
        try:
            result = subprocess.run([str(self.executable)], input=json.dumps(value), text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=False)
            if len(result.stdout) > 4_000_000:
                raise Blocked('capture_too_large')
            body = json.loads(result.stdout)
            if result.returncode or 'error' in body:
                code = body.get('error')
                allowed = {'permission_required', 'login_required', 'layout_unavailable', 'identity_unresolved', 'chat_not_verified',
                           'scroll_unavailable', 'version_changed', 'layout_too_large', 'desktop_blocked', 'capture_unavailable', 'observer_unavailable'}
                raise Blocked(code if code in allowed else 'capture_unavailable')
            return body
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            raise Blocked('capture_unavailable') from None

    def snapshot(self):
        return self.call('snapshot')

    def changed(self):
        return self.call('watch').get('changed') is True

    def scroll(self, direction):
        self.call('scroll', direction=direction)
        time.sleep(0.4)


class Collector:
    def __init__(self, archive, capture, max_pages=50):
        self.archive, self.capture = archive, capture
        self.config, self.max_pages = archive.config, max_pages
        # A process restart always requires recovery, even with a recent checkpoint.
        self.contiguous = False

    def recovery(self, previous, newest):
        segments = [(normalize(self.config, newest), newest)]
        if not segments[0][0]:
            raise Blocked('empty_view')
        for _ in range(self.max_pages):
            first, snapshot = segments[0]
            count = anchor_end(previous, first)
            if count:
                combined = first
                for rows, _ in segments[1:]:
                    shared = overlap(combined, rows)
                    if not shared:
                        raise Blocked('history_gap')
                    combined = combined + rows[shared:]
                return combined[count:]
            if snapshot['at_top']:
                break
            self.capture.scroll('up')
            older = self.capture.snapshot()
            rows = normalize(self.config, older)
            if not rows or rows == first:
                raise Blocked('history_gap')
            # Every adjacent history page must overlap uniquely before any commit.
            if not overlap(rows, first):
                raise Blocked('history_gap')
            segments.insert(0, (rows, older))
        raise Blocked('history_gap')

    def cycle(self):
        previous, updated = self.archive.checkpoint()
        newest = self.capture.snapshot()
        if not newest['at_bottom']:
            # A caller has explicitly authorized this dedicated window. Jump to
            # the tail, then backfill from the saved anchor if necessary.
            self.capture.scroll('bottom')
            newest = self.capture.snapshot()
        if not newest['at_bottom']:
            raise Blocked('tail_unavailable')
        rows = normalize(self.config, newest)
        if not rows:
            raise Blocked('empty_view')
        if previous is None:
            result = self.archive.commit(None, rows, rows, baseline=True)
        elif rows == previous:
            result = self.archive.commit(previous, rows, [])
        else:
            count = overlap(previous, rows)
            recovering = not self.contiguous or not count
            if recovering:
                try:
                    added = self.recovery(previous, newest)
                finally:
                    self.capture.scroll('bottom')
                # Recheck and ingest the latest tail before committing. If new
                # rows arrived while scrolling, they remain recoverable next time.
                latest = self.capture.snapshot()
                latest_rows = normalize(self.config, latest)
                if not latest['at_bottom'] or latest_rows != rows:
                    raise Blocked('view_changed_during_recovery')
                result = self.archive.commit(previous, rows, added, backfilled=True)
            else:
                result = self.archive.commit(previous, rows, rows[count:])
        self.contiguous = True
        self.archive.status('collecting')
        return result

    def run(self, stop):
        while not stop():
            try:
                self.cycle()
                # Each notification wait is bounded. The fallback source check
                # also catches messages that arrive between subscriptions.
                while not stop():
                    changed = self.capture.changed()
                    if changed:
                        break
                    # AX implementations may omit layout notifications. A bounded
                    # source read after a quiet watch is required for completeness.
                    # An unchanged snapshot writes no additional message records.
                    self.cycle()
            except Blocked as error:
                self.contiguous = False
                self.archive.status('blocked', str(error))
                time.sleep(2)
            except Exception:
                self.contiguous = False
                self.archive.status('blocked', 'collector_unavailable')
                time.sleep(2)


class GUIAgent:
    """The claim/ack interface used by the existing MaiBot group-policy bridge.

    The policy bridge remains responsible for model selection and replies. Its
    existing delegate handles sending. A source lease survives bridge restarts.
    """
    source_kind = 'wechat_gui'

    def __init__(self, delegate, archive, consumer='maibot-macos'):
        self.delegate, self.archive, self.consumer = delegate, archive, consumer
        self.source_status = {'source': 'macos_gui', 'connected': False, 'checked_at': 0}

    def __getattr__(self, name):
        return getattr(self.delegate, name)

    def reader_health(self):
        now = self.archive.clock()
        try:
            value = json_file(self.archive.root / 'health.json')
            connected = value.get('state') == 'collecting' and 0 <= now - value['updated_at'] < 30
        except (OSError, ValueError, KeyError, TypeError):
            connected = False
        self.source_status = {'source': 'macos_gui', 'connected': connected, 'checked_at': now}
        return connected

    def request(self, route, query):
        if route != '/v1/status' or query:
            raise Blocked('unsupported_gui_request')
        return {'ok': self.reader_health(), 'source': 'macos_gui'}

    def status(self):
        value = self.delegate.status()
        return {**value, 'wechat_connected': self.reader_health() and value.get('wechat_connected') is True}

    def reset_live_cursors(self, chat_ids):
        if set(chat_ids) != {self.archive.config['group']['id']} or not self.reader_health():
            raise Blocked('source_unavailable')
        with self.archive.db() as db:
            db.execute('BEGIN IMMEDIATE')
            maximum = db.execute('SELECT coalesce(max(seq),0) FROM messages').fetchone()[0]
            db.execute('INSERT INTO consumers(name,after_seq) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET after_seq=excluded.after_seq,pending=NULL,lease_id=NULL,lease_until=0',
                       (self.consumer, maximum))

    def claim(self, *, chat_ids=(), limit=4, lease_seconds=120, timeout=3,
              require_sender=True, require_at_me=False, replay_existing=False):
        if replay_existing or require_at_me:
            raise Blocked('unsupported_claim_mode')
        if self.archive.config['group']['id'] not in chat_ids or limit < 1:
            return []
        now = self.archive.clock()
        if not self.reader_health():
            return []
        with self.archive.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT OR IGNORE INTO consumers(name) VALUES(?)', (self.consumer,))
            cursor = db.execute('SELECT * FROM consumers WHERE name=?', (self.consumer,)).fetchone()
            if cursor['pending'] and cursor['lease_until'] > now:
                return []
            row = db.execute('SELECT * FROM messages WHERE seq>? AND eligible=1 ORDER BY seq LIMIT 1', (cursor['after_seq'],)).fetchone()
            if row is None:
                return []
            if row['seq'] >= 1_000_000_000:
                raise Blocked('archive_sequence_exhausted')
            lease = uuid.uuid4().hex
            db.execute('UPDATE consumers SET pending=?,lease_id=?,lease_until=? WHERE name=?',
                       (row['seq'], lease, now + min(300, max(1, lease_seconds)), self.consumer))
            epoch = db.execute('SELECT value FROM meta WHERE key="epoch"').fetchone()[0]
        stamp = row['source_at'] or row['observed_at']
        message = SimpleNamespace(seq=1_000_000_000_000 + row['seq'], source_seq=row['seq'], chat_id=self.archive.config['group']['id'], sender=row['sender'],
                                  sender_id=row['sender_id'], content=row['content'], direction='incoming',
                                  message_type='text', is_at_me=False, source_kind='wechat_gui',
                                  timestamp=datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                                  observed_at=datetime.fromtimestamp(row['observed_at'], timezone.utc).isoformat(),
                                  client_id=None, delivery_status='observed')
        return [SimpleNamespace(consumer=self.consumer, message=message, gui_epoch=epoch, gui_lease=lease)]

    def ack(self, delivery):
        self.finish(delivery, True)

    def nack(self, delivery, _reason, retry_delay=10):
        self.finish(delivery, False, retry_delay)

    def finish(self, delivery, accepted, retry_delay=10):
        if delivery.consumer != self.consumer:
            raise Blocked('wrong_consumer')
        with self.archive.db() as db:
            db.execute('BEGIN IMMEDIATE')
            epoch = db.execute('SELECT value FROM meta WHERE key="epoch"').fetchone()[0]
            row = db.execute('SELECT * FROM consumers WHERE name=?', (self.consumer,)).fetchone()
            if epoch != delivery.gui_epoch or not row or row['pending'] != delivery.message.source_seq or row['lease_id'] != delivery.gui_lease:
                raise Blocked('stale_lease')
            if accepted:
                db.execute('UPDATE consumers SET after_seq=?,pending=NULL,lease_id=NULL,lease_until=0 WHERE name=?',
                           (delivery.message.source_seq, self.consumer))
            else:
                db.execute('UPDATE consumers SET lease_until=? WHERE name=?',
                           (self.archive.clock() + min(60, max(1, retry_delay)), self.consumer))

    def get_history(self, chat_id, *, duration_seconds, until=None):
        if chat_id != self.archive.config['group']['id'] or not 0 < duration_seconds <= 31 * 86400:
            raise Blocked('invalid_history_range')
        end = until.timestamp() if until else self.archive.clock()
        with self.archive.db() as db:
            rows = db.execute('SELECT * FROM messages WHERE coalesce(source_at,observed_at)>=? AND coalesce(source_at,observed_at)<? ORDER BY seq',
                              (end-duration_seconds, end)).fetchall()
        return [SimpleNamespace(seq=1_000_000_000_000 + row['seq'], source_seq=row['seq'], chat_id=chat_id, sender=row['sender'], sender_id=row['sender_id'], content=row['content'],
                                direction='outgoing' if row['is_self'] else 'incoming', message_type='text',
                                timestamp=datetime.fromtimestamp(row['source_at'] or row['observed_at'],timezone.utc).isoformat(),
                                observed_at=datetime.fromtimestamp(row['observed_at'],timezone.utc).isoformat(),
                                source_kind='wechat_gui', is_at_me=False) for row in rows]


def attach_mac_gui(delegate, config_path, state):
    config = check_config(json_file(config_path))
    archive = Archive(state, config)
    return GUIAgent(delegate, archive, consumer=getattr(delegate, 'consumer', 'maibot-macos'))


def verify_stream(config, archive, capture):
    snapshot = capture.snapshot()
    current = normalize(config, snapshot)
    if not snapshot['at_bottom'] or len({r['sender_id'] for r in current if not r['is_self']}) < 2:
        raise Blocked('two_test_senders_required')
    if not archive.checkpoint()[0]:
        raise Blocked('collector_not_started')
    with archive.db() as db:
        count = db.execute('SELECT count(DISTINCT sender_id) FROM messages WHERE is_self=0 AND eligible=1').fetchone()[0]
    if count < 2:
        raise Blocked('two_live_test_senders_required')
    print(json.dumps({'source':'macos_gui','local_read_verified':True,'identified_test_senders':count,
                      'maibot_online_verified':False,'backfill_requires_target_test':True}))


def main():
    parser = argparse.ArgumentParser(description='Mac 微信持续采集（本机私有档案）')
    parser.add_argument('action', choices=['layout', 'check', 'verify', 'once', 'run', 'status'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--capture', required=True)
    parser.add_argument('--confirm-read', action='store_true')
    parser.add_argument('--path', type=json.loads, default=[])
    parser.add_argument('--include-values', action='store_true')
    args = parser.parse_args()
    if args.action != 'status' and not args.confirm_read:
        raise Blocked('本人确认测试群、当前账号、屏幕读取及滚动操作后，再使用 --confirm-read。')
    config = check_config(json_file(args.config))
    if args.action == 'status':
        print(json.dumps(json_file(Path(args.state) / 'health.json'), ensure_ascii=False))
        return
    capture = Capture(args.capture, config)
    if args.action == 'layout':
        print(json.dumps(capture.call('layout', path=args.path, include_values=args.include_values), ensure_ascii=False))
        return
    if args.action == 'check':
        result = normalize(config, capture.snapshot())
        print(json.dumps({'source': 'macos_gui', 'rows': len(result), 'identified_senders': len({r['sender_id'] for r in result}),
                          'stable_ui_ids': 'message_id' in config['profile'], 'online': False}))
        return
    archive = Archive(args.state, config)
    if args.action == 'verify':
        verify_stream(config, archive, capture)
        return
    collector = Collector(archive, capture)
    if args.action == 'once':
        with capture_lock(args.state):
            collector.cycle()
            print(json.dumps(archive.status('collecting')))
    else:
        stopped = False
        def stop(*_):
            nonlocal stopped
            stopped = True
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        with capture_lock(args.state):
            try:
                collector.run(lambda: stopped)
            finally:
                archive.status('stopped')


if __name__ == '__main__':
    try:
        main()
    except (Blocked, OSError, ValueError) as error:
        raise SystemExit(str(error))
