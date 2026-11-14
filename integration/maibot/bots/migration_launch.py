"""One-time migration greeting and historical mention replay for a bound bot.

The Reader supplies history; only the normal Policy/MaiBot path creates replies.
Local reservations make uncertain WeChat sends operator-visible, never retried.
"""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time

import bot_names
import groupdesk_runtime as gd
from reply_mention import member_name

GREETINGS = (
    '我搬到新家啦，刚把行李放好就回来上班！想你们啦～',
    '新家安顿好，马上打卡返工！这段时间有点想大家啦～',
    '搬家任务完成，我又回来群里上班啦！有没有想我一点点？',
    '从新家探出头来报到！我回来啦，想你们啦～',
    '新窝已经收拾妥当，今天正式回群上班！好久不见，想你们啦～',
)
GREETINGS_EN = (
    "I moved into a new home and came straight back to work! Missed you all!",
    "New place, boxes unpacked, and I'm back on duty. I missed you all!",
    "Reporting in from my new home! I'm back and ready to chat. Missed you!",
    "The move is done, so I'm back in the group and back at work. Missed everyone!",
    "Fresh home, familiar friends: I'm back on the job. Did you miss me a little?",
)


class Journal:
    def __init__(self):
        self.path = gd.SNAPSHOT.parent / 'migration-launch.sqlite3'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS launches(id TEXT PRIMARY KEY, scanned INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,launch_id TEXT NOT NULL,kind TEXT NOT NULL,
                chat_id INTEGER NOT NULL,external_id TEXT NOT NULL,source_seq INTEGER NOT NULL DEFAULT 0,
                sender TEXT,text TEXT,source_at REAL,turn_id TEXT,status TEXT NOT NULL,error TEXT);
              CREATE INDEX IF NOT EXISTS migration_jobs_order ON jobs(launch_id,kind,status,source_at,chat_id);
            ''')
        self.path.chmod(0o600)

    @contextmanager
    def db(self):
        connection=sqlite3.connect(self.path,timeout=15)
        connection.row_factory=sqlite3.Row
        try:
            with connection:yield connection
        finally:connection.close()

    def seed(self,plan,groups):
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO launches(id) VALUES(?)',(plan['id'],))
            for external in plan['greeting_groups']:
                chat=groups.get(external)
                if chat is None:raise ValueError('Greeting group is not bound to this bot')
                digest=hashlib.sha256((plan['id']+external).encode()).digest()
                text=GREETINGS[int.from_bytes(digest[:4],'big')%len(GREETINGS)]
                db.execute('INSERT OR IGNORE INTO jobs(id,launch_id,kind,chat_id,external_id,text,status) VALUES(?,?,?,?,?,?,?)',
                    ('greet:'+plan['id']+':'+external,plan['id'],'greet',chat,external,text,'queued'))

    def one(self,launch,kind,status):
        with self.db() as db:
            return db.execute('SELECT * FROM jobs WHERE launch_id=? AND kind=? AND status=? ORDER BY source_at,chat_id,id LIMIT 1',
                              (launch,kind,status)).fetchone()

    def change(self,job,status,**fields):
        allowed={'turn_id','error'}
        if set(fields)-allowed:raise ValueError('Unexpected journal field')
        with self.db() as db:
            values=[status,*fields.values(),job]
            db.execute('UPDATE jobs SET status=?'+''.join(','+key+'=?' for key in fields)+' WHERE id=?',values)

    def text(self,job,text):
        with self.db() as db:
            db.execute('UPDATE jobs SET text=? WHERE id=? AND status="queued"',(text,job))

    def progress(self,plan):
        with self.db() as db:
            scanned=bool(db.execute('SELECT scanned FROM launches WHERE id=?',(plan['id'],)).fetchone()['scanned'])
            rows=db.execute('SELECT kind,external_id,status,count(*) n FROM jobs WHERE launch_id=? GROUP BY kind,external_id,status',(plan['id'],)).fetchall()
        done=sorted({r['external_id'] for r in rows if r['kind']=='greet' and r['status']=='sent'})
        count=lambda status:sum(r['n'] for r in rows if r['kind']=='catchup' and r['status']==status)
        attention=sum(r['n'] for r in rows if r['status']=='attention')
        pending=sum(r['n'] for r in rows if r['status'] in ('queued','reserved','submitting','submitted'))
        return {'launch_id':plan['id'],'activation_generation':plan['activation_generation'],
                'greeting_done':done,'catchup_scanned':sum(r['n'] for r in rows if r['kind']=='catchup'),
                'catchup_sent':count('sent'),'catchup_attention':sum(r['n'] for r in rows if r['kind']=='catchup' and r['status']=='attention'),
                'state':'attention' if attention else 'completed' if scanned and not pending else 'running'}


def active(bridge,plan):
    if not bridge.control()['enabled'] or not bridge.control()['send_enabled']:return False
    robot=bridge.health.get('robot',{})
    return robot.get('state')=='active' and robot.get('activation_generation')==plan['activation_generation']


def remote_active(plan):
    state=gd.api('/bot-state')
    return state.get('enabled') is True and state.get('activation_generation')==plan['activation_generation']


def source_page(agent,chat,start,end):
    stats=agent.request('/v1/history/stats',{'chat':chat,'start':start,'end':end})
    epoch,through=stats['epoch'],stats['through']
    after=0;rows=[]
    while True:
        page=agent.request('/v1/history',{'chat':chat,'start':start,'end':end,'after':after,
            'limit':200,'through':through,'summary':1})
        if page['epoch']!=epoch:raise ValueError('Reader history epoch changed')
        for row in page['messages']:
            if row['chat_id']!=chat or type(row['seq']) is not int or row['seq']<=after or row['seq']>through:
                raise ValueError('Reader history crossed group or cursor')
            after=row['seq'];rows.append(row)
        next_after=page.get('next_after')
        if next_after is None:break
        if next_after!=after:raise ValueError('Reader page cursor changed')
        if len(rows)>100000:raise ValueError('Migration history requires operator review')
    return epoch,rows


def text_reply(row):
    return row.get('msg_type')==49 and isinstance(row.get('reference'),dict) and row['reference'].get('kind')=='text_reply'


def addressed(row,config,chat):
    if row.get('msg_type')!=1 and not text_reply(row):return False
    return bool((row.get('reference') or {}).get('is_bot') is True and text_reply(row)
                or isinstance(row.get('content'),str) and bot_names.addressed(config,chat,row['content']))


def source_text(row):
    text=row['content']
    reference=row.get('reference') or {}
    if text_reply(row) and reference.get('is_bot') is True and isinstance(reference.get('bot_text'),str):
        text+='\n引用当前机器人消息：\n'+reference['bot_text'][:600]
    return text


def answered_indices(rows,config,chat):
    """Match each bot reply to at most one earlier addressed message."""
    candidates=[];matched=set();by_server={}
    for index,row in enumerate(rows):
        if row.get('msg_type')!=1 and not text_reply(row):continue
        if row.get('is_self')==0:
            if not addressed(row,config,chat):continue
            candidates.append(index)
            if row.get('server_id'):by_server[row['server_id']]=index
            continue
        if row.get('is_self')!=1:continue
        referenced=by_server.get(row.get('reference_server_id'))
        if referenced is not None and referenced not in matched:
            matched.add(referenced);continue
        body=row.get('content') or ''
        for prior in reversed(candidates):
            if prior in matched:continue
            sender=member_name(rows[prior].get('sender'))
            if sender and body.lstrip().startswith('@'+sender):
                matched.add(prior);break
    return matched


def scan(bridge,plan,journal,groups):
    start=datetime.fromisoformat(plan['catchup_from'].replace('Z','+00:00')).timestamp()
    end=datetime.fromisoformat(plan['catchup_through'].replace('Z','+00:00')).timestamp()
    if not 0<start<end<=time.time()+30:raise ValueError('Invalid migration history window')
    candidates=[]
    for external,chat in groups.items():
        profile=gd.profile(bridge.policy.cfg,str(chat))
        if not gd.available(profile,time.time()):raise ValueError('Bound group profile is unavailable')
        # Reader windows are limited to 31 days. Split longer migrations without
        # dropping messages or changing the originally approved endpoints.
        cursor=start;all_rows=[];epochs=[]
        while cursor<end:
            stop=min(cursor+30*86400,end)
            epoch,rows=source_page(bridge.agent,chat,cursor,stop)
            all_rows.extend(rows);epochs.append(epoch)
            cursor=stop
        if len(set(epochs))!=1:raise ValueError('Reader history epoch changed during migration scan')
        matched=answered_indices(all_rows,bridge.policy.cfg,str(chat))
        for index,row in enumerate(all_rows):
            if row.get('is_self')!=0 or index in matched or not addressed(row,bridge.policy.cfg,str(chat)):continue
            text=source_text(row);sender=member_name(row.get('sender'))
            job='catch:'+plan['id']+':'+str(chat)+':'+epochs[0]+':'+str(row['seq'])
            candidates.append((job,plan['id'],'catchup',chat,external,row['seq'],sender,text,row['source_at'],
                               'queued' if sender else 'attention',None if sender else 'sender_unavailable'))
    with journal.db() as db:
        for item in candidates:
            db.execute('INSERT OR IGNORE INTO jobs(id,launch_id,kind,chat_id,external_id,source_seq,sender,text,source_at,status,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)',item)
        db.execute('UPDATE launches SET scanned=1 WHERE id=?',(plan['id'],))


async def greet(bridge,plan,journal,job):
    if not active(bridge,plan):return
    async with bridge.send_lock:
        if not active(bridge,plan):return
        profile=gd.profile(bridge.policy.cfg,str(job['chat_id']))
        if not gd.available(profile,time.time()) or not await asyncio.to_thread(gd.check_remote_revision,profile):return
        if not await asyncio.to_thread(remote_active,plan):return
        text=job['text']
        if not gd.language_allowed(profile,text):
            digest=hashlib.sha256(job['id'].encode()).digest()
            text=GREETINGS_EN[int.from_bytes(digest[:4],'big')%len(GREETINGS_EN)]
            if not gd.language_allowed(profile,text):
                journal.change(job['id'],'attention',error='greeting_language_unavailable');return
            journal.text(job['id'],text)
        # Persist the reservation before touching the UI. An uncertain result
        # stays visible for manual review and is never submitted again.
        journal.change(job['id'],'reserved')
        identifier='migration-greet-'+hashlib.sha256(job['id'].encode()).hexdigest()
        if not bridge.ledger.reserve(identifier):
            journal.change(job['id'],'attention',error='duplicate_or_uncertain_send');return
        try:
            queued=await asyncio.to_thread(bridge.agent.send_text,int(job['chat_id']),text,client_id=identifier)
            receipt=await asyncio.to_thread(bridge.agent.wait_delivery,queued,timeout=60)
            bridge.ledger.finish(identifier,receipt.delivery_status,receipt.seq)
            journal.change(job['id'],'sent' if receipt.delivery_status=='sent' else 'attention',
                           error=None if receipt.delivery_status=='sent' else 'delivery_'+receipt.delivery_status)
        except Exception as exc:
            journal.change(job['id'],'attention',error=type(exc).__name__)


def settle(bridge,journal,job):
    turn=job['turn_id']
    with bridge.policy.db() as db:
        send=db.execute('SELECT status FROM sends WHERE turn_id=?',(turn,)).fetchone()
        pending=db.execute('SELECT id FROM pending WHERE id=?',(turn,)).fetchone()
        active_turn=db.execute('SELECT status,expires FROM turns WHERE id=?',(turn,)).fetchone()
    if send and send['status']=='reserved' and active_turn and active_turn['status']=='active' and active_turn['expires']>time.time():
        return
    if send:
        journal.change(job['id'],'sent' if send['status']=='sent' else 'attention',
                       error=None if send['status']=='sent' else 'reply_'+send['status'])
    elif pending or active_turn and active_turn['status']=='active' and active_turn['expires']>time.time():
        return
    else:journal.change(job['id'],'attention',error='reply_not_sent')


def enqueue(bridge,plan,journal,job):
    if not active(bridge,plan):return
    if not remote_active(plan):return
    sender=member_name(job['sender'])
    if not sender:
        journal.change(job['id'],'attention',error='sender_unavailable');return
    with bridge.policy.db() as db:
        key=str(job['chat_id'])+':'+hashlib.sha256(sender.encode()).hexdigest()[:24]
        if db.execute('SELECT 1 FROM pending WHERE sender=?',(key,)).fetchone():return
        if db.execute('SELECT 1 FROM turns WHERE sender=? AND status="active" AND expires>?',(key,time.time())).fetchone():return
        if bridge.policy._quota(db,'direct',bridge.policy.clock(),explicit=True,chat_id=str(job['chat_id'])):return
    seed=int.from_bytes(hashlib.sha256(job['id'].encode()).digest()[:8],'big')%(1<<60)
    seq=(1<<62)+seed
    original=datetime.fromtimestamp(job['source_at'],timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    text='[迁移暂停期间未回复的点名；原消息时间 '+original+'；请回应原问题，不要声称它刚发出]\n'+job['text']
    journal.change(job['id'],'submitting')
    result=bridge.policy.ingest(seq,sender,text,time.time(),True,chat_id=str(job['chat_id']))
    if result!='queued':
        journal.change(job['id'],'attention',error='admission_'+str(result));return
    with bridge.policy.db() as db:
        row=db.execute('SELECT id FROM pending WHERE sender=?',(key,)).fetchone()
        if not row:
            journal.change(job['id'],'attention',error='pending_missing');return
        db.execute('CREATE TABLE IF NOT EXISTS migration_backfill_turns(turn_id TEXT PRIMARY KEY)')
        db.execute('INSERT OR IGNORE INTO migration_backfill_turns(turn_id) VALUES(?)',(row['id'],))
    journal.change(job['id'],'submitted',turn_id=row['id'])


async def run(bridge):
    journal=Journal()
    while True:
        try:
            if not bridge.chats or not bridge.control()['send_enabled']:
                await asyncio.sleep(10);continue
            data=await asyncio.to_thread(gd.api,'/bot-migration-launch')
            plan=data.get('launch')
            if not plan or not active(bridge,plan):
                await asyncio.sleep(10);continue
            connection=json.loads(gd.CONNECTION.read_text())
            groups={external:int(chat) for chat,external in connection['groups'].items()}
            if set(groups.values())!=set(bridge.chats):raise ValueError('Migration group binding changed')
            journal.seed(plan,groups)
            for old in ('greet','catchup'):
                reserved=journal.one(plan['id'],old,'reserved')
                if reserved:journal.change(reserved['id'],'attention',error='uncertain_after_restart')
            submitting=journal.one(plan['id'],'catchup','submitting')
            if submitting:journal.change(submitting['id'],'attention',error='uncertain_after_restart')
            greeting=journal.one(plan['id'],'greet','queued')
            if greeting:
                await greet(bridge,plan,journal,greeting)
            else:
                with journal.db() as db:scanned=db.execute('SELECT scanned FROM launches WHERE id=?',(plan['id'],)).fetchone()['scanned']
                if not scanned:await asyncio.to_thread(scan,bridge,plan,journal,groups)
                submitted=journal.one(plan['id'],'catchup','submitted')
                if submitted:settle(bridge,journal,submitted)
                elif (queued:=journal.one(plan['id'],'catchup','queued')):enqueue(bridge,plan,journal,queued)
            progress=journal.progress(plan)
            await asyncio.to_thread(gd.api,'/bot-migration-launch-progress',progress)
            bridge.health.pop('migration_launch_error',None)
        except Exception as exc:
            bridge.health['migration_launch_error']=type(exc).__name__
        await asyncio.sleep(60)
