"""One database source for live ingress and summaries; UI sends stay unchanged."""
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from dataclasses import is_dataclass,replace
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from types import SimpleNamespace
import urllib.error
import urllib.parse
import urllib.request

OFFSET = 1_000_000_000_000
STRIDE = 10_000_000_000

class ReaderUnavailable(RuntimeError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None

class ReaderAgent:
    source_kind='wechat_database'
    def __init__(self, delegate, state, url, token_file, clock=time.time, sleeper=time.sleep):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in {'chatlog-reader','localhost','127.0.0.1'} or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Reader must use the dedicated local endpoint')
        self.delegate,self.consumer = delegate,delegate.consumer
        self.url,self.token_file,self.clock = url.rstrip('/'),Path(token_file),clock
        self.sleeper=sleeper
        self.path = str(Path(state) / 'delivery.sqlite3')
        self.namespaces={}
        self.source_status = {'source':'chatlog-keeper','connected':False,'checked_at':0}
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS reader_epochs(id INTEGER PRIMARY KEY AUTOINCREMENT,epoch TEXT NOT NULL UNIQUE)')
            db.execute('''CREATE TABLE IF NOT EXISTS reader_cursors(chat_id INTEGER PRIMARY KEY,epoch TEXT NOT NULL,
                after_seq INTEGER NOT NULL,cutover REAL NOT NULL,pending_seq INTEGER,retry_until REAL NOT NULL DEFAULT 0)''')
            db.execute('''CREATE TABLE IF NOT EXISTS reader_send_checks(
                queued_seq INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,client_id TEXT NOT NULL,
                epoch TEXT NOT NULL,after_seq INTEGER NOT NULL,started REAL NOT NULL,text_sha256 TEXT NOT NULL,
                ui_status TEXT,source_seq INTEGER,server_id TEXT,confirmed_at REAL,
                UNIQUE(epoch,chat_id,server_id))''')

    def __getattr__(self, name):
        return getattr(self.delegate, name)

    def send_text(self, chat, text, **kwargs):
        # Keep the original guarded UI sender. A pre-send source watermark
        # only permits independent confirmation; it never authorizes a retry.
        anchor=None
        if type(chat) is int and isinstance(text,str) and kwargs.get('client_id'):
            try:
                tail=self.request('/v1/stream',{'chat':chat,'after':'tail','limit':1})
                if (type(tail['watermark']) is int and 0<=tail['watermark']<STRIDE
                    and re.fullmatch(r'[a-f0-9]{32}',tail['epoch'])
                    and math.isfinite(float(tail['cutover_at']))
                    and abs(self.clock()-float(tail['cutover_at']))<=5):anchor=tail
            except Exception:pass
        queued=self.delegate.send_text(chat,text,**kwargs)
        if anchor and type(getattr(queued,'seq',None)) is int and getattr(queued,'delivery_status',None)=='pending':
            try:
                created=datetime.fromisoformat(queued.timestamp.replace('Z','+00:00'))
                if (created.tzinfo is not None and float(anchor['cutover_at'])-2<=created.timestamp()<=self.clock()+2
                    and getattr(queued,'chat_id',None)==chat and getattr(queued,'client_id',None)==kwargs['client_id']):
                    with self.db() as db:
                        db.execute('INSERT OR IGNORE INTO reader_send_checks(queued_seq,chat_id,client_id,epoch,after_seq,started,text_sha256) VALUES(?,?,?,?,?,?,?)',
                            (queued.seq,chat,kwargs['client_id'],anchor['epoch'],anchor['watermark'],float(anchor['cutover_at']),hashlib.sha256(text.strip().encode()).hexdigest()))
            except (AttributeError,TypeError,ValueError,sqlite3.Error):pass
        return queued

    def _source_confirmation(self, anchor):
        after=anchor['after_seq'];upper=None;matches=[]
        for _ in range(5):
            page=self.request('/v1/stream',{'chat':anchor['chat_id'],'after':after,'limit':200})
            if page['epoch']!=anchor['epoch']:return None
            if upper is None:
                upper=page['watermark']
                if type(upper) is not int or not anchor['after_seq']<=upper<STRIDE:return None
            previous=after
            for row in page['messages']:
                seq=row.get('seq')
                if type(seq) is not int or seq<=previous or row.get('chat_id')!=anchor['chat_id']:return None
                previous=seq
                if seq>upper:break
                at=float(row['source_at']);observed=float(row['observed_at'])
                if not math.isfinite(at) or not math.isfinite(observed):return None
                if (type(row.get('is_self')) is int and row['is_self']==1 and row.get('msg_type')==1
                    and re.fullmatch(r'[1-9]\d{0,20}',str(row.get('server_id') or ''))
                    and math.ceil(anchor['started'])<=at<=min(self.clock()+2,anchor['started']+180)
                    and anchor['started']<=observed<=self.clock()+2
                    and isinstance(row.get('content'),str)
                    and hashlib.sha256(row['content'].strip().encode()).hexdigest()==anchor['text_sha256']):
                    matches.append(row)
            next_after=page.get('next_after')
            if next_after is None:break
            if type(next_after) is not int or not after<next_after<=previous:return None
            if next_after>=upper:break
            after=next_after
        else:return None
        return matches[0] if len(matches)==1 else None

    def wait_delivery(self, message, *, timeout=30.0):
        receipt=self.delegate.wait_delivery(message,timeout=timeout)
        if getattr(receipt,'delivery_status',None)!='unverified':return receipt
        with self.db() as db:
            found=db.execute('SELECT * FROM reader_send_checks WHERE queued_seq=?',(receipt.seq,)).fetchone()
        if not found:return receipt
        anchor=dict(found)
        if (receipt.seq!=message.seq or receipt.chat_id!=anchor['chat_id']
            or receipt.client_id!=anchor['client_id'] or receipt.direction!='outgoing'
            or receipt.message_type!='text' or not isinstance(receipt.content,str)
            or hashlib.sha256(receipt.content.strip().encode()).hexdigest()!=anchor['text_sha256']):return receipt
        with self.db() as db:db.execute('UPDATE reader_send_checks SET ui_status=? WHERE queued_seq=?',(receipt.delivery_status,receipt.seq))
        confirmed=anchor['source_seq'] is not None
        if not confirmed:
            with self.db() as db:
                overlap=db.execute('SELECT 1 FROM reader_send_checks WHERE queued_seq<? AND chat_id=? AND epoch=? AND text_sha256=? AND started>=? AND source_seq IS NULL LIMIT 1',
                    (receipt.seq,anchor['chat_id'],anchor['epoch'],anchor['text_sha256'],anchor['started']-180)).fetchone()
            if overlap:return receipt
        # Bounded post-send checks read the event-fed archive, never reconcile
        # raw databases and never run while idle.
        if not confirmed:
            for delay in (0,.25,.5,1,2):
                if not 0<=self.clock()-anchor['started']<=180:break
                if delay:self.sleeper(delay)
                if not 0<=self.clock()-anchor['started']<=180:break
                try:row=self._source_confirmation(anchor)
                except Exception:break
                if row:
                    try:
                        with self.db() as db:
                            db.execute('UPDATE reader_send_checks SET ui_status=?,source_seq=?,server_id=?,confirmed_at=? WHERE queued_seq=?',
                                (receipt.delivery_status,row['seq'],str(row['server_id']),self.clock(),receipt.seq))
                        confirmed=True
                    except sqlite3.Error:pass
                    break
        if not confirmed:return receipt
        if is_dataclass(receipt):return replace(receipt,delivery_status='sent',verified=True,delivery_error=None)
        return SimpleNamespace(**{**vars(receipt),'delivery_status':'sent','verified':True,'delivery_error':None})

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def request(self, route, query):
        try:
            token = self.token_file.read_text().strip()
            if not re.fullmatch(r'[a-f0-9]{64}', token):
                raise ReaderUnavailable('Reader token unavailable')
            request = urllib.request.Request(self.url+route+'?'+urllib.parse.urlencode(query),
                headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
            with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
                body = response.read(4_000_001)
            if len(body)>4_000_000:
                raise OverflowError('Source response too large')
            value = json.loads(body)
            if not re.fullmatch(r'[a-f0-9]{32}', value.get('epoch','')) or not isinstance(value.get('messages'),list):
                raise ReaderUnavailable('Invalid source contract')
            checked = float(value['last_checked'])
            if not math.isfinite(checked) or not -15 <= self.clock()-checked < 30:
                raise ReaderUnavailable('Source snapshot stale')
            self.source_status = {'source':'chatlog-keeper','connected':True,'checked_at':self.clock(),'source_checked_at':checked}
            return value
        except urllib.error.HTTPError as exc:
            self.source_status.update(connected=False,error='reader_http_'+str(exc.code))
            if exc.code == 413:
                raise OverflowError('Source window too large') from None
            raise ReaderUnavailable('Reader rejected request') from None
        except OverflowError:
            raise
        except Exception:
            self.source_status.update(connected=False,error='reader_unavailable')
            raise ReaderUnavailable('Reader unavailable') from None

    def cursor(self, chat, reset=False):
        with self.db() as db:
            row = db.execute('SELECT * FROM reader_cursors WHERE chat_id=?',(chat,)).fetchone()
        if row and not reset:
            return dict(row)
        tail = self.request('/v1/stream', {'chat':chat,'after':'tail','limit':1})
        after,cutover = tail['watermark'],tail['cutover_at']
        if type(after) is not int or not 0 <= after < STRIDE or not math.isfinite(float(cutover)):
            raise ReaderUnavailable('Invalid initial watermark')
        with self.db() as db:
            db.execute('INSERT INTO reader_cursors(chat_id,epoch,after_seq,cutover) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET epoch=excluded.epoch,after_seq=excluded.after_seq,cutover=excluded.cutover,pending_seq=NULL,retry_until=0',
                (chat,tail['epoch'],after,cutover))
        return {'chat_id':chat,'epoch':tail['epoch'],'after_seq':after,'cutover':cutover,'pending_seq':None,'retry_until':0}

    def namespace(self,epoch):
        if epoch not in self.namespaces:
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO reader_epochs(epoch) VALUES(?)',(epoch,))
                number=db.execute('SELECT id FROM reader_epochs WHERE epoch=?',(epoch,)).fetchone()[0]
            value=OFFSET+number*STRIDE
            if value+STRIDE>=2**53:
                raise ReaderUnavailable('Reader namespace exhausted')
            self.namespaces[epoch]=value
        return self.namespaces[epoch]

    def message(self, row, chat, epoch, live=False):
        seq = row.get('seq')
        if type(seq) is not int or not 0<seq<STRIDE or row.get('chat_id')!=chat or row.get('is_self') not in (0,1):
            raise ReaderUnavailable('Cross-group or invalid source record')
        timestamp,observed = float(row['source_at']),float(row['observed_at'])
        if not math.isfinite(timestamp) or timestamp<=0 or not math.isfinite(observed) or observed<=0:
            raise ReaderUnavailable('Invalid original timestamp')
        text,sender,sender_id = row['content'],row.get('sender'),row.get('sender_id')
        if not isinstance(text,str) or sender is not None and not isinstance(sender,str):
            raise ReaderUnavailable('Invalid message data')
        if live and not sender and sender_id:
            sender = '昵称未同步-'+hashlib.sha256(str(sender_id).encode()).hexdigest()[:8]
        own = bool(row['is_self'])
        return SimpleNamespace(seq=self.namespace(epoch)+seq,source_seq=seq,chat_id=chat,content=text,
            sender=sender,sender_id=sender_id,message_type='text' if row['msg_type']==1 else 'media',
            timestamp=datetime.fromtimestamp(timestamp,timezone.utc).isoformat(),
            observed_at=datetime.fromtimestamp(observed,timezone.utc).isoformat(),
            direction='outgoing' if own else 'incoming' if sender_id else 'unknown',
            is_at_me=False,source_kind='wechat_database',
            client_id='groupdesk-summary-native' if row.get('is_summary') else None,
            delivery_status='sent' if own and row.get('server_id') else 'observed' if not own else 'unknown')

    def claim(self, *, chat_ids=(),limit=4,lease_seconds=120,timeout=3,require_sender=True,require_at_me=False,replay_existing=False):
        if replay_existing or require_at_me:
            raise ValueError('Live database ingress never replays history')
        deliveries = []
        for chat in sorted(set(map(int,chat_ids))):
            if len(deliveries)>=limit:
                break
            cursor = self.cursor(chat)
            if self.clock()<cursor['retry_until']:
                continue
            page = self.request('/v1/stream', {'chat':chat,'after':cursor['after_seq'],'limit':200})
            if page['epoch']!=cursor['epoch']:
                self.cursor(chat,reset=True)
                continue
            previous = cursor['after_seq']
            for row in page['messages']:
                message = self.message(row,chat,page['epoch'],live=True)
                if message.source_seq<=previous:
                    raise ReaderUnavailable('Source pagination did not advance')
                previous = message.source_seq
                stale = datetime.fromisoformat(message.timestamp).timestamp()<cursor['cutover']
                eligible = message.direction=='incoming' and message.message_type=='text' and not stale
                eligible = eligible and (not require_sender or bool(message.sender)) and not require_at_me
                if not eligible:
                    with self.db() as db:
                        db.execute('UPDATE reader_cursors SET after_seq=?,pending_seq=NULL,retry_until=0 WHERE chat_id=? AND epoch=?', (message.source_seq,chat,cursor['epoch']))
                    continue
                with self.db() as db:
                    db.execute('UPDATE reader_cursors SET pending_seq=? WHERE chat_id=? AND epoch=?',(message.source_seq,chat,cursor['epoch']))
                deliveries.append(SimpleNamespace(consumer=self.consumer,message=message,reader_epoch=cursor['epoch']))
                # Exactly one unacknowledged record per group: later successes
                # cannot jump over a failed earlier message.
                break
        return deliveries

    def finish(self, delivery, acknowledged, retry_delay=10):
        if delivery.consumer!=self.consumer:
            raise ValueError('Wrong reader consumer')
        message=delivery.message
        with self.db() as db:
            row=db.execute('SELECT * FROM reader_cursors WHERE chat_id=?',(message.chat_id,)).fetchone()
            if not row or row['epoch']!=delivery.reader_epoch or row['pending_seq']!=message.source_seq:
                raise ValueError('Stale or unordered reader delivery')
            if acknowledged:
                db.execute('UPDATE reader_cursors SET after_seq=?,pending_seq=NULL,retry_until=0 WHERE chat_id=?',(message.source_seq,message.chat_id))
            else:
                db.execute('UPDATE reader_cursors SET retry_until=? WHERE chat_id=?',(self.clock()+max(1,min(60,float(retry_delay))),message.chat_id))

    def ack(self, delivery):
        self.finish(delivery,True)

    def nack(self, delivery, _reason, retry_delay=10):
        self.finish(delivery,False,retry_delay)

    def get_history(self, chat, *, duration_seconds, until=None):
        identifier=int(chat.id if hasattr(chat,'id') else chat)
        end=until or datetime.now(timezone.utc)
        if end.tzinfo is None or not 0<float(duration_seconds)<=31*86400:
            raise ValueError('Invalid history window')
        start=end-timedelta(seconds=float(duration_seconds))
        after,epoch,result,size=0,None,[],0
        while True:
            page=self.request('/v1/history',{'chat':identifier,'start':start.timestamp(),'end':end.timestamp(),'after':after,'limit':200})
            if epoch and page['epoch']!=epoch:
                raise ReaderUnavailable('Source account changed during history read')
            epoch=page['epoch']
            for row in page['messages']:
                message=self.message(row,identifier,page['epoch'])
                if not start.timestamp()<=float(row['source_at'])<end.timestamp():
                    raise ReaderUnavailable('History escaped requested window')
                if message.source_seq<=after:
                    raise ReaderUnavailable('History did not advance')
                result.append(message);size+=len(message.content.encode())
                if len(result)>5000 or size>1_200_000:
                    raise OverflowError('Summary source too large')
            next_after=page.get('next_after')
            if next_after is None:
                return result
            if type(next_after) is not int or next_after<=after:
                raise ReaderUnavailable('History pagination did not advance')
            after=next_after

def attach_reader(delegate,state):
    url=os.environ.get('CHATLOG_READER_URL','').strip()
    return ReaderAgent(delegate,state,url,os.environ.get('CHATLOG_READER_TOKEN_FILE','/reader-client/api-token')) if url else delegate

if __name__=='__main__':
    arguments=__import__('sys').argv[1:]
    if os.environ.get('CHATLOG_READER_URL') and arguments and arguments[0] in {'prepare','recovery'}:
        state=Path(os.environ.get('BRIDGE_STATE','/state'))
        agent=attach_reader(SimpleNamespace(consumer='maibot-gt'),state)
        groups=json.loads((state/'groups.json').read_text()).values()
        if arguments==['prepare']:
            for group in groups:agent.cursor(int(group['chat_id']))
            print(json.dumps({'reader_cursors_prepared':True}))
        elif arguments[0]=='recovery' and len(arguments)==2:
            end=datetime.fromtimestamp(float(arguments[1]),timezone.utc)
            rows=[]
            for group in groups:
                for message in agent.get_history(int(group['chat_id']),duration_seconds=12*3600,until=end):
                    if message.direction=='incoming' and message.message_type=='text' and message.sender:
                        rows.append({'seq':message.seq,'chat_id':str(message.chat_id),'sender':message.sender,'content':message.content,
                            'message_type':'text','direction':'incoming','source_at':datetime.fromisoformat(message.timestamp).timestamp(),'is_at_me':False})
            print(json.dumps({'rows':rows},ensure_ascii=False))
        else:raise SystemExit('Invalid reader maintenance command')
    else:
        raise SystemExit('Use prepare with the configured reader')
