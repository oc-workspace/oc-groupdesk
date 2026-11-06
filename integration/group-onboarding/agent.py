"""Scoped Docker pull worker. No Docker socket, shell or model credentials."""
import json,socket,time,threading,urllib.request,urllib.error
from pathlib import Path
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
class Agent:
 def __init__(self,connection=Path('/groupdesk/connection.json'),socket_path='/control/control.sock'):
  self.path=connection;self.socket=socket_path
 def conf(self):return json.loads(self.path.read_text())
 def api(self,path,body):
  c=self.conf();identity={k:c[k] for k in ['runtime_instance_id','account_fingerprint']};identity['instance_id']=identity.pop('runtime_instance_id');identity['contract']=1
  request=urllib.request.Request(c['url'].rstrip('/')+'/api/runtime/group-onboarding/'+path,data=json.dumps({**identity,**body}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+c['token']})
  with urllib.request.build_opener(NoRedirect).open(request,timeout=25) as r:value=json.load(r)
  Path('/tmp/onboarding-heartbeat').touch();return value
 def local(self,task):
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
   s.settimeout(900);s.connect(self.socket);s.sendall((json.dumps(task)+'\n').encode())
   with s.makefile('rb') as f:value=json.loads(f.readline(1048577))
  if not value.get('ok'):raise RuntimeError(value.get('error','operation_failed'))
  return value['result']
 def run_one(self,task):
  base={'id':task['id'],'lease_token':task['lease_token']};stop=threading.Event()
  def progress():
   while not stop.wait(15):
    try:
     stage=self.local({'id':task['id'],'kind':'progress'}).get('stage','preflight');self.api('report',{**base,'status':'working','stage':stage})
    except Exception:pass
  reporter=threading.Thread(target=progress,daemon=True);reporter.start()
  try:
   self.api('report',{**base,'status':'working','stage':'preflight'})
   local={k:v for k,v in task.items() if k in {'id','kind','candidate','external_id'} and v is not None};result=self.local(local)
   if task['kind']=='greeting':
    deadline=time.monotonic()+480
    while result.get('greeting_status')=='queued' and time.monotonic()<deadline:
     time.sleep(3);result=self.local(local)
    if result.get('greeting_status')!='sent':raise RuntimeError('greeting_pending' if result.get('greeting_status') in {'queued','uncertain'} else 'greeting_failed')
   stop.set();reporter.join(timeout=26)
   self.api('report',{**base,'status':'succeeded','stage':'ack' if task['kind']=='connect' else 'ready','result':result})
  except Exception as e:
   stop.set();reporter.join(timeout=26)
   code=str(e)
   allowed={'needs_login','reader_unavailable','group_missing','duplicate_name','group_limit','busy','config_changed','scope_mismatch','restart_failed','greeting_pending','greeting_failed','not_ready'}
   try:progress=self.local({'id':task['id'],'kind':'progress'})
   except Exception:progress={}
   self.api('report',{**base,'status':'failed','stage':progress.get('stage','preflight'),'result':{k:v for k,v in progress.items() if k=='desktop_url'},'error_code':code if code in allowed else 'operation_failed'})
 def run(self):
  while True:
   try:
    task=self.api('claim',{'version':'1'}).get('task')
    if task:self.run_one(task)
    else:time.sleep(10)
   except Exception:time.sleep(20)
if __name__=='__main__':Agent().run()
