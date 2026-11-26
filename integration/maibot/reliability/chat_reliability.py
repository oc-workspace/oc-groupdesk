"""Persist terminal outcomes and release failed work without replaying sends."""
import asyncio
import logging

FINALIZE_SECONDS=5


def init(db):
    db.execute("""CREATE TABLE IF NOT EXISTS request_outcomes(
        turn_id TEXT PRIMARY KEY,stage TEXT NOT NULL,reason TEXT,
        updated REAL NOT NULL,notice_status TEXT NOT NULL DEFAULT 'waiting')""")


def stage(p, turn_id, value, reason=None):
    if not turn_id:
        return
    with p.db() as db:
        init(db)
        db.execute("""INSERT INTO request_outcomes(turn_id,stage,reason,updated)
            VALUES(?,?,?,?) ON CONFLICT(turn_id) DO UPDATE
            SET stage=excluded.stage,reason=coalesce(excluded.reason,request_outcomes.reason),updated=excluded.updated""",
            (turn_id,value,reason,p.clock()))
        db.execute("DELETE FROM request_outcomes WHERE updated<?", (p.clock()-7*86400,))


def finish(p, turn_id, reason='model_failed'):
    """Do not release a reserved/uncertain send or another request's model slot."""
    if not turn_id:
        return False
    with p.db() as db:
        init(db)
        turn=db.execute('SELECT * FROM turns WHERE id=?', (turn_id,)).fetchone()
        if not turn or turn['status']!='active':
            return False
        outgoing=db.execute("SELECT stage FROM request_outcomes WHERE turn_id=?",(turn_id,)).fetchone()
        if outgoing and outgoing['stage']=='sending':
            return False
        if db.execute('SELECT 1 FROM sends WHERE turn_id=?', (turn_id,)).fetchone():
            return False
        if db.execute("SELECT 1 FROM attempts WHERE turn_id=? AND state='reserved'", (turn_id,)).fetchone():
            return False
        state='idle_released' if reason=='silent' else 'failed'
        notice='skipped' if state=='idle_released' else 'waiting'
        db.execute("UPDATE turns SET status=?,ended=? WHERE id=? AND status='active'", (state,p.clock(),turn_id))
        db.execute("""INSERT INTO request_outcomes(turn_id,stage,reason,updated,notice_status)
            VALUES(?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE
            SET stage=excluded.stage,reason=excluded.reason,updated=excluded.updated,
                notice_status=excluded.notice_status""",
            (turn_id,state,reason,p.clock(),notice))
        return True


def model_failed(p, turn_id, task, error):
    # Orchestrator/provider retries have already completed when this is called.
    # One failed Replyer attempt may still use the configured generation retry.
    if type(error).__name__=='ReqAbortException' and 'GT ' not in str(error):
        return
    with p.db() as db:
        used=db.execute('SELECT count(*) FROM attempts WHERE turn_id=? AND task=?', (turn_id,task)).fetchone()[0]
    stage(p,turn_id,'generation_retry' if task=='replyer' else 'failed_attempt',type(error).__name__)
    if task=='planner' or used>=p.cfg['task_calls_per_turn'].get(task,1):
        finish(p,turn_id,'model_failed')


def complete_bound_turn():
    from group_guard import policy, TURN
    p=policy()
    turn=TURN.get()
    with p.db() as db:
        init(db)
        outcome=db.execute('SELECT reason FROM request_outcomes WHERE turn_id=?',(turn,)).fetchone()
    # A deliberate silent/stop choice is a normal completion. Notify only
    # when this request actually recorded a failed model attempt.
    reason='model_failed' if outcome and outcome['reason'] else 'silent'
    return finish(p,turn,reason)


def settling(db, now):
    # The failed request is released before its monitoring cleanup completes.
    # Wait for that bounded cleanup before dispatching to the same runtime.
    return db.execute("""SELECT 1 FROM request_outcomes o JOIN turns t ON t.id=o.turn_id
        WHERE t.status='failed' AND t.ended>? LIMIT 1""",(now-FINALIZE_SECONDS-2,)).fetchone() is not None


