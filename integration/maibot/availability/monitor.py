"""Hourly server maintenance; recovery replies use the normal bridge gates."""
from pathlib import Path
import argparse,fcntl,json,os,sqlite3,subprocess,time,urllib.request,urllib.error

PROJECT=Path(os.environ.get('MAIBOT_PROJECT','/opt/docker/oc-projects/maibot-wechat'))
PERSIST=Path(os.environ.get('MAIBOT_PERSIST','/opt/persist/maibot-wechat'))
STATE=PERSIST/'availability'
DESKTOP='/config/bowxt/availability_desktop.py'
NAMES={'wechat':'wechat-bot','bridge':'maibot-wechat-bridge','maibot':'maibot-gt'}

def atomic(path,value):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');temp.chmod(0o600);temp.replace(path)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def http(url,body=None,headers=None,timeout=12):
    request=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**(headers or {})})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=timeout) as r:return json.load(r)

def classify(s):
    if s['paused']:return 'maintenance','manual_pause'
    if not all(s['running'].values()):return 'offline','container_stopped'
    if s.get('desktop') in {'needs_phone','needs_unlock','login_ready'}:
        v=s['desktop'];return ('needs_unlock','phone_unlock') if v=='needs_unlock' else ('needs_phone','phone_confirmation') if v=='needs_phone' else ('recovering','login_button')
    if s.get('ui_input_blocked'):return 'degraded','ui_window_blocked'
    if not s['wechat']:return 'degraded','wechat_unavailable'
    if not s['maibot']:return 'degraded','maibot_unavailable'
    if not s['bridge']:return 'degraded','bridge_unavailable'
    return 'online','ok'

def next_action(s):
    state,_=classify(s)
    if state in {'online','maintenance','needs_phone','needs_unlock','offline'}:return None
    if s.get('ui_input_blocked'):return None
    if s.get('desktop')=='login_ready':return 'click_login'
    if s.get('desktop')=='process_missing':return 'start_wechat'
    if not s['wechat']:return 'restart_adapter'
    if not s['maibot']:return 'restart_maibot'
    if not s['bridge']:return 'restart_bridge'
    return None

