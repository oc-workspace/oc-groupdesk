"""Read-only SQLCipher snapshots through the verified, pinned upstream codec."""
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from chatlog_keeper import wechat_db as native
from chatlog_keeper.core._snapshot import _family_signature
from .store import Store
from .vault import unwrap
from .references import text_reference

logging.getLogger('chatlog_keeper').setLevel(logging.CRITICAL)
SUMMARY = re.compile(r'^(?:\[\d+/\d+\]\n)?(?:Group archive summary|グループの保存記録まとめ|群聊存档总结) · ')

def config(path):
    value = json.loads(Path(path).read_text())
    account = value.get('account', '')
    groups = value.get('groups')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', account):
        raise ValueError('Invalid account directory')
    if not isinstance(groups, list) or not 1 <= len(groups) <= 10:
        raise ValueError('Explicit group allowlist required')
    for group in groups:
        if type(group.get('chat_id')) is not int or not 0 < group['chat_id'] < 2**31:
            raise ValueError('Invalid local group identity')
        if not isinstance(group.get('name'), str) or not 1 <= len(group['name']) <= 200:
            raise ValueError('Invalid group name')
    if len({g['chat_id'] for g in groups}) != len(groups) or len({g['name'] for g in groups}) != len(groups):
        raise ValueError('Duplicate group scope')
    return value

