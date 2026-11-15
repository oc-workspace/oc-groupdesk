"""Per-group, opt-in welcome for verified native group-join notices.

The Reader cursor starts at the current tail when a group first opts in. A
durable reservation prevents a crash or uncertain UI result from resending.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import time

import groupdesk_runtime as gd

PREFIX = '[GT_GROUP_JOIN_V1]'
MAX_AGE = 10 * 60
MESSAGES = {
    'zh': '欢迎加入群聊！很高兴认识你～',
    'en': 'Welcome to the group! Glad to meet you!',
    'ja': 'グループへようこそ！よろしくお願いします！',
    'ko': '그룹에 오신 걸 환영해요! 반가워요!',
}


def parse_join(row):
    if row.get('msg_type') != 10000 or row.get('is_self') != 0:
        return None
    content = row.get('content')
    if not isinstance(content, str) or not content.startswith(PREFIX):
        return None
    try:
        data = json.loads(content[len(PREFIX):])
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or set(data) != {'inviter', 'newcomers'} or not isinstance(data['inviter'], str):
        return None
    names = data['newcomers']
    if not isinstance(names, list) or not 1 <= len(names) <= 10:
        return None
    if any(not isinstance(n, str) or not 1 <= len(n.strip()) <= 120 for n in names):
        return None
    names = [n.strip() for n in names]
    if len(names) != len(set(names)) or any(n == data['inviter'] for n in names):
        return None
    return names


def welcome_text(profile):
    language = profile.get('policy', {}).get('language', {})
    code = language.get('fixed') if language.get('mode') == 'fixed' else language.get('fallback', 'zh-CN')
    return MESSAGES.get(str(code).split('-')[0], MESSAGES['en'])


class Journal:
    def __init__(self, path=None):
        self.path = Path(path) if path else gd.SNAPSHOT.parent / 'auto-welcome.sqlite3'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS cursors(
                    chat_id INTEGER PRIMARY KEY,epoch TEXT NOT NULL,seq INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(
                    id TEXT PRIMARY KEY,chat_id INTEGER NOT NULL,source_seq INTEGER NOT NULL,
                    source_at REAL NOT NULL,names TEXT NOT NULL,status TEXT NOT NULL,
                    send_seq INTEGER,error TEXT,reserved_at REAL);
                CREATE INDEX IF NOT EXISTS welcome_jobs ON jobs(status,source_at);
            ''')
        self.path.chmod(0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()


def enabled(profile, now):
    return gd.available(profile, now) and profile.get('policy', {}).get('auto_welcome') is True


def scan_group(bridge, journal, chat, profile, now):
    with journal.db() as db:
        cursor = db.execute('SELECT epoch,seq FROM cursors WHERE chat_id=?', (chat,)).fetchone()
    if cursor is None:
        tail = bridge.agent.request('/v1/stream', {'chat': chat, 'after': 'tail', 'limit': 1})
        with journal.db() as db:
            db.execute('INSERT OR IGNORE INTO cursors VALUES(?,?,?)',
                       (chat, tail['epoch'], tail['watermark']))
        return
    page = bridge.agent.request('/v1/stream', {'chat': chat, 'after': cursor['seq'], 'limit': 200})
    if page['epoch'] != cursor['epoch']:
        tail = bridge.agent.request('/v1/stream', {'chat': chat, 'after': 'tail', 'limit': 1})
        with journal.db() as db:
            db.execute('UPDATE cursors SET epoch=?,seq=? WHERE chat_id=?',
                       (tail['epoch'], tail['watermark'], chat))
            db.execute('UPDATE jobs SET status="attention",error="reader_epoch_changed" WHERE chat_id=? AND status="queued"', (chat,))
        return
    rows = page['messages']
    last = cursor['seq']
    with journal.db() as db:
        for row in rows:
            seq = row.get('seq')
            if row.get('chat_id') != chat or type(seq) is not int or seq <= last or seq > page['watermark']:
                raise ValueError('Reader welcome cursor crossed group or moved backwards')
            last = seq
            names = parse_join(row)
            if names is None:
                continue
            source_at = row.get('source_at')
            if type(source_at) not in (int, float) or not now - MAX_AGE <= source_at <= now + 15:
                continue
            job_id = f'welcome:{chat}:{page["epoch"]}:{seq}'
            db.execute('INSERT OR IGNORE INTO jobs(id,chat_id,source_seq,source_at,names,status) VALUES(?,?,?,?,?,"queued")',
                       (job_id, chat, seq, source_at, json.dumps(names, ensure_ascii=False)))
        db.execute('UPDATE cursors SET seq=? WHERE chat_id=? AND epoch=?', (last, chat, cursor['epoch']))


def settle(bridge, journal, now):
    with journal.db() as db:
        db.execute('UPDATE jobs SET status="attention",error="uncertain_after_restart" WHERE status="reserved" AND reserved_at<?', (now-120,))
        jobs = db.execute('SELECT id,send_seq FROM jobs WHERE status="submitted" ORDER BY source_at LIMIT 10').fetchall()
    for job in jobs:
        try:
            result = bridge.agent.get_message(job['send_seq'])
        except Exception:
            continue
        state = result.delivery_status
        if state == 'pending':
            continue
        status = 'sent' if state == 'sent' else 'attention'
        error = None if status == 'sent' else 'delivery_' + state + ':' + str(result.delivery_error or '')[:100]
        with journal.db() as db:
            db.execute('UPDATE jobs SET status=?,error=? WHERE id=? AND status="submitted"',
                       (status, error, job['id']))


def step(bridge, conf, status, active, reader, now=None):
    now = time.time() if now is None else now
    journal = Journal()
    settle(bridge, journal, now)
    chats = {int(chat): external for chat, external in conf['groups'].items()}
    for chat in chats:
        profile = gd.profile(bridge.policy.cfg, str(chat))
        if not active or not enabled(profile, now):
            with journal.db() as db:
                db.execute('DELETE FROM cursors WHERE chat_id=?', (chat,))
                db.execute('UPDATE jobs SET status="attention",error="welcome_disabled" WHERE chat_id=? AND status="queued"', (chat,))
            continue
        if reader:
            scan_group(bridge, journal, chat, profile, now)
    if not active or not reader or status.get('wechat_connected') is not True or status.get('running') is not True:
        return
    if status.get('ui_input_blocked') or status.get('sender_queue_depth', status.get('queue_depth')) != 0:
        return
    if bridge.send_lock.locked() or not bridge.control().get('send_enabled'):
        return
    if bridge.health.get('robot', {}).get('state') != 'active':
        return
    with journal.db() as db:
        job = db.execute('SELECT * FROM jobs WHERE status="queued" ORDER BY source_at,id LIMIT 1').fetchone()
        if job is None:
            return
        profile = gd.profile(bridge.policy.cfg, str(job['chat_id']))
        if not enabled(profile, now) or now - job['source_at'] > MAX_AGE:
            db.execute('UPDATE jobs SET status="attention",error="welcome_expired_or_disabled" WHERE id=?', (job['id'],))
            return
        db.execute('UPDATE jobs SET status="reserved",reserved_at=? WHERE id=? AND status="queued"', (now, job['id']))
    try:
        client_id = 'auto-welcome-' + hashlib.sha256(job['id'].encode()).hexdigest()[:32]
        result = bridge.agent.send_text(job['chat_id'], welcome_text(profile),
                                        mentions=json.loads(job['names']), client_id=client_id)
    except Exception as exc:
        with journal.db() as db:
            db.execute('UPDATE jobs SET status="attention",error=? WHERE id=? AND status="reserved"',
                       (type(exc).__name__, job['id']))
        return
    with journal.db() as db:
        db.execute('UPDATE jobs SET status="submitted",send_seq=? WHERE id=? AND status="reserved"',
                   (result.seq, job['id']))
