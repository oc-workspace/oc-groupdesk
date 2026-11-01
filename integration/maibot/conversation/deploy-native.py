"""Apply the reviewed mounted policy files; preserve WeChat and private settings."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,time,tomllib
parser=argparse.ArgumentParser()
parser.add_argument('--stage',type=Path,required=True)
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--release',required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
assert re.fullmatch('[a-f0-9]{40}',args.release)
os.umask(0o077)
root=Path('/opt/docker/oc-projects/maibot-wechat');persistent=Path('/opt/persist/maibot-wechat');stage=args.stage
manifest=json.loads(args.manifest.read_text())
assert manifest['revision']==args.release and manifest['tests']=={'unit':57,'database':50,'native':284}
files=list(manifest['candidate'])
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def source(name):return stage/name
for name in files:
 if name not in manifest['baseline'] and (root/name).exists():raise RuntimeError('Unexpected preexisting source: '+name)
for name,expected in manifest['baseline'].items():
 if digest(root/name)!=expected:raise RuntimeError('Runtime source changed: '+name)
for name,expected in manifest['candidate'].items():
 if digest(source(name))!=expected:raise RuntimeError('Unverified staged source: '+name)
compose=['docker','compose','--profile','bridge','-f',str(root/'compose.yaml')]
subprocess.run(compose+['config','--quiet'],cwd=root,check=True)
if args.check:print(json.dumps({'preflight':'ok','source_commit':args.release,'candidate':manifest['candidate']}));raise SystemExit(0)
backup=root/'install-artifacts'/('conversation-'+datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700,parents=True)
control=persistent/'bridge/control.json';original=control.read_bytes();original_value=json.loads(original)
maintenance={**original_value,'enabled':False};maintenance_bytes=(json.dumps(maintenance)+'\n').encode()
def atomic(path,data):
 temp=path.with_name(path.name+'.conversation-tmp');temp.write_bytes(data);temp.chmod(0o600 if path==control else 0o644);temp.replace(path)
def restore_control():
 if control.read_bytes()==maintenance_bytes:atomic(control,original);return True
 return False
def state(name):return json.loads(subprocess.check_output(['docker','inspect','-f','{{json .State}}',name],text=True))
wechat_before=state('wechat-bot')['StartedAt']
def config_digest():
 result={}
 for path in [persistent/'maibot/config/model_config.toml',persistent/'maibot/config/bot_config.toml',root/'limits/policy.json']:
  value=tomllib.loads(path.read_text()) if path.suffix=='.toml' else json.loads(path.read_text())
  result[str(path)]=hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
 return result
configuration_before=config_digest()
(backup/'control.json').write_bytes(original)
for name in files:
 path=root/name
 if path.exists():dest=backup/'before'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,dest)
(backup/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
atomic(control,maintenance_bytes)
print('Ingress temporarily paused; allowing any in-flight claim to finish.',flush=True)
time.sleep(5)
with sqlite3.connect('file:'+str(persistent/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
 now=time.time();active=db.execute('SELECT COUNT(*) FROM turns WHERE status="active" AND expires>?',(now,)).fetchone()[0]
 busy=db.execute('SELECT COUNT(*) FROM attempts a JOIN turns t ON a.turn_id=t.id WHERE a.state="reserved" AND (t.expires>? OR a.ts>?)',(now,now-180)).fetchone()[0]
 if active or busy:
  restore_control();raise RuntimeError('Active work found; runtime was not stopped or changed')
# No active model request is stopped; budget and delivery ledgers remain in place.
log=(backup/'deployment.log').open('w')
changed=False
try:
 subprocess.run(compose+['stop','maibot','wechat-bridge'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
 for path in [persistent/'limits/limits.sqlite3',persistent/'bridge/delivery.sqlite3']:
  if path.exists():
   target=backup/(path.parent.name+'-'+path.name)
   with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as src,sqlite3.connect(target) as dest:src.backup(dest)
 changed=True
 for name in files:atomic(root/name,source(name).read_bytes())
 for name,expected in manifest['candidate'].items():
  if digest(root/name)!=expected:raise RuntimeError('Installed source mismatch')
 subprocess.run(compose+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','maibot','wechat-bridge'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
 if config_digest()!=configuration_before:raise RuntimeError('Unexpected native configuration changes')
 if state('wechat-bot')['StartedAt']!=wechat_before:raise RuntimeError('Unexpected WeChat restart')
 restored=restore_control()
 result={'source_commit':manifest['revision'],'backup':str(backup),'control_restored':restored,'configuration_unchanged':True,'wechat_started_at':wechat_before,'installed_hashes':manifest['candidate'],'containers':{name:{'status':state(name)['Status'],'health':state(name).get('Health',{}).get('Status')} for name in ['maibot-gt','maibot-wechat-bridge','wechat-bot']}}
 (backup/'deployment-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
except BaseException:
 if changed:
  for name in files:
   before=backup/'before'/name
   if before.exists():atomic(root/name,before.read_bytes())
   elif (root/name).exists():(root/name).unlink()
  subprocess.run(compose+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','maibot','wechat-bridge'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
 else:
  subprocess.run(compose+['start','maibot','wechat-bridge'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
 restore_control();raise
finally:log.close()
