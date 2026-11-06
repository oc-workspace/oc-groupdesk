"""Narrow per-account onboarding operations. No arbitrary paths/commands/sends.

The website cannot access Docker or this Unix socket. Only its account-local
Docker agent can request these fixed operations; host service binds one UUID.
"""
import fcntl,hashlib,json,os,re,shutil,socketserver,sqlite3,subprocess,time,urllib.request,uuid
from pathlib import Path

class Failure(Exception):
 def __init__(self,code):self.code=code;super().__init__(code)
def need(condition,code='scope_mismatch'):
 if not condition:raise Failure(code)
def save(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 previous=path.stat() if path.exists() else None
 tmp=path.with_name(path.name+'.onboarding-tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');tmp.chmod(previous.st_mode&0o777 if previous else 0o600)
 if previous:os.chown(tmp,previous.st_uid,previous.st_gid)
 tmp.replace(path)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def identifier(value):
 try:return str(uuid.UUID(value))
 except Exception:raise Failure('scope_mismatch')
def append_scope(conf,selected,chat,external):
 """Pure append plan. Existing IDs/names may never be replaced."""
 settings=json.loads(json.dumps(conf));name=selected['name'];native=selected['native_id'];key=str(chat)
 old=next((g for g in settings['reader']['groups'] if g['chat_id']==chat or g['name']==name or g.get('native_id')==native),None)
 need(not old or (old['chat_id']==chat and old['name']==name and old.get('native_id',native)==native),'config_changed')
 need(name not in settings['bridge'] or settings['bridge'][name]['chat_id']==chat,'config_changed')
 need(key not in settings['connection']['groups'] or settings['connection']['groups'][key]==external,'config_changed')
 if not old:settings['reader']['groups'].append({'chat_id':chat,'name':name,'native_id':native})
 need(len(settings['reader']['groups'])<=10,'group_limit')
 settings['bridge'].setdefault(name,{'chat_id':chat,'min_seq':0});settings['connection']['groups'][key]=external
 if name not in settings['allowed']:settings['allowed'].append(name)
 settings['compose']['services']['wechat-bridge'].setdefault('environment',{})['WECHAT_ALLOWED_GROUPS']=json.dumps(list(settings['bridge']),ensure_ascii=False)
 return settings

class Driver:
 def __init__(self,bot_id,base='/opt'):
  self.bot=identifier(bot_id);self.slug=self.bot.replace('-','');need(self.slug!='00000000000040008000000000000001')
  self.root=Path(base)/'docker/oc-projects/groupdesk-bots'/self.slug;self.persist=Path(base)/'persist/groupdesk-bots'/self.slug
  self.names={name:'gdbot-'+self.slug+'-'+name+'-1' for name in ['wechat','reader','wechat-bridge','maibot']}
  self.state=self.persist/'onboarding';self.state.mkdir(mode=0o700,parents=True,exist_ok=True)
  self.validate()
 def validate(self):
  need(self.root.resolve()==self.root and self.persist.resolve()==self.persist)
  meta=json.loads((self.root/'deployment.json').read_text());c=json.loads((self.persist/'groupdesk/connection.json').read_text());r=json.loads((self.persist/'reader/config/reader.json').read_text())
  need(meta['bot_id']==self.bot==c['bot_id'] and meta['runtime_instance_id']==c['runtime_instance_id'])
  need(hashlib.sha256(r['account'].encode()).hexdigest()==c['account_fingerprint'])
  return c
 def command(self,args,timeout=40,input=None):
  try:return subprocess.check_output(args,text=True,input=input,stderr=subprocess.DEVNULL,timeout=timeout)
  except Exception:raise Failure('restart_failed')
 def exec(self,service,code,value=None,timeout=60):
  raw=self.command(['docker','exec','-i',self.names[service],'/usr/bin/python3' if service=='wechat' else 'python' if service=='reader' else '/MaiMBot/.venv/bin/python','-c',code],input=None if value is None else json.dumps(value),timeout=timeout)
  try:return json.loads(raw)
  except Exception:raise Failure('operation_failed')
 def ports(self):
  v=json.loads(self.command(['docker','inspect','--format','{{json .HostConfig.PortBindings}}',self.names['wechat']]))
  result={}
  for port in ['8787/tcp','3000/tcp']:
   p=v.get(port);need(p and len(p)==1 and p[0]['HostIp']=='127.0.0.1');result[port]=int(p[0]['HostPort'])
  return result
 def api(self,path,body=None):
  url='http://127.0.0.1:'+str(self.ports()['8787/tcp'])+'/api/'+path
  try:
   request=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
   with urllib.request.urlopen(request,timeout=15) as r:return json.load(r)
  except Exception:raise Failure('needs_login')
 def discover(self,group_name=''):
  conf=self.validate();script=(Path(__file__).parent/'discover.py').read_text()
  raw=self.exec('reader',script,{'group_name':group_name},timeout=90);need(raw.get('account_fingerprint')==conf['account_fingerprint'])
  known={}
  with sqlite3.connect('file:'+str(self.persist/'reader/data/archive.sqlite3')+'?mode=ro',uri=True) as db:
   for chat,native in db.execute('SELECT chat_id,native_id FROM groups'):known[native]=conf['groups'].get(str(chat))
  candidates=[]
  for g in raw['groups']:
   if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}@chatroom',g['native_id']) or len(g['name'])>200:continue
   candidates.append({**g,'id':hashlib.sha256((self.bot+'\0'+g['native_id']).encode()).hexdigest(),'external_id':known.get(g['native_id'])})
  return {'candidates':candidates,'desktop_url':'http://127.0.0.1:'+str(self.ports()['3000/tcp'])+'/'}
 def paths(self):
  return {'compose':self.root/'compose.json','reader':self.persist/'reader/config/reader.json','bridge':self.persist/'bridge/groups.json','connection':self.persist/'groupdesk/connection.json','allowed':self.persist/'wechat/bowxt/allowed-chat-names.json'}
 def configurations(self):return {k:json.loads(p.read_text()) for k,p in self.paths().items()}
 def quiet(self):
  with sqlite3.connect('file:'+str(self.persist/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
   active=db.execute('SELECT count(*) FROM turns WHERE status="active" AND expires>?',(time.time(),)).fetchone()[0]
   pending=db.execute('SELECT count(*) FROM pending').fetchone()[0]
  status=self.api('status');return not active and not pending and not status.get('queue_depth') and not status.get('image_queue_depth')
 def reload_sender(self):
  self.command(['docker','exec',self.names['wechat'],'s6-svc','-r','/run/service/custom-svc-bowxt'])
  self.until(lambda:self.api('status').get('wechat_connected') is True,'needs_login',35)
 def reload_reader(self):
  self.command(['docker','restart',self.names['reader']],timeout=50)
  code="import json,urllib.request;print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:5030/healthz',timeout=3))))"
  self.until(lambda:self.exec('reader',code).get('ok') is True,'reader_unavailable',75)
 def reload_bridge(self):
  self.command(['docker','compose','--env-file',str(self.root/'.env'),'-f',str(self.root/'compose.json'),'--profile','runtime','up','-d','--no-deps','--no-build','wechat-bridge'],timeout=100)
  # Rebind only this account's existing exact runtime /32 egress rules.
  self.command(['systemctl','restart','groupdesk-bot-runtime-egress@'+self.bot+'.service'],timeout=90)
 def until(self,check,code,seconds):
  deadline=time.monotonic()+seconds
  while True:
   try:
    if check():return
   except Exception:pass
   if time.monotonic()>=deadline:raise Failure(code)
   time.sleep(1)
 def progress(self,job):
  path=self.state/(identifier(job)+'.json')
  return {'stage':json.loads(path.read_text()).get('stage','preflight') if path.exists() else 'preflight','desktop_url':'http://127.0.0.1:'+str(self.ports()['3000/tcp'])+'/'}
 def step(self,path,state,stage):state['stage']=stage;save(path,state)
 def recover(self,state):
  backup=Path(state['backup']);expected=state.get('expected',{});paths=self.paths()
  for k,p in paths.items():
   if k in expected:need(sha(p) in {expected[k],sha(backup/(k+'.json'))},'config_changed')
  control=self.persist/'bridge/control.json';original=state.get('original_control')
  if original:
   current=json.loads(control.read_text());need(current in [original,{**original,'enabled':False},{**original,'enabled':False,'send_enabled':False}],'config_changed')
   need(self.quiet(),'busy');save(control,{**original,'enabled':False});self.until(self.quiet,'busy',30)
   paused={**original,'enabled':False,'send_enabled':False};save(control,paused)
   self.command(['docker','stop','--time','25',self.names['wechat-bridge']],timeout=40)
  for k,p in paths.items():
   if k in expected:save(p,json.loads((backup/(k+'.json')).read_text()))
  if original:
   self.reload_sender();self.reload_reader();self.reload_bridge();need(json.loads(control.read_text())==paused,'config_changed');save(control,original)
 def connect(self,job,selected):
  job=identifier(job);journal=self.state/(job+'.json')
  if journal.exists():
   previous=json.loads(journal.read_text())
   need(previous.get('candidate_id')==selected['id'])
   if previous.get('complete'):
    self.verify(previous['result']['external_id']);return previous['result']
   self.recover(previous)
  live=self.discover(selected['name']);actual=next((c for c in live['candidates'] if c['id']==selected['id']),None)
  need(actual and actual['native_id']==selected['native_id'] and actual['name']==selected['name'],'group_missing');need(not actual['ambiguous'],'duplicate_name')
  need(not actual.get('external_id'),'config_changed')
  status=self.api('status');need(status.get('wechat_connected') is True and not status.get('ui_input_blocked'),'needs_login')
  need(self.quiet(),'busy');before=self.configurations();need(len(before['reader']['groups'])<10,'group_limit')
  backup=self.state/(job+'-attempt-'+uuid.uuid4().hex[:12]);backup.mkdir(mode=0o700)
  for k,p in self.paths().items():shutil.copy2(p,backup/(k+'.json'))
  control=self.persist/'bridge/control.json';original=json.loads(control.read_text());need(original.get('enabled') is True and original.get('send_enabled') is True,'busy')
  state={'candidate_id':selected['id'],'stage':'preflight','backup':str(backup),'complete':False,'original_control':original,'expected':{}};save(journal,state)
  expected={};paused={**original,'enabled':False};save(control,paused)
  try:
   self.until(self.quiet,'busy',30)
   paused={**original,'enabled':False,'send_enabled':False};save(control,paused)
   self.command(['docker','stop','--time','25',self.names['wechat-bridge']],timeout=40)
   self.step(journal,state,'binding')
   names=list(before['allowed']);
   if selected['name'] not in names:names.append(selected['name'])
   state['expected']['allowed']=hashlib.sha256((json.dumps(names,ensure_ascii=False,indent=2)+'\n').encode()).hexdigest();save(journal,state)
   save(self.paths()['allowed'],names);expected['allowed']=sha(self.paths()['allowed']);self.reload_sender()
   chat=self.api('chats',{'name':selected['name'],'chat_type':'group'})['chat']['id'];need(type(chat) is int and 0<chat<2**31)
   external='bowxt-'+self.slug+':'+str(chat);planned=append_scope(before,selected,chat,external)
   for k,p in self.paths().items():
    # The controlled sender allowlist is the sole file already changed above.
    old=(backup/(k+'.json'));need(sha(p)==expected.get(k,sha(old)),'config_changed')
    state['expected'][k]=hashlib.sha256((json.dumps(planned[k],ensure_ascii=False,indent=2)+'\n').encode()).hexdigest();save(journal,state)
    save(p,planned[k]);expected[k]=sha(p)
   self.step(journal,state,'reader');self.reload_reader()
   tail=self.exec('reader',"import json,urllib.request;from pathlib import Path;t=Path('/client/api-token').read_text().strip();r=urllib.request.Request('http://127.0.0.1:5030/v1/stream?chat="+str(chat)+"&after=tail&limit=1',headers={'Authorization':'Bearer '+t});print(json.dumps(json.load(urllib.request.urlopen(r))))")
   need(re.fullmatch('[a-f0-9]{32}',tail.get('epoch','')) and type(tail.get('watermark')) is int,'reader_unavailable')
   with sqlite3.connect(self.persist/'bridge/delivery.sqlite3') as db:
    db.execute('INSERT INTO reader_cursors(chat_id,epoch,after_seq,cutover,pending_seq,retry_until) VALUES(?,?,?,?,NULL,0) ON CONFLICT(chat_id) DO UPDATE SET epoch=excluded.epoch,after_seq=excluded.after_seq,cutover=excluded.cutover,pending_seq=NULL,retry_until=0',(chat,tail['epoch'],tail['watermark'],tail['cutover_at']))
   self.step(journal,state,'sender');need(self.api('status').get('wechat_connected') is True,'needs_login')
   self.step(journal,state,'runtime');self.reload_bridge()
   need(json.loads(control.read_text())==paused,'config_changed');save(control,original)
   self.until(lambda:self.verify(external)['reader'],'reader_unavailable',30)
   state.update(complete=True,stage='ack',result={'external_id':external,'chat_id':chat,'desktop_url':live['desktop_url']});save(journal,state);return state['result']
  except Exception as exc:
   # Restore only our own unchanged writes. Never restore live SQLite ledgers,
   # remove SDK records, or overwrite concurrent operator edits.
   conflict=False
   for k,p in self.paths().items():
    if k in expected:
     if sha(p)==expected[k]:shutil.copy2(backup/(k+'.json'),p)
     else:conflict=True
   try:
    if not conflict:
     self.reload_sender();self.reload_reader();self.reload_bridge()
     if json.loads(control.read_text())==paused:save(control,original)
     else:conflict=True
   except Exception:conflict=True
   state.update(error='config_changed' if conflict else getattr(exc,'code','operation_failed'));save(journal,state)
   raise Failure(state['error'])
 def verify(self,external):
  conf=self.validate();chat=next((int(k) for k,v in conf['groups'].items() if v==external),None);need(chat is not None)
  cfg=self.configurations();group=next((g for g in cfg['reader']['groups'] if g['chat_id']==chat),None);need(group and cfg['bridge'].get(group['name'],{}).get('chat_id')==chat and group['name'] in cfg['allowed'])
  status=self.api('status')
  with sqlite3.connect('file:'+str(self.persist/'reader/data/archive.sqlite3')+'?mode=ro',uri=True) as db:bound=db.execute('SELECT native_id FROM groups WHERE chat_id=?',(chat,)).fetchone()
  need(bound and bound[0]==group['native_id'])
  health=json.loads((self.persist/'bridge/health.json').read_text())
  return {'wechat':status.get('wechat_connected') is True,'sender':group['name'] in cfg['allowed'],'reader':bool(health.get('reader',{}).get('connected') and time.time()-health.get('reader',{}).get('checked_at',0)<90),'external_id':external,'chat_id':chat,'desktop_url':'http://127.0.0.1:'+str(self.ports()['3000/tcp'])+'/'}
 def greeting(self,job,external):
  need(all(self.verify(external).get(k) for k in ['wechat','reader','sender']),'not_ready');chat=next(int(k) for k,v in self.validate()['groups'].items() if v==external)
  code=(Path(__file__).parent/'greeting.py').read_text()
  try:return self.exec('wechat-bridge',code,{'job_id':identifier(job),'chat_id':chat},timeout=25)
  except Failure:raise Failure('greeting_failed')
 def handle(self,task):
  need(isinstance(task,dict) and set(task)<={'id','kind','candidate','external_id','group_name'})
  job=identifier(task.get('id'));kind=task.get('kind');need(kind in {'discover','connect','verify','greeting','progress'})
  need('group_name' not in task or (kind=='discover' and isinstance(task['group_name'],str) and 1<=len(task['group_name'].strip())<=200))
  if kind=='progress':return self.progress(job)
  with (self.state/'control.lock').open('a') as lock:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise Failure('busy')
   self.validate()
   if kind=='discover':return self.discover(task.get('group_name','').strip())
   if kind=='connect':
    c=task.get('candidate');need(isinstance(c,dict) and set(c)=={'id','native_id','name','ambiguous','external_id'});need(re.fullmatch('[a-f0-9]{64}',c['id']) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}@chatroom',c['native_id']) and isinstance(c['name'],str) and 1<=len(c['name'])<=200);return self.connect(job,c)
   external=task.get('external_id');need(isinstance(external,str) and re.fullmatch('bowxt-'+self.slug+r':[1-9]\d{0,9}',external))
   return self.verify(external) if kind=='verify' else self.greeting(job,external)