class Engine:
    def __init__(self, configuration, source='/wechat', state='/state', secrets='/secrets'):
        self.config = configuration
        self.source = Path(source) / configuration['account'] / 'db_storage'
        self.secrets = Path(secrets)
        self.store = Store(Path(state) / 'archive.sqlite3', configuration['account'], configuration['groups'])
        self.tracking = None
        self.cached_epoch = self.store.epoch
        self.cached_counts = {}
        self.cached_watermarks = {}
        self.key = None
        self.key_stamp = None
        self.contacts = {}
        self.identifiers = set()
        self.self_id = None
        self.signatures = {}
        self.last_success = 0
        self.last_error = 'awaiting_key'
        self.lock = threading.RLock()

    def status(self):
        with self.lock:
            observed = self.tracking() if self.tracking else False
            ready = self.key is not None and (bool(observed and self.last_success and not self.last_error) if self.tracking else time.time()-self.last_success<30)
            return {'ok': ready, 'source': 'chatlog-keeper', 'contract': 1,
                    'state': 'ready' if ready else self.last_error or 'stale',
                    'last_checked': time.time() if ready and observed else self.last_success,
                    'last_reconciled': self.last_success, 'epoch': self.cached_epoch,
                    'counts': dict(self.cached_counts) if ready else {}}

    def load_key(self):
        path = self.secrets / 'wechat-key.enc'
        if not path.is_file():
            raise RuntimeError('awaiting_key')
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if stamp == self.key_stamp:
            return
        key = unwrap(path.read_bytes(), self.config['account'], self.secrets / 'vault-private.pem')
        messages = sorted(p for p in (self.source / 'message').glob('message_*.db') if re.fullmatch(r'message_\d+\.db', p.name))
        if not messages or not native._verify_key_v4(key, native._read_stable_page1(messages[0])):
            raise RuntimeError('key_invalid')
        self.key = key
        self.key_stamp = stamp
        self.signatures.clear()

    def decrypt(self, source, output):
        if not native._decrypt_db_v4(source, self.key, output):
            raise RuntimeError('database_snapshot_unavailable')
        connection = sqlite3.connect('file:' + str(output) + '?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def refresh_contacts(self):
        source = self.source / 'contact/contact.db'
        signature = _family_signature(source)
        if self.signatures.get('contacts') == signature:
            return
        contacts, identifiers, names = {}, set(), {}
        with tempfile.TemporaryDirectory(prefix='reader-contacts-') as directory:
            connection = self.decrypt(source, Path(directory) / 'contact.db')
            try:
                for table in ('contact', 'stranger'):
                    try:
                        rows = connection.execute('SELECT username,local_type,nick_name,remark FROM ' + table)
                    except sqlite3.OperationalError:
                        continue
                    for row in rows:
                        identifier = str(row['username'] or '')
                        if not identifier:
                            continue
                        identifiers.add(identifier)
                        # Personal contact remarks are private annotations,
                        # not a group member's public nickname.
                        nickname = ' '.join(str(row['nick_name'] or '').split())[:120]
                        if nickname:
                            contacts[identifier] = nickname
                        if identifier.endswith('@chatroom'):
                            for name in (row['nick_name'], row['remark']):
                                if name:
                                    names.setdefault(str(name).strip(), set()).add(identifier)
            finally:
                connection.close()
        for group in self.store.groups():
            if group['native_id']:
                continue
            configured = next(g for g in self.config['groups'] if g['chat_id'] == group['chat_id'])
            native_id = configured.get('native_id')
            matches = {native_id} if native_id and native_id in identifiers else names.get(group['name'], set())
            if len(matches) != 1:
                raise RuntimeError('group_mapping_ambiguous')
            self.store.bind(group['chat_id'], next(iter(matches)))
        self.contacts, self.identifiers = contacts, identifiers
        self.signatures['contacts'] = signature

    def resolve_self(self, name_map):
        account = self.config['account']
        known = self.identifiers | set(name_map.values())
        specified = self.config.get('self_id')
        candidates = {identifier for identifier in known if isinstance(identifier, str) and
            (identifier == account or account.startswith(identifier + '_'))}
        if specified:
            candidates = {specified} if specified in known else set()
        if len(candidates) != 1:
            raise RuntimeError('self_identity_unavailable')
        selected = next(iter(candidates))
        if self.self_id and self.self_id != selected:
            raise RuntimeError('self_identity_changed')
        self.self_id = selected

    def normalize(self, row, names, group, shard):
        kind = int(row['local_type']) & 0xFFFF
        if kind not in native._WX_KEPT_TYPES:
            return None
        timestamp = int(row['create_time'] or 0)
        if timestamp <= 0:
            return None
        datetime.fromtimestamp(timestamp, timezone.utc)  # reject invalid native time
        sender_id = names.get(row['real_sender_id'])
        sender_id = str(sender_id) if sender_id else None
        raw = native._decompress_message(row['message_content'])
        reference=text_reference(raw) if kind==49 else None
        if reference is not None:
            text=reference['content']
        elif kind == 1:
            first, separator, rest = raw.partition('\n')
            text = rest if separator and first.strip().rstrip(':') == sender_id else raw
        else:
            text = native._extract_wechat_xml(raw, kind)
        text = text.strip()
        if not text:
            return None
        server = str(row['server_id'] or '')
        if not re.fullmatch(r'[1-9]\d{0,20}', server):
            server = ''
        identity = (self.config['account'], group['native_id'], server or
                    f"local:{shard}:{row['_rowid']}:{timestamp}")
        native_key = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
        is_self = sender_id == self.self_id
        return {'native_key': native_key, 'chat_id': group['chat_id'], 'sender_id': sender_id,
                'sender': self.contacts.get(sender_id), 'content': text, 'source_at': timestamp,
                'observed_at': time.time(), 'is_self': int(is_self), 'msg_type': kind,
                'server_id': server or None, 'is_summary': int(is_self and bool(SUMMARY.match(text))),
                'reference_kind':reference['reference_kind'] if reference else None,
                'reference_server_id':reference['reference_server_id'] if reference else None}

    def refresh_shard(self, source):
        signature = _family_signature(source)
        if self.signatures.get(source.name) == signature:
            return
        with tempfile.TemporaryDirectory(prefix='reader-messages-') as directory:
            connection = self.decrypt(source, Path(directory) / 'messages.db')
            try:
                names = native._load_name_map(connection)
                self.resolve_self(names)
                for group in self.store.groups():
                    table = native._wechat_conversation_table_name(group['native_id'])
                    if not connection.execute('SELECT 1 FROM sqlite_master WHERE type="table" AND name=?', (table,)).fetchone():
                        continue
                    maximum = connection.execute('SELECT COALESCE(MAX(rowid),0) FROM "' + table + '"').fetchone()[0]
                    previous = self.store.position(source.name, group['chat_id'])
                    after = max(0, previous - 128) if maximum >= previous else 0
                    cursor = connection.execute('SELECT rowid _rowid,local_type,create_time,real_sender_id,message_content,server_id FROM "' + table + '" WHERE rowid>? ORDER BY rowid', (after,))
                    while True:
                        batch = cursor.fetchmany(256)
                        if not batch:
                            break
                        rows = [self.normalize(row,names,group,source.name) for row in batch]
                        self.store.ingest(source.name, group['chat_id'], [row for row in rows if row], batch[-1]['_rowid'])
                    self.store.ingest(source.name, group['chat_id'], [], maximum)
            finally:
                connection.close()
        self.signatures[source.name] = signature

    def sync(self):
        with self.lock:
            try:
                self.load_key()
                self.refresh_contacts()
                shards = sorted(p for p in (self.source / 'message').glob('message_*.db') if re.fullmatch(r'message_\d+\.db', p.name))
                if not shards:
                    raise RuntimeError('message_database_missing')
                for source in shards:
                    self.refresh_shard(source)
                if not self.self_id:
                    raise RuntimeError('self_identity_unavailable')
                with self.store.connect() as db:
                    summary=list(db.execute('SELECT chat_id,count(*),max(seq) FROM messages GROUP BY chat_id'))
                self.cached_counts={str(chat):0 for chat in self.store.allowed}
                self.cached_watermarks={chat:0 for chat in self.store.allowed}
                for chat,count,maximum in summary:
                    if chat in self.store.allowed:self.cached_counts[str(chat)]=count;self.cached_watermarks[chat]=maximum
                self.last_success, self.last_error = time.time(), None
            except Exception as exc:
                allowed = {'awaiting_key','key_invalid','database_snapshot_unavailable','group_mapping_ambiguous',
                           'self_identity_unavailable','self_identity_changed','message_database_missing'}
                self.last_error = str(exc) if str(exc) in allowed else type(exc).__name__
                # A changed key or account must not leave an old "ready" lease.
                if self.last_error in {'key_invalid','self_identity_changed','group_mapping_ambiguous'}:
                    self.last_success = 0

    def page(self, chat, after, limit, start=None, end=None):
        with self.lock:
            status=self.status()
            if not status['ok']:raise RuntimeError('source_unavailable')
            if chat not in self.store.allowed:raise KeyError('Unknown group')
            # Empty live pulls are served from memory, without either database.
            if start is None and after>=self.cached_watermarks.get(chat,0):
                return {'epoch':self.cached_epoch,'watermark':self.cached_watermarks.get(chat,0),
                        'messages':[],'next_after':None,'last_checked':status['last_checked']}
            result = self.store.page(chat,after,limit,start,end)
            for row in result['messages']:row['sender'] = self.contacts.get(row['sender_id'])
            result['last_checked'] = status['last_checked']
            return result
