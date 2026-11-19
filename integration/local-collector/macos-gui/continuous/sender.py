"""Guarded optional sender for the existing MaiBot policy bridge on macOS."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import uuid
from mac_gui_stream import Blocked, Capture, private


class MacSender:
    consumer = 'maibot-macos'

    def __init__(self, archive, executable=None, capture=None):
        self.archive = archive
        self.capture = Capture(capture, archive.config) if capture else None
        self.executable = private(executable) if executable else None
        with archive.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS sends(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                          client_id TEXT NOT NULL UNIQUE,content_hash TEXT NOT NULL,status TEXT NOT NULL,
                          created TEXT NOT NULL)''')

    def status(self):
        try:
            from mac_gui_stream import json_file
            health = json_file(self.archive.root / 'health.json')
            ready = health.get('state') == 'collecting' and 0 <= self.archive.clock()-health['updated_at'] < 30
        except (OSError, ValueError, KeyError, TypeError):
            ready = False
        return {'running': ready and self.executable is not None and self.capture is not None,
                'wechat_connected': ready and self.executable is not None and self.capture is not None,
                'queue_depth': 0, 'ui_input_blocked': False,
                'sender_ready': self.executable is not None and self.capture is not None}

    def get_message(self, seq):
        with self.archive.db() as db:
            row = db.execute('SELECT status FROM sends WHERE seq=?', (seq,)).fetchone()
        if not row:
            raise Blocked('send_not_found')
        return SimpleNamespace(seq=seq, delivery_status=row['status'])

    def ensure_chat(self, name, _kind=None):
        group = self.archive.config['group']
        if name != group['name']:
            raise Blocked('group_outside_allowlist')
        return SimpleNamespace(id=group['id'], name=group['name'])

    def send_text(self, chat, text, *, client_id):
        if not self.executable or not self.capture:
            raise Blocked('mac_sender_not_configured')
        if chat != self.archive.config['group']['id'] or not isinstance(text, str) or not 1 <= len(text) <= 200 or '\n' in text or '\r' in text:
            raise Blocked('unsupported_send')
        if not isinstance(client_id, str) or not 1 <= len(client_id) <= 160:
            raise Blocked('invalid_send_id')
        self.capture.snapshot()  # Recheck the bound account and group before typing.
        top = self.archive.config['profile'].get('composer_top')
        if type(top) not in (float, int) or not 0.45 <= top <= 0.88:
            raise Blocked('composer_calibration_required')
        marker = hashlib.sha256(text.encode()).hexdigest()
        with self.archive.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT * FROM sends WHERE client_id=?', (client_id,)).fetchone()
            if prior:
                if prior['content_hash'] != marker:
                    raise Blocked('send_id_conflict')
                return self.receipt(dict(prior), chat, text)
            created = datetime.now(timezone.utc).isoformat()
            # Persist before interacting. A crash or ambiguous UI result cannot cause a resend.
            cursor = db.execute('INSERT INTO sends(client_id,content_hash,status,created) VALUES(?,?,?,?)',
                                (client_id, marker, 'uncertain', created))
            seq = cursor.lastrowid
        state = self.archive.root / 'send-state'
        state.mkdir(mode=0o700, exist_ok=True)
        private(state, directory=True)
        identifier = hashlib.sha256(client_id.encode()).hexdigest()
        temporary = self.archive.root / ('send-' + uuid.uuid4().hex + '.txt')
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        status = 'uncertain'
        try:
            with os.fdopen(fd, 'w') as value:
                value.write(text)
            result = subprocess.run([str(self.executable), 'send', '--chat', self.archive.config['group']['name'],
                                     '--text-file', str(temporary), '--id', identifier, '--state-dir', str(state), '--composer-top', str(top)],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45, text=True, check=False)
            if result.returncode == 0:
                events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                if any(row.get('type') in {'sent_ui_verified', 'already_sent'} for row in events):
                    status = 'unverified'
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        finally:
            temporary.unlink(missing_ok=True)
        with self.archive.db() as db:
            db.execute('UPDATE sends SET status=? WHERE client_id=?', (status, client_id))
        return self.receipt({'seq': seq, 'client_id': client_id, 'created': created, 'status': status}, chat, text)

    @staticmethod
    def receipt(row, chat, text):
        return SimpleNamespace(seq=row['seq'], chat_id=chat, client_id=row['client_id'], timestamp=row['created'],
                               content=text, direction='outgoing', message_type='text', delivery_status=row['status'],
                               verified=False, delivery_error='GUI visible result has no independent delivery receipt')

    def wait_delivery(self, message, *, timeout=30):
        return message
