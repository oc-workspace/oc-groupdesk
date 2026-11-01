"""Recorded-mention reconciliation; no history guessing or independent sends.

Runs inside the bridge. Original source times never become fresh input times.
Recovery creates a new, explicitly labelled task under the existing admission,
model, persona, language, quota and verified-delivery gates.
"""
import hashlib,json,time,uuid

WINDOW=12*3600
RETENTION=48*3600

def init(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS recovery_sources(
        seq INTEGER PRIMARY KEY,chat_id TEXT NOT NULL,sender TEXT NOT NULL,
        text TEXT NOT NULL,source_at REAL NOT NULL,turn_id TEXT,
        disposition TEXT NOT NULL,batch_id TEXT);
      CREATE TABLE IF NOT EXISTS recovery_incidents(
        id TEXT PRIMARY KEY,recovered_at REAL NOT NULL,scanned_at REAL NOT NULL,
        coverage TEXT NOT NULL,untracked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS recovery_batches(
        id TEXT PRIMARY KEY,incident TEXT NOT NULL,chat_id TEXT NOT NULL,
        sender TEXT NOT NULL,created REAL NOT NULL,deadline REAL NOT NULL,
        status TEXT NOT NULL,turn_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS recovery_meta(key TEXT PRIMARY KEY,value REAL);
      CREATE TABLE IF NOT EXISTS recovery_transport(
        id TEXT PRIMARY KEY,started REAL NOT NULL,ended REAL,scanned INTEGER NOT NULL DEFAULT 0);
    ''')
    db.execute('INSERT OR IGNORE INTO recovery_meta VALUES("tracking_since",?)',(time.time(),))

def transport(p,success):
    """Use existing receive outcomes; never add a faster availability probe."""
    now=p.clock()
    with p.db() as db:
        if success:
            db.execute('DELETE FROM recovery_transport WHERE ended IS NULL AND started>?',(now-30,))
            db.execute('UPDATE recovery_transport SET ended=? WHERE ended IS NULL',(now,))
        elif not db.execute('SELECT 1 FROM recovery_transport WHERE ended IS NULL').fetchone():
            db.execute('INSERT INTO recovery_transport(id,started) VALUES(?,?)',(uuid.uuid4().hex,now))
        db.execute('DELETE FROM recovery_transport WHERE scanned=1 AND started<?',(now-RETENTION,))

def sender_key(chat,sender):
    value=hashlib.sha256(str(sender).encode()).hexdigest()[:24]
    return str(chat)+':'+value if str(chat) else value

def track(p,seq,sender,text,timestamp,at_me,chat,result):
    from policy import NAME,reminder_candidate
    if seq<0 or result=='duplicate':return
    with p.db() as db:
        key=sender_key(chat,sender)
        target=None
        if result in {'queued','merged','coalesced_reminder'}:
            target=db.execute('SELECT id FROM pending WHERE sender=? AND chat_id=?',(key,str(chat))).fetchone()
            if not target and result=='coalesced_reminder':
                target=db.execute('SELECT id FROM turns WHERE sender=? AND chat_id=? AND explicit=1 AND status="active" ORDER BY created DESC LIMIT 1',(key,str(chat))).fetchone()
        if not (at_me or NAME.search(str(text)) or (target and reminder_candidate(str(text)))):return
        now=p.clock()
        db.execute('INSERT OR IGNORE INTO recovery_sources VALUES(?,?,?,?,?,?,?,NULL)',
                   (seq,str(chat),str(sender)[:80],str(text)[:p.cfg['input_chars']],timestamp if timestamp is not None else now,target['id'] if target else None,result))
        # Keep text long enough for a 12h recovery window and operational review.
        db.execute('DELETE FROM recovery_sources WHERE source_at<? AND (batch_id IS NULL OR batch_id IN (SELECT id FROM recovery_batches WHERE status IN ("sent","review","expired")))',(now-RETENTION,))

def reconcile(p,incident,recovered_at,source_rows,allowed):
    """One fixed window per incident. Return counts only, never message text.

    source_rows are already scoped verified incoming text records from bowxt.
    Untracked historical rows cannot prove whether a reply was sent; flag them
    for private review instead of blindly replaying them.
    """
    from policy import NAME
    now=p.clock();start=recovered_at-WINDOW;untracked=0;created=0;uncertain=0
    allowed={str(v) for v in allowed}
    with p.db() as db:
        previous=db.execute('SELECT * FROM recovery_incidents WHERE id=?',(incident,)).fetchone()
        if previous:return {'queued':0,'untracked':previous['untracked'],'coverage':previous['coverage'],'repeat':True}
        since=db.execute('SELECT value FROM recovery_meta WHERE key="tracking_since"').fetchone()[0]
        for row in source_rows:
            if (str(row['chat_id']) not in allowed or row['direction']!='incoming' or row['message_type']!='text'
                or not row.get('sender') or not start<=row['source_at']<=recovered_at):continue
            if not (row.get('is_at_me') or NAME.search(row.get('content',''))):continue
            if not db.execute('SELECT 1 FROM recovery_sources WHERE seq=?',(row['seq'],)).fetchone():untracked+=1
        rows=db.execute('SELECT * FROM recovery_sources WHERE source_at>=? AND source_at<=? AND batch_id IS NULL ORDER BY source_at,seq',(start,recovered_at)).fetchall()
        grouped={}
        for row in rows:
            if row['chat_id'] not in allowed:continue
            if row['turn_id']:
                sends=db.execute('SELECT status FROM sends WHERE turn_id=?',(row['turn_id'],)).fetchall()
                if any(s['status']=='sent' for s in sends):continue
                if sends:uncertain+=1;continue  # Reserved/uncertain never blindly resend.
            grouped.setdefault((row['chat_id'],row['sender']),[]).append(row)
        for (chat,sender),items in grouped.items():
            identifier=hashlib.sha256((incident+'\0'+chat+'\0'+sender).encode()).hexdigest()[:32]
            db.execute('INSERT INTO recovery_batches VALUES(?,?,?,?,?,?,"queued",NULL)',(identifier,incident,chat,sender,now,now+3600))
            for row in items:db.execute('UPDATE recovery_sources SET batch_id=? WHERE seq=?',(identifier,row['seq']))
            created+=1
        # Linux does not guarantee offline history synchronization. Never claim
        # complete coverage, even when every locally recorded row is tracked.
        coverage='partial_untracked' if untracked or since>start else 'recorded_only'
        db.execute('INSERT INTO recovery_incidents VALUES(?,?,?,?,?)',(incident,recovered_at,now,coverage,untracked))
    return {'queued':created,'untracked':untracked,'uncertain':uncertain,'coverage':coverage}

def refresh(db,now):
    for row in db.execute('SELECT * FROM recovery_batches WHERE status="active"').fetchall():
        sends=db.execute('SELECT status FROM sends WHERE turn_id=?',(row['turn_id'],)).fetchall()
        if sends:
            state='sent' if any(v['status']=='sent' for v in sends) else 'review'
            db.execute('UPDATE recovery_batches SET status=? WHERE id=?',(state,row['id']))
        elif not db.execute('SELECT 1 FROM pending WHERE id=? UNION ALL SELECT 1 FROM turns WHERE id=? AND status="active" AND expires>?',(row['turn_id'],row['turn_id'],now)).fetchone():
            db.execute('UPDATE recovery_batches SET status="review" WHERE id=?',(row['id'],))
    db.execute('UPDATE recovery_batches SET status="expired" WHERE status="queued" AND deadline<?',(now,))

def pump(p):
    """Admit at most one recovery bundle when normal work is idle."""
    import groupdesk_runtime as gd
    now=p.clock()
    with p.db() as db:
        refresh(db,now)
        if db.execute('SELECT 1 FROM pending UNION ALL SELECT 1 FROM turns WHERE status="active" AND expires>?',(now,)).fetchone():return False
        for batch in db.execute('SELECT * FROM recovery_batches WHERE status="queued" ORDER BY created,id').fetchall():
            chat=batch['chat_id'];managed=gd.profile(p.cfg,chat)
            if managed is not None and not gd.available(managed,now):continue
            key=sender_key(chat,batch['sender'])
            if db.execute('SELECT 1 FROM turns WHERE sender=? AND created>?',(key,now-p.cfg['user_interval'])).fetchone():continue
            if p._quota(db,'direct',now,explicit=True,chat_id=chat):continue
            rows=db.execute('SELECT * FROM recovery_sources WHERE batch_id=? ORDER BY source_at,seq',(batch['id'],)).fetchall()
            # All originals are retained for provenance; one task stays bounded.
            # More than one input-sized bundle is flagged for review, not cut off.
            unanswered=[];waiting=False;uncertain=False
            for original in rows:
                old=original['turn_id']
                sends=db.execute('SELECT status FROM sends WHERE turn_id=?',(old,)).fetchall() if old else []
                if any(v['status']=='sent' for v in sends):continue
                if sends:uncertain=True;break
                if old and db.execute('SELECT 1 FROM pending WHERE id=? UNION ALL SELECT 1 FROM turns WHERE id=? AND status="active" AND expires>?',(old,old,now)).fetchone():waiting=True
                unanswered.append(original)
            if uncertain:
                db.execute('UPDATE recovery_batches SET status="review" WHERE id=?',(batch['id'],));continue
            if waiting:continue
            if not unanswered:
                db.execute('UPDATE recovery_batches SET status="sent" WHERE id=?',(batch['id'],));continue
            text='\n'.join(r['text'] for r in unanswered)
            if len(text)>p.cfg['input_chars']:
                db.execute('UPDATE recovery_batches SET status="review" WHERE id=?',(batch['id'],));continue
            identifier=uuid.uuid4().hex
            db.execute('INSERT INTO pending(id,sender,display,kind,first,last,text,article,explicit,fast,greeting,chat_id,policy_revision) VALUES(?,?,?,"direct",?,?,?,?,1,0,0,?,?)',
                       (identifier,key,batch['sender'],now,now,text,0,chat,gd.revision(managed)))
            db.execute('UPDATE recovery_batches SET status="active",turn_id=? WHERE id=?',(identifier,batch['id']))
            return True
    return False

def instructions(p,turn_id):
    with p.db() as db:
        batch=db.execute('SELECT * FROM recovery_batches WHERE turn_id=?',(turn_id,)).fetchone()
        if not batch:return ''
        incident=db.execute('SELECT recovered_at FROM recovery_incidents WHERE id=?',(batch['incident'],)).fetchone()
        first=db.execute('SELECT 1 FROM recovery_batches WHERE incident=? AND chat_id=? AND status IN ("sent","review") AND id!=? AND turn_id IS NOT NULL LIMIT 1',(batch['incident'],batch['chat_id'],batch['id'])).fetchone() is None
        from datetime import datetime
        from zoneinfo import ZoneInfo
        rows=db.execute('SELECT source_at FROM recovery_sources WHERE batch_id=? ORDER BY source_at',(batch['id'],)).fetchall()
        times=', '.join(datetime.fromtimestamp(r['source_at'],ZoneInfo('Asia/Shanghai')).strftime('%m-%d %H:%M') for r in rows)
    apology=('这是本次恢复在本群第一条补答。开头用一句简短英文道歉，说明连接曾中断；然后按原消息语言回应。若本群不允许英文，则用本群允许语言道歉。' if first else '本次恢复此前已有补答，无需重复解释掉线。')
    return ('【可信运维任务：恢复后补答】这是恢复上线前12小时内已采集、未成功回复的真实点名，'
            '并非刚收到的新消息。原消息首次采集时间（北京时间）为：'+times+'。'
            '恢复时间为'+datetime.fromtimestamp(incident['recovered_at'],ZoneInfo('Asia/Shanghai')).isoformat()+'。'
            +apology+'保持本群已绑定Persona Skill口吻，称呼原发送者，自然补答其问题；多条催促合并为一条回复。'
            '不要让群友重发，不声称已读取完整群史，不编造掉线原因、原消息精确发送时间或实时情况。'
            '只有文字信息，图片不可见时如实说明。时间敏感问题先说明这是补答。仅输出一条回复。')

def bind(p,request,turn_id):
    text=instructions(p,turn_id)
    if not text:return
    from src.llm_models.payload_content.context_item import ContextItemBuilder,RoleType
    request.context_items=[*request.context_items,ContextItemBuilder().set_role(RoleType.System).add_text_content(text).build()]
