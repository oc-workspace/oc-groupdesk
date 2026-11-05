"""Scoped lifecycle handshake; no Docker socket, account switching or model calls."""
import hashlib,json,re,time
from pathlib import Path
import groupdesk_runtime as gd

def binding():
    c=json.loads(gd.CONNECTION.read_text())
    for field,pattern in [('bot_id',r'[a-f0-9-]{36}'),('runtime_instance_id',r'[a-f0-9-]{36}'),('account_fingerprint',r'[a-f0-9]{64}')]:
        if not re.fullmatch(pattern,str(c.get(field,''))):raise ValueError('Missing private robot binding')
    return c

def save_state(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False));temp.chmod(0o600);temp.replace(path)

def disable_profiles(conf,revision):
    groups={str(chat):{'enabled':False,'valid_until':0,'revision':'bot-paused-'+str(revision)} for chat in conf['groups']}
    gd.SNAPSHOT.parent.mkdir(parents=True,exist_ok=True);save_state(gd.SNAPSHOT,{'groups':groups})
    return {key:{'enabled':False,'revision':p['revision']} for key,p in groups.items()}

def local_pause(bridge,paused):
    control=bridge.state_dir/'control.json';record=bridge.state_dir/'bot-local-pause.json'
    if paused:
        if record.exists():
            saved=json.loads(record.read_text())
            if hashlib.sha256(control.read_bytes()).hexdigest()!=saved['paused_hash']:raise RuntimeError('Local controls changed during robot pause')
        else:
            original=control.read_text();value=json.loads(original)
            disabled={**value,'enabled':False,'send_enabled':False}
            save_state(control,disabled)
            saved={'original':original,'paused_hash':hashlib.sha256(control.read_bytes()).hexdigest()}
            save_state(record,saved)
        value=json.loads(saved['original'])
    else:
        if record.exists():
            saved=json.loads(record.read_text())
            if hashlib.sha256(control.read_bytes()).hexdigest()!=saved['paused_hash']:raise RuntimeError('Local controls changed during robot pause')
            temp=control.with_suffix('.tmp');temp.write_text(saved['original']);temp.chmod(0o600);temp.replace(control);record.unlink()
        value=json.loads(control.read_text())
    return value.get('enabled') is True and value.get('send_enabled') is True

def unfinished_sends(bridge):
    with bridge.ledger.connect() as db:
        rows=db.execute("SELECT state,seq FROM outbound WHERE state IN ('reserved','pending','unknown','uncertain')").fetchall()
    unknown=0
    for state,seq in rows:
        if seq is None:
            if state=='reserved':unknown+=1
            continue
        try:
            # UI unverified is a completed action; pending is still executing.
            if bridge.agent.get_message(seq).delivery_status=='pending':unknown+=1
        except Exception:unknown+=1
    return unknown

def active_turns(bridge):
    with bridge.policy.db() as db:
        return db.execute('SELECT count(*) FROM turns WHERE status="active" AND expires>?',(time.time(),)).fetchone()[0]

def reset_ingress(bridge,conf,generation):
    path=bridge.state_dir/'bot-lifecycle.json'
    try:old=json.loads(path.read_text())
    except (OSError,ValueError):old={'activation_generation':0}
    if old.get('activation_generation',0)==generation:return
    if bridge.send_lock.locked() or active_turns(bridge) or unfinished_sends(bridge):raise RuntimeError('Cannot resume while accepted work is unresolved')
    bridge.agent.reset_live_cursors([int(chat) for chat in conf['groups']])
    with bridge.policy.db() as db:
        db.execute('DELETE FROM pending')
    save_state(path,{'activation_generation':generation})

def sync(bridge):
    conf=binding();state=gd.api('/bot-state')
    if state.get('contract')!=1 or state.get('bot_id')!=conf['bot_id'] or state.get('wechat_id')!=conf.get('wechat_id'):
        disable_profiles(conf,state.get('revision',0));raise ValueError('Robot identity does not match connection')
    if state.get('enabled'):
        local_ready=local_pause(bridge,False)
        reset_ingress(bridge,conf,state['activation_generation'])
        result=gd.sync()
    else:
        result=disable_profiles(conf,state['revision'])
        local_ready=local_pause(bridge,True)
    status=bridge.agent.status();queue=status.get('queue_depth')
    if type(queue) is not int or queue<0:raise RuntimeError('Sender queue status unavailable')
    inflight=bridge.send_lock.locked();active=active_turns(bridge)
    if not state.get('enabled'):queue+=unfinished_sends(bridge)
    source=getattr(bridge.agent,'source_status',{})
    reader=bool(source.get('connected') and time.time()-source.get('checked_at',0)<90)
    # A paused instance has no live pulls. Read the in-memory health endpoint;
    # this never requests history or reconciles the raw WeChat database.
    if not state.get('enabled'):
        try:
            value=bridge.agent.request('/v1/status',{})
            reader=value.get('ok') is True
        except Exception:reader=False
    stopped=not state.get('enabled') and not inflight and not active and queue==0
    gd.api('/bot-heartbeat',{'contract':1,'bot_id':conf['bot_id'],'instance_id':conf['runtime_instance_id'],
        'account_fingerprint':conf['account_fingerprint'],'revision':state['revision'],
        'wechat_connected':status.get('wechat_connected') is True,'reader_connected':reader,
        'maibot_connected':bool(bridge.router.check_connection('wechat_linux')),
        'sender_queue_depth':queue,'active_turns':active,'send_inflight':inflight,'stopped':stopped,
        'cutover_generation':state['activation_generation'],'local_ready':local_ready})
    bridge.health['robot']={k:state[k] for k in ('bot_id','state','revision','activation_generation')}
    return result
