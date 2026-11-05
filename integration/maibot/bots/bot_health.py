"""Hourly live service inspection from the account's existing Docker bridge.

Uses sender status, Reader freshness and the live MaiBot websocket. Never reads
chat history, starts a model request, polls the raw database or restarts WeChat.
"""
import json,time,re,urllib.request,urllib.parse
import groupdesk_runtime as gd

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def report(bridge,conf,status,reader,enabled,now=None):
    now=time.time() if now is None else now
    path=bridge.state_dir/'hourly-health.json'
    try:previous=json.loads(path.read_text())
    except (OSError,ValueError):previous={}
    # Failed uploads retry at most once a minute, successful checks once an hour.
    if now-previous.get('attempt_at',0)<60:return
    previous['attempt_at']=now
    wechat=status.get('wechat_connected') is True and status.get('running') is True and not status.get('ui_input_blocked')
    maibot=bool(bridge.router.check_connection('wechat_linux'))
    reason=('manual_pause' if not enabled else 'ui_window_blocked' if status.get('ui_input_blocked') else 'wechat_unavailable' if not wechat else 'chatlog_reader_unavailable' if not reader else 'maibot_unavailable' if not maibot else 'ok')
    state='maintenance' if not enabled else 'online' if reason=='ok' else 'degraded'
    signature={'state':state,'reason':reason,'wechat':bool(wechat),'maibot':maibot}
    if now-previous.get('reported_at',0)<3600 and all(previous.get('result',{}).get(k)==v for k,v in signature.items()):return
    configured=False;pending=False
    try:
        notification=gd.api('/notification');configured=notification.get('configured') is True
        marker=state+':'+reason
        day=int(now//86400);count=previous.get('notice_count',0) if previous.get('notice_day')==day else 0
        if configured and enabled and state!='online' and previous.get('notified')!=marker:
            key=notification.get('sendkey','')
            if not re.fullmatch(r'SCT[A-Za-z0-9_-]{10,200}',key) or count>=5:raise ValueError('notification_unavailable')
            body=urllib.parse.urlencode({'title':conf.get('wechat_id','机器人')+' 运行提醒','desp':'每小时巡检：'+reason+'。请在 GroupDesk 检查该机器人；未自动重启微信。'}).encode()
            req=urllib.request.Request('https://sctapi.ftqq.com/'+key+'.send',data=body)
            with urllib.request.build_opener(NoRedirect).open(req,timeout=15) as response:sent=json.load(response)
            if sent.get('code')!=0:raise ValueError('notification_failed')
            previous.update(notified=marker,notice_day=day,notice_count=count+1)
        if state=='online':previous.pop('notified',None)
    except Exception:pending=True
    payload={'state':state,'wechat':bool(wechat),'bridge':True,'maibot':maibot,'reason':reason,'interval_seconds':3600,'actions':[],'notification_configured':configured,'notification_pending':pending}
    try:
        for external in conf['groups'].values():gd.api('/health',{'external_id':external,**payload})
        previous['reported_at']=now
    finally:
        from bot_runtime import save_state
        save_state(path,{**previous,'result':payload})
