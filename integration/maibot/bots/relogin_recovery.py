"""Reconcile a bound robot's Reader archive after its WeChat login returns.

The live cursor and original timestamps are never changed. Candidate replies
enter the existing Policy and native-mention send path with persistent IDs.
"""
import time
import uuid
import json

import groupdesk_runtime as gd
import migration_launch as launch
from reply_mention import member_name

WINDOW = 48 * 3600
SETTLE = 120
RESCAN = 120
SYNC_WAIT = 15 * 60


def init(db):
    db.execute('''CREATE TABLE IF NOT EXISTS relogin_outages(
        id TEXT PRIMARY KEY,started REAL NOT NULL,recovered REAL,
        last_scan REAL NOT NULL DEFAULT 0,state TEXT NOT NULL,
        activation_generation INTEGER NOT NULL)''')


def known_offline_start(bridge,now):
    """Use an existing offline health observation when upgrading mid-outage."""
    try:
        record=json.loads((bridge.state_dir/'hourly-health.json').read_text())
        at=float(record['reported_at'])
        if record.get('result',{}).get('wechat') is False and now-31*86400<=at<=now:
            return at
    except (OSError,ValueError,KeyError,TypeError):pass
    return None


def source_outcome(bridge, epoch, row):
    """Known sends win; uncertain originals must never be retried."""
    seq=bridge.agent.namespace(epoch)+row['seq']
    with bridge.policy.db() as db:
        source=db.execute('SELECT turn_id FROM recovery_sources WHERE seq=?',(seq,)).fetchone()
        if not source or not source['turn_id']:return None
        sends=db.execute('SELECT status FROM sends WHERE turn_id=?',(source['turn_id'],)).fetchall()
        if any(item['status']=='sent' for item in sends):return 'sent'
        if sends:return 'attention'
    return None


def scan(bridge, journal, outage, groups, now):
    """Read a fixed incident window; later pages may add evidence, not tasks twice."""
    start=max(outage['started'],outage['recovered']-WINDOW)
    if not 0 < start < outage['recovered'] <= now+30:
        raise ValueError('Invalid WeChat outage window')
    candidates=[]
    matched_jobs=[]
    for chat,external in groups.items():
        profile=gd.profile(bridge.policy.cfg,str(chat))
        if not gd.available(profile,now) or profile.get('policy',{}).get('relogin_recovery') is not True:continue
        epoch,rows=launch.source_page(bridge.agent,chat,start,now)
        matched=launch.answered_indices(rows,bridge.policy.cfg,str(chat))
        for index,row in enumerate(rows):
            if row.get('is_self')!=0 or not launch.addressed(row,bridge.policy.cfg,str(chat)):
                continue
            if not start<=row.get('source_at',0)<=outage['recovered']:continue
            job='relogin:'+outage['id']+':'+str(chat)+':'+epoch+':'+str(row['seq'])
            outcome=source_outcome(bridge,epoch,row)
            if index in matched or outcome=='sent':
                matched_jobs.append(job)
                continue
            sender=member_name(row.get('sender'))
            text=launch.source_text(row)
            state='attention' if outcome=='attention' or not sender else 'queued'
            reason='original_send_uncertain' if outcome=='attention' else 'sender_unavailable' if not sender else None
            candidates.append((job,outage['id'],'catchup',chat,external,row['seq'],sender,text,row['source_at'],state,reason))
    with journal.db() as db:
        init(db)
        for job in matched_jobs:
            db.execute('UPDATE jobs SET status="sent",error=NULL WHERE id=? AND status="queued"',(job,))
        for item in candidates:
            db.execute('''INSERT OR IGNORE INTO jobs
                (id,launch_id,kind,chat_id,external_id,source_seq,sender,text,source_at,status,error)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)''',item)
        db.execute('UPDATE relogin_outages SET last_scan=? WHERE id=?',(now,outage['id']))
        counts=db.execute('SELECT status,count(*) FROM jobs WHERE launch_id=? GROUP BY status',(outage['id'],)).fetchall()
    return {row['status']:row['count(*)'] for row in counts}


