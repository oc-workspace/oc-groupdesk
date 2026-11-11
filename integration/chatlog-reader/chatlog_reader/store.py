"""Only allowlisted conversations are indexed; sequence IDs survive restarts."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
import uuid

OFFSET = 1_000_000_000_000

class Store:
    def __init__(self, path, account, groups):
        self.path = str(path)
        Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS groups(chat_id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,native_id TEXT UNIQUE);
                CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,native_key TEXT NOT NULL UNIQUE,
                  chat_id INTEGER NOT NULL,sender_id TEXT,sender TEXT,content TEXT NOT NULL,source_at REAL NOT NULL,
                  observed_at REAL NOT NULL,is_self INTEGER NOT NULL,msg_type INTEGER NOT NULL,server_id TEXT,is_summary INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS messages_history ON messages(chat_id,source_at,seq);
                CREATE INDEX IF NOT EXISTS messages_stream ON messages(chat_id,seq);
                CREATE TABLE IF NOT EXISTS positions(shard TEXT NOT NULL,chat_id INTEGER NOT NULL,max_rowid INTEGER NOT NULL,PRIMARY KEY(shard,chat_id));
            ''')
            columns={r['name'] for r in db.execute('PRAGMA table_info(messages)')}
            for field in ('reference_kind','reference_server_id'):
                if field not in columns:db.execute('ALTER TABLE messages ADD COLUMN '+field+' TEXT')
            db.execute('CREATE INDEX IF NOT EXISTS messages_server_reference ON messages(chat_id,server_id)')
            previous = db.execute('SELECT value FROM meta WHERE key="account"').fetchone()
            if previous and previous[0] != account:
                raise ValueError('Archive account changed; use a separate data directory')
            db.execute('INSERT OR IGNORE INTO meta VALUES("account",?)', (account,))
            db.execute('INSERT OR IGNORE INTO meta VALUES("epoch",?)', (uuid.uuid4().hex,))
            for group in groups:
                row = db.execute('SELECT name FROM groups WHERE chat_id=?', (group['chat_id'],)).fetchone()
                if row and row[0] != group['name']:
                    raise ValueError('Group identity changed')
                db.execute('INSERT OR IGNORE INTO groups(chat_id,name) VALUES(?,?)', (group['chat_id'],group['name']))
        self.allowed = {group['chat_id'] for group in groups}

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def quote_target(self, chat, server_id):
        """Identify one own text and reject identical bodies in this chat."""
        with self.connect() as db:
            rows=db.execute('SELECT seq,content,is_self,msg_type FROM messages WHERE chat_id=? AND server_id=? LIMIT 2',(chat,server_id)).fetchall()
            if len(rows)!=1 or rows[0]['is_self']!=1 or rows[0]['msg_type']!=1:return None
            row=rows[0]
            same=db.execute('SELECT count(*) FROM messages WHERE chat_id=? AND is_self=1 AND msg_type=1 AND content=?',(chat,row['content'])).fetchone()[0]
        return {'seq':row['seq'],'server_id':server_id,'content':row['content'],'unique_text':same==1}

    @property
    def epoch(self):
        with self.connect() as db:
            return db.execute('SELECT value FROM meta WHERE key="epoch"').fetchone()[0]

    def groups(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM groups ORDER BY chat_id') if row['chat_id'] in self.allowed]

    def bind(self, chat, native_id):
        if chat not in self.allowed or not native_id.endswith('@chatroom'):
            raise ValueError('Unknown group')
        with self.connect() as db:
            previous = db.execute('SELECT native_id FROM groups WHERE chat_id=?', (chat,)).fetchone()[0]
            if previous and previous != native_id:
                raise ValueError('Refusing group identity replacement')
            db.execute('UPDATE groups SET native_id=? WHERE chat_id=?', (native_id,chat))

    def position(self, shard, chat):
        with self.connect() as db:
            row = db.execute('SELECT max_rowid FROM positions WHERE shard=? AND chat_id=?', (shard,chat)).fetchone()
            return row[0] if row else 0

    def ingest(self, shard, chat, rows, maximum):
        if chat not in self.allowed or any(row['chat_id'] != chat for row in rows):
            raise ValueError('Cross-group index write')
        with self.connect() as db:
            for row in rows:
                row={**row,'reference_kind':row.get('reference_kind'),'reference_server_id':row.get('reference_server_id')}
                existing=db.execute('SELECT chat_id FROM messages WHERE native_key=:native_key',row).fetchone()
                if existing:
                    if existing[0]!=chat:
                        raise ValueError('Native identity crossed groups')
                    db.execute('UPDATE messages SET sender_id=:sender_id,sender=:sender,content=:content,is_self=:is_self,msg_type=:msg_type,server_id=:server_id,is_summary=:is_summary,reference_kind=:reference_kind,reference_server_id=:reference_server_id WHERE native_key=:native_key',row)
                else:
                    db.execute('''INSERT INTO messages(native_key,chat_id,sender_id,sender,content,source_at,observed_at,is_self,msg_type,server_id,is_summary,reference_kind,reference_server_id)
                        VALUES(:native_key,:chat_id,:sender_id,:sender,:content,:source_at,:observed_at,:is_self,:msg_type,:server_id,:is_summary,:reference_kind,:reference_server_id)''', row)
            db.execute('INSERT INTO positions VALUES(?,?,?) ON CONFLICT(shard,chat_id) DO UPDATE SET max_rowid=excluded.max_rowid', (shard,chat,maximum))

    def summary_stats(self, chat, start, end, through=None):
        if chat not in self.allowed:raise KeyError('Unknown group')
        with self.connect() as db:
            db.execute('BEGIN')
            maximum=db.execute('SELECT COALESCE(MAX(seq),0) FROM messages WHERE chat_id=?',(chat,)).fetchone()[0]
            through=maximum if through is None else min(through,maximum)
            row=db.execute('''SELECT count(*) count,COALESCE(sum(length(content)),0) text_chars,
                COALESCE(max(length(content)),0) max_text_chars
                FROM messages WHERE chat_id=? AND seq<=? AND source_at>=? AND source_at<?
                AND is_summary=0 AND (is_self=0 OR server_id IS NOT NULL)''',(chat,through,start,end)).fetchone()
            return {'epoch':self.epoch,'through':through,**dict(row)}

    def page(self, chat, after, limit=200, start=None, end=None, *, through=None, summary=False):
        if chat not in self.allowed:
            raise KeyError('Unknown group')
        clauses = ['chat_id=?','seq>?']
        args = [chat,after]
        if start is not None:
            clauses += ['source_at>=?','source_at<?']
            args += [start,end]
        if through is not None:
            clauses += ['seq<=?'];args += [through]
        if summary:
            clauses += ['is_summary=0','(is_self=0 OR server_id IS NOT NULL)']
        with self.connect() as db:
            watermark = db.execute('SELECT COALESCE(MAX(seq),0) FROM messages WHERE chat_id=?', (chat,)).fetchone()[0]
            rows = [dict(row) for row in db.execute('SELECT * FROM messages WHERE '+' AND '.join(clauses)+' ORDER BY seq LIMIT ?', [*args,limit+1])]
        with self.connect() as db:
            for row in rows:
                if row.get('reference_kind')!='text_reply':continue
                reference={'kind':'text_reply','server_id':row.get('reference_server_id'),'is_bot':False}
                if row.get('reference_server_id') and row['is_self']==0:
                    parents=db.execute('SELECT content FROM messages WHERE chat_id=? AND server_id=? AND is_self=1 LIMIT 2',(chat,row['reference_server_id'])).fetchall()
                    if len(parents)==1:reference.update(is_bot=True,bot_text=parents[0]['content'][:600])
                row['reference']=reference
        more = len(rows) > limit
        rows = rows[:limit]
        # A bounded response never silently truncates a message or skips rows.
        while len(json.dumps(rows,ensure_ascii=False).encode()) > 2_500_000:
            if len(rows) == 1:
                raise OverflowError('Message exceeds response limit')
            rows = rows[:max(1,len(rows)//2)]
            more = True
        return {'epoch':self.epoch,'watermark':watermark,'messages':rows,
                'next_after':rows[-1]['seq'] if more and rows else None}

    def counts(self):
        with self.connect() as db:
            return {str(chat):db.execute('SELECT COUNT(*) FROM messages WHERE chat_id=?',(chat,)).fetchone()[0] for chat in self.allowed}
