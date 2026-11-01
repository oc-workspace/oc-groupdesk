"""Hourly server maintenance. No LLM calls or chat-history exports."""
from pathlib import Path
import argparse,fcntl,json,os,sqlite3,subprocess,time,urllib.request,urllib.error

PROJECT=Path(os.environ.get('MAIBOT_PROJECT','/opt/docker/oc-projects/maibot-wechat'))
PERSIST=Path(os.environ.get('MAIBOT_PERSIST','/opt/persist/maibot-wechat'))
STATE=PERSIST/'availability'
DESKTOP='/config/bowxt/availability_desktop.py'
NAMES={'wechat':'wechat-bot','bridge':'maibot-wechat-bridge','maibot':'maibot-gt'}
NOTICE='Back online. I occasionally lose the connection; if I went quiet, it wasn’t personal—my connection has its own ideas about taking breaks. 🙂'

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
    if not s['wechat']:return 'degraded','wechat_unavailable'
    if not s['maibot']:return 'degraded','maibot_unavailable'
    if not s['bridge']:return 'degraded','bridge_unavailable'
    return 'online','ok'

def next_action(s):
    state,_=classify(s)
    if state in {'online','maintenance','needs_phone','needs_unlock','offline'}:return None
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
        wechat=bool(status.get('wechat_connected') and status.get('running'))
        result={'paused':not control.get('enabled') or not control.get('send_enabled'),'running':running,
                'wechat':wechat,'bridge':bool(running['bridge'] and health.get('connected') and time.time()-health.get('updated_at',0)<120),
                'maibot':bool(running['maibot'] and containers['maibot']['State'].get('Health',{}).get('Status')=='healthy')}
        if not wechat and running['wechat'] and not result['paused']:result['desktop']=self.desktop()
        try:
            pid=containers['wechat']['State']['Pid'];line=next(v for v in Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines() if v.startswith('0::'))
            cg=Path('/sys/fs/cgroup')/line.split('::',1)[1].lstrip('/')
            result['memory_mib']=round(int((cg/'memory.current').read_text())/1048576,1)
            result['swap_mib']=round(int((cg/'memory.swap.current').read_text())/1048576,1)
        except (OSError,StopIteration,ValueError):pass
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
    def notify(self,state,reason,recovered=False):
        env={}
        for line in Path('/opt/persist/hermes-agent/.env').read_text().splitlines():
            if '=' not in line or line.lstrip().startswith('#'):continue
            k,v=line.removeprefix('export ').split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
        chat=env.get('TELEGRAM_HOME_CHANNEL','');token=env.get('TELEGRAM_BOT_TOKEN','')
        directory=json.loads(Path('/opt/persist/hermes-agent/channel_directory.json').read_text())
        authorized=[str(v['id']) for v in directory.get('platforms',{}).get('telegram',[]) if v.get('type')=='dm']
        if not token or chat not in authorized:raise ValueError('notification_destination_unverified')
        labels={'online':'微信与机器人已恢复连接','needs_phone':'微信需要手机确认或扫码','needs_unlock':'微信需要在手机上解除电脑端锁定','degraded':'微信或桥接异常，自动恢复尚未成功','offline':'容器已停止；为尊重手动停机，没有自动启动'}
        message='GT小跟班：'+labels.get(state,'运行状态需要检查')+'。\n巡检频率：每小时一次。'
        if state in {'needs_phone','needs_unlock'}:message+='\n远程桌面：http://127.0.0.1:18080 （需已连接SSH转发）'
        message+='\n状态原因：'+reason
        value=http('https://api.telegram.org/bot'+token+'/sendMessage',{'chat_id':chat,'text':message},timeout=15)
        if not value.get('ok'):raise ValueError('notification_failed')
    def report(self,result):
        conf=json.loads((PERSIST/'groupdesk/connection.json').read_text())
        fields=['state','wechat','bridge','maibot','reason','actions','memory_mib','swap_mib']
        payload={k:result[k] for k in fields if k in result};payload['interval_seconds']=3600
        for external in conf['groups'].values():http(conf['url'].rstrip('/')+'/api/runtime/health',{'external_id':external,**payload},{'Authorization':'Bearer '+conf['token']})
    def announce(self,incident):
        # Run in the existing bridge environment, using its current quota ledger.
        script='''import json,time,os,sys
from pathlib import Path
from policy import Policy,settings
import groupdesk_runtime as gd
from bowxt import AgentClient,ChatType
data=json.loads(sys.stdin.read());p=Policy('/limits-state');cfg=json.loads(Path('/state/groups.json').read_text());agent=AgentClient('maibot-gt',base_url=os.environ['BOWXT_BASE_URL'])
for name,g in cfg.items():
 chat=g['chat_id'];p.cfg=settings();managed=gd.profile(p.cfg,str(chat))
 if not gd.available(managed,time.time()) or not gd.check_remote_revision(managed) or not gd.language_allowed(managed,data['text']):continue
 identifier='availability-'+data['incident']+'-'+str(chat)
 with p.db() as db:
  if db.execute('SELECT 1 FROM sends WHERE id=?',(identifier,)).fetchone():continue
  if p._quota(db,'direct',time.time(),table='sends',explicit=True,chat_id=str(chat)):continue
  now=time.time();db.execute('INSERT INTO sends(id,turn_id,ts,day,kind,status) VALUES(?,NULL,?,?,?,?)',(identifier,now,p.day(now),'direct','reserved'))
 try:
  if agent.ensure_chat(name,ChatType.GROUP).id!=chat:raise ValueError('group_mismatch')
  queued=agent.send_text(chat,data['text'],client_id=identifier);out=agent.wait_delivery(queued,timeout=35);status=out.delivery_status
 except Exception:status='uncertain'
 with p.db() as db:db.execute('UPDATE sends SET status=? WHERE id=?',(status,identifier))
'''
        # Code is an argument; approved notice data remains stdin. Never use shell interpolation.
        subprocess.run(['docker','exec','-i',NAMES['bridge'],'/MaiMBot/.venv/bin/python','-c',script],input=json.dumps({'incident':incident,'text':NOTICE}),text=True,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=100)

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
    if (state not in {'maintenance','online'} and previous.get('notified')!=notification) or recovered:
        try:driver.notify(state,reason,recovered);result['notified']=notification
        except Exception:result['notification_pending']=True
    if recovered:
        try:driver.announce(incident);result['announcement_attempted']=True
        except Exception:result['announcement_failed']=True
        result['incident']=None
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