async def finalize(coroutine, default):
    """Monitoring/prompt rendering must not hold a finished turn for minutes."""
    try:
        return await asyncio.wait_for(coroutine,timeout=FINALIZE_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logging.getLogger(__name__).warning('Cycle finalization incomplete (%s)',type(exc).__name__)
        return default


def recent(p, chat):
    now=p.clock()
    with p.db() as db:
        init(db)
        rows=[]
        for item in db.execute("""SELECT t.id,t.status,t.created,t.received_at,t.ended,
            t.reply_source_seq,o.stage,o.reason,o.updated
            FROM turns t LEFT JOIN request_outcomes o ON o.turn_id=t.id
            WHERE t.chat_id=? ORDER BY t.created DESC LIMIT 10""",(str(chat),)):
            value=dict(item)
            terminal=value['status']
            state=(value['stage'] or 'processing') if terminal=='active' else terminal
            if terminal=='active' and not db.execute('SELECT 1 FROM attempts WHERE turn_id=?',(value['id'],)).fetchone():
                state='waiting_model'
            rows.append({'id':value['id'],'stage':state,'reason':value['reason'],
                'received_at':value['received_at'] or value['created'],
                'updated_at':value['updated'] or value['ended'] or value['created']})
        for item in db.execute('SELECT id,received_at,first FROM pending WHERE chat_id=?',(str(chat),)):
            rows.append({'id':item['id'],'stage':'queued','received_at':item['received_at'] or item['first'],'updated_at':item['first']})
        for item in db.execute("""SELECT seq,received_at FROM frequency_waiting
            WHERE chat_id=? AND status='waiting' AND expires>? ORDER BY received_at DESC LIMIT 10""",(str(chat),now)):
            rows.append({'id':'waiting-'+str(item['seq']),'stage':'deferred','received_at':item['received_at'],'updated_at':item['received_at']})
    return sorted(rows,key=lambda row:row['received_at'],reverse=True)[:10]


async def send_failure_notice(bridge):
    """Use the existing outgoing guards, quota, native mention and dedup ledger."""
    import groupdesk_runtime as gd
    import latency
    import uuid
    if not bridge.control().get('enabled') or not bridge.control().get('send_enabled'):
        return False
    p=bridge.policy
    now=p.clock()
    with p.db() as db:
        init(db)
        if db.execute("SELECT 1 FROM turns WHERE status='active' AND expires>?",(now,)).fetchone():
            return False
        rows=db.execute("""SELECT t.*,o.reason FROM request_outcomes o JOIN turns t ON t.id=o.turn_id
            WHERE o.stage='failed' AND o.notice_status='waiting' AND t.explicit=1
            AND t.received_at>? ORDER BY o.updated LIMIT 1""",(now-600,)).fetchall()
        if not rows:
            return False
        old=dict(rows[0])
        managed=gd.profile(p.cfg,old['chat_id'])
        if managed is None or not gd.available(managed,now) or old['policy_revision']!=gd.revision(managed):
            return False
        if not old['reply_source_seq']:
            db.execute("UPDATE request_outcomes SET notice_status='skipped' WHERE turn_id=?",(old['id'],))
            return False
        if db.execute('SELECT 1 FROM sends WHERE turn_id=?',(old['id'],)).fetchone():
            db.execute("UPDATE request_outcomes SET notice_status='skipped' WHERE turn_id=?",(old['id'],))
            return False
        if (p.after_turn(db,'direct',now)
            or db.execute("SELECT 1 FROM turns WHERE sender=? AND created>?",(old['sender'],now-p.cfg['user_interval'])).fetchone()
            or p._quota(db,'direct',now,explicit=True,chat_id=old['chat_id'])):
            return False
        request=db.execute('SELECT text FROM observed WHERE seq=?',(old['reply_source_seq'],)).fetchone()
        language=latency.language(request['text'] if request else '',managed)
        text={
            'zh':'刚才这条我没能答出来，抱歉让你空等了。😅',
            'ja':'さっきの質問に答えきれず、お待たせしてすみません。',
            'ko':'아까 질문에 답하지 못했어요. 기다리게 해서 미안해요.',
            'en':"I couldn't finish that reply just now—sorry to keep you waiting. 😅",
        }.get(language,"I couldn't finish that reply just now—sorry to keep you waiting. 😅")
        if not gd.language_allowed(managed,text):
            db.execute("UPDATE request_outcomes SET notice_status='skipped' WHERE turn_id=?",(old['id'],))
            return False
        turn=uuid.uuid4().hex
        db.execute("""INSERT INTO turns(id,sender,kind,created,expires,status,article,explicit,fast,
            received_at,chat_id,policy_revision,reply_member,reply_source_seq)
            VALUES(?,?,'direct',?,?,'active',0,1,0,?,?,?,?,?)""",
            (turn,old['sender'],now,now+90,now,old['chat_id'],old['policy_revision'],old['reply_member'],old['reply_source_seq']))
        db.execute("UPDATE request_outcomes SET notice_status='reserved' WHERE turn_id=?",(old['id'],))
    chat=bridge.chats.get(int(old['chat_id']))
    if chat is None:
        p.fail_turn(turn)
        return False
    from types import SimpleNamespace
    import app
    packet=app.incoming_packet(SimpleNamespace(chat_id=chat.id,direction='incoming',message_type='text',
        sender=old['reply_member'],timestamp=None,seq='failure-notice',content=''),chat.id,chat.name)
    packet.message_info.message_id='failure-notice-'+old['id']
    packet.message_info.additional_config.update(gt_limit_turn=turn,gt_reply_source_id='bowxt-in-turn-'+turn)
    packet.message_segment=app.Seg('text',text)
    await bridge.outgoing(packet)
    with p.db() as db:
        sent=db.execute('SELECT status FROM sends WHERE turn_id=?',(turn,)).fetchone()
        state='sent' if sent and sent['status']=='sent' else 'review'
        db.execute("UPDATE request_outcomes SET notice_status=? WHERE turn_id=?",(state,old['id']))
    return True


async def report(bridge):
    import groupdesk_runtime as gd
    for chat in bridge.chats:
        profile=gd.profile(bridge.policy.cfg,str(chat))
        if profile is None or not gd.available(profile,bridge.policy.clock()):
            continue
        payload={'external_id':profile['external_id'],'requests':recent(bridge.policy,chat)}
        await asyncio.to_thread(gd.api,'/request-status',payload)