class Driver:
    def docker(self,args,timeout=25):
        return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.DEVNULL,timeout=timeout)
    def desktop(self,action='probe'):
        try:return json.loads(self.docker(['exec','--user','abc',NAMES['wechat'],'/usr/bin/python3',DESKTOP,action],timeout=20))['state']
        except Exception:return 'ui_unavailable'
    def observe(self):
        control=json.loads((PERSIST/'bridge/control.json').read_text())
        containers={}
        for k,v in NAMES.items():
            try:containers[k]=json.loads(self.docker(['inspect',v]))[0]
            except Exception:containers[k]={'State':{'Running':False,'Pid':0}}
        running={k:v['State']['Running'] for k,v in containers.items()}
        health={}
        try:health=json.loads((PERSIST/'bridge/health.json').read_text())
        except (OSError,ValueError):pass
        status={}
        if running['wechat']:
            try:status=http('http://127.0.0.1:18087/api/status',timeout=10)
            except Exception:pass
        wechat=bool(status.get('wechat_connected') and status.get('running') and not status.get('ui_input_blocked'))
        result={'paused':not control.get('enabled') or not control.get('send_enabled'),'running':running,
                'wechat':wechat,'ui_input_blocked':bool(status.get('ui_input_blocked')),'bridge':bool(running['bridge'] and health.get('connected') and time.time()-health.get('updated_at',0)<120),
                'maibot':bool(running['maibot'] and containers['maibot']['State'].get('Health',{}).get('Status')=='healthy')}
        if not wechat and running['wechat'] and not result['paused']:result['desktop']=self.desktop()
        try:
            pid=containers['wechat']['State']['Pid'];line=next(v for v in Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines() if v.startswith('0::'))
            cg=Path('/sys/fs/cgroup')/line.split('::',1)[1].lstrip('/')
            result['memory_mib']=round(int((cg/'memory.current').read_text())/1048576,1)
            result['swap_mib']=round(int((cg/'memory.swap.current').read_text())/1048576,1)
        except (OSError,StopIteration,ValueError):pass
        try:result['notification_configured']=bool(self.notification().get('configured'))
        except Exception:result['notification_configured']=False
        return result
    def act(self,action):
        if action=='click_login':return self.desktop('login')
        if action=='start_wechat':return self.desktop('start')
        if action=='restart_adapter':self.docker(['exec',NAMES['wechat'],'s6-svc','-r','/run/service/custom-svc-bowxt']);return 'restarted'
        target=NAMES['bridge'] if action=='restart_bridge' else NAMES['maibot']
        # Do not interrupt an admitted task; its existing 90s expiry still applies.
        with sqlite3.connect('file:'+str(PERSIST/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
            if db.execute('SELECT 1 FROM turns WHERE status="active" AND expires>?',(time.time(),)).fetchone():return 'busy'
        self.docker(['restart',target],timeout=90);return 'restarted'
    def wait(self,seconds):time.sleep(seconds)
    def notification(self):
        conf=json.loads((PERSIST/'groupdesk/connection.json').read_text())
        return http(conf['url'].rstrip('/')+'/api/runtime/notification',headers={'Authorization':'Bearer '+conf['token']})
    def notify(self,state,reason,recovered=False):
        settings=self.notification()
        if not settings.get('configured'):raise ValueError('wechat_notification_not_configured')
        key=settings.get('sendkey','')
        import re,datetime,urllib.parse
        if not re.fullmatch(r'SCT[A-Za-z0-9_-]{10,200}',key):raise ValueError('invalid_notification_key')
        labels={'online':'微信与机器人已恢复连接','needs_phone':'微信需要手机确认或扫码','needs_unlock':'微信需要在手机上解除电脑端锁定','degraded':'微信或桥接异常，自动恢复尚未成功','offline':'容器已停止；为尊重手动停机，没有自动启动'}
        message='GT小跟班：'+labels.get(state,'运行状态需要检查')+'。\n巡检频率：每小时一次。'
        if state in {'needs_phone','needs_unlock'}:message+='\n远程桌面：http://127.0.0.1:18080 （需已连接SSH转发）'
        if reason=='ui_window_blocked':message+='\n微信残留窗口未能安全清理，请打开远程桌面检查；没有自动重启微信。\nhttp://127.0.0.1:18080 （需已连接SSH转发）'
        message+='\n状态原因：'+reason
        from zoneinfo import ZoneInfo
        day=datetime.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
        path=STATE/'notification-sends.json'
        try:quota=json.loads(path.read_text())
        except (OSError,ValueError):quota={}
        count=quota.get('count',0) if quota.get('day')==day else 0
        if count>=5:raise ValueError('notification_daily_limit')
        body=urllib.parse.urlencode({'title':'GT小跟班运行提醒','desp':message}).encode()
        request=urllib.request.Request('https://sctapi.ftqq.com/'+key+'.send',data=body,headers={'Content-Type':'application/x-www-form-urlencoded'})
        with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as r:value=json.load(r)
        if value.get('code')!=0:raise ValueError('wechat_notification_failed')
        atomic(path,{'day':day,'count':count+1})
    def report(self,result):
        conf=json.loads((PERSIST/'groupdesk/connection.json').read_text())
        fields=['state','wechat','bridge','maibot','reason','actions','memory_mib','swap_mib','notification_configured','notification_pending']
        payload={k:result[k] for k in fields if k in result};payload['interval_seconds']=3600
        for external in conf['groups'].values():http(conf['url'].rstrip('/')+'/api/runtime/health',{'external_id':external,**payload},{'Authorization':'Bearer '+conf['token']})
    def reconcile(self,incident,recovered_at):
        from datetime import datetime
        config=json.loads((PERSIST/'bridge/groups.json').read_text())
        rows=[]
        with sqlite3.connect('file:'+str(PERSIST/'wechat/bowxt/messages.db')+'?mode=ro',uri=True) as db:
            db.row_factory=sqlite3.Row
            for group in config.values():
                for row in db.execute('SELECT seq,chat_id,sender,content,message_type,direction,observed_at,is_at_me FROM messages WHERE chat_id=? AND seq>? AND direction="incoming" AND message_type="text" AND sender IS NOT NULL',(group['chat_id'],group.get('min_seq',0))):
                    value=dict(row)
                    try:value['source_at']=datetime.fromisoformat(value.pop('observed_at')).timestamp()
                    except (ValueError,TypeError):continue
                    if recovered_at-12*3600<=value['source_at']<=recovered_at:rows.append(value)
        script="""import json,sys
from policy import Policy
import recovery
v=json.load(sys.stdin);p=Policy('/limits-state')
print(json.dumps(recovery.reconcile(p,v['incident'],v['recovered_at'],v['rows'],v['allowed'])))
"""
        process=subprocess.run(['docker','exec','-i',NAMES['bridge'],'/MaiMBot/.venv/bin/python','-c',script],input=json.dumps({'incident':incident,'recovered_at':recovered_at,'rows':rows,'allowed':[str(g['chat_id']) for g in config.values()]}),text=True,check=True,capture_output=True,timeout=35)
        return json.loads(process.stdout)
    def transport_recoveries(self):
        with sqlite3.connect('file:'+str(PERSIST/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
            return db.execute('SELECT id,ended FROM recovery_transport WHERE ended IS NOT NULL AND scanned=0 ORDER BY ended LIMIT 10').fetchall()
    def mark_transport(self,identifier):
        with sqlite3.connect(PERSIST/'limits/limits.sqlite3') as db:
            db.execute('UPDATE recovery_transport SET scanned=1 WHERE id=?',(identifier,))

def run(driver,previous,now):
    attempts=[v for v in previous.get('attempts',[]) if now-v['at']<3600]
    s=driver.observe();initial,_=classify(s);actions=[]
    incident=previous.get('incident')
    if initial not in {'online','maintenance'} and not incident:incident=str(int(now))
    while len(actions)<2 and len(attempts)<2:
        action=next_action(s)
        if not action or action in actions:break
        actions.append(action);attempts.append({'at':now,'action':action})
        result=driver.act(action)
        if result=='busy':break
        driver.wait(15 if action in {'click_login','start_wechat'} else 30)
        s=driver.observe()
    state,reason=classify(s)
    result={**s,'state':state,'reason':reason,'actions':actions,'checked_at':now,'attempts':attempts,'incident':incident}
    recovered=state=='online' and bool(incident)
    notification=state+':'+reason
    result['notified']=previous.get('notified')
    notify_needed=(state not in {'maintenance','online'} and previous.get('notified')!=notification)
    if recovered:
        recovered_at=previous.get('recovered_at') or now
        result['recovered_at']=recovered_at
        try:
            result['reconciliation']=driver.reconcile(incident,recovered_at)
            result['incident']=None
            result['recovered_at']=None
            notify_needed=previous.get('notified')!=notification
        except Exception:result['reconciliation_pending']=True
    if state=='online':
        # A short receive outage can recover between two hourly checks. Its
        # existing receive outcomes are durable; process them on this check.
        try:
            gaps=driver.transport_recoveries()
            if gaps:
                identifier,at=gaps[-1]
                result['transport_reconciliation']=driver.reconcile('transport-'+identifier,at)
                for identifier,_ in gaps:driver.mark_transport(identifier)
        except Exception:result['transport_reconciliation_pending']=True
    # Owner notifications are independent of conditional group recovery replies.
    if notify_needed or (state=='online' and previous.get('notification_pending') and previous.get('notified')!=notification):
        try:driver.notify(state,reason,recovered);result['notified']=notification
        except Exception:result['notification_pending']=True
    try:driver.report(result)
    except Exception:result['report_pending']=True
    return result

def main():
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (STATE/'monitor.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        try:previous=json.loads((STATE/'state.json').read_text())
        except (OSError,ValueError):previous={}
        result=run(Driver(),previous,time.time());atomic(STATE/'state.json',result)
        print(json.dumps({k:result[k] for k in ['state','reason','actions','checked_at']},ensure_ascii=False))

if __name__=='__main__':main()