def step(bridge,conf,status,enabled,reader,now=None):
    now=time.time() if now is None else now
    connected=status.get('wechat_connected') is True and status.get('running') is True and not status.get('ui_input_blocked')
    journal=launch.Journal()
    with journal.db() as db:
        init(db)
        if not enabled:
            db.execute('UPDATE relogin_outages SET state="review" WHERE state IN ("offline","scanning")')
            return
        generation=bridge.health.get('robot',{}).get('activation_generation')
        if type(generation) is not int:return
        if not connected:
            existing=db.execute('SELECT id FROM relogin_outages WHERE state="offline" AND activation_generation=?',(generation,)).fetchone()
            if not existing:
                db.execute('INSERT INTO relogin_outages(id,started,state,activation_generation) VALUES(?,?,"offline",?)',
                           (uuid.uuid4().hex,known_offline_start(bridge,now) or now,generation))
            return
        db.execute('UPDATE relogin_outages SET state="review" WHERE state IN ("offline","scanning") AND activation_generation!=?',(generation,))
        if not db.execute('SELECT 1 FROM relogin_outages LIMIT 1').fetchone():
            observed=known_offline_start(bridge,now)
            if observed is not None:
                db.execute('INSERT INTO relogin_outages(id,started,recovered,state,activation_generation) VALUES(?,?,?,"scanning",?)',
                           (uuid.uuid4().hex,observed,now,generation))
        db.execute('UPDATE relogin_outages SET recovered=?,state="scanning" WHERE state="offline" AND activation_generation=?',(now,generation))
        outage=db.execute('SELECT * FROM relogin_outages WHERE state IN ("scanning","settling") AND activation_generation=? ORDER BY started LIMIT 1',(generation,)).fetchone()
    if outage is None or not reader or now<outage['recovered']+SETTLE:return
    if set(map(int,conf['groups']))!=set(bridge.chats):raise ValueError('Recovery group binding changed')
    groups={int(chat):external for chat,external in conf['groups'].items()}
    if outage['state']=='scanning' and now-outage['last_scan']>=RESCAN:
        counts=scan(bridge,journal,outage,groups,now)
        bridge.health['relogin_recovery']={'incident':outage['id'],'coverage':'reader_recorded_only',
            'counts':counts,'window_truncated':outage['started']<outage['recovered']-WINDOW}
    plan={'id':outage['id'],'activation_generation':generation}
    if not launch.active(bridge,plan):return
    with journal.db() as db:
        db.execute('UPDATE jobs SET status="attention",error="uncertain_after_restart" WHERE launch_id=? AND status IN ("reserved","submitting")',(outage['id'],))
        if now>=outage['recovered']+3600:
            db.execute('UPDATE jobs SET status="attention",error="recovery_queue_expired" WHERE launch_id=? AND status="queued"',(outage['id'],))
    submitted=journal.one(outage['id'],'catchup','submitted')
    if submitted:launch.settle(bridge,journal,submitted)
    elif (queued:=journal.one(outage['id'],'catchup','queued')):
        profile=gd.profile(bridge.policy.cfg,str(queued['chat_id']))
        if not gd.available(profile,now) or profile.get('policy',{}).get('relogin_recovery') is not True:
            journal.change(queued['id'],'attention',error='group_recovery_disabled')
        else:launch.enqueue(bridge,plan,journal,queued,source='relogin')
    with journal.db() as db:
        if outage['state']=='scanning' and now>=outage['recovered']+SYNC_WAIT:
            db.execute('UPDATE relogin_outages SET state="settling" WHERE id=?',(outage['id'],))
        waiting=db.execute('SELECT 1 FROM jobs WHERE launch_id=? AND status IN ("queued","reserved","submitting","submitted") LIMIT 1',(outage['id'],)).fetchone()
        if not waiting and now>=outage['recovered']+SYNC_WAIT:
            db.execute('UPDATE relogin_outages SET state="completed" WHERE id=?',(outage['id'],))
