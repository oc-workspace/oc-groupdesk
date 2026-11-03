"""Upgrade only the reader and bridge; preserve the desktop, account and cursors."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,time
parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--release',required=True);args=parser.parse_args()
assert re.fullmatch('[a-f0-9]{40}',args.release)
meta=json.loads(args.manifest.read_text());assert meta['release']==args.release and meta['tests']=={'reader':73,'native_ingress':5}
root=Path('/opt/docker/oc-projects/chatlog-reader');native=Path('/opt/docker/oc-projects/maibot-wechat');persist=Path('/opt/persist/maibot-wechat');data=Path('/opt/persist/chatlog-reader')
package=Path(__file__).resolve().parent;source=package.parent/'maibot/chatlog_runtime.py'
# The standalone release package may supply the native file beside this script.
if not source.exists():source=package/'chatlog_runtime.py'
target=native/'limits/chatlog_runtime.py';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def output(argv):return subprocess.check_output(list(map(str,argv)),text=True)
def inspect(name):return json.loads(output(['docker','inspect',name]))[0]
def run(argv,**kw):return subprocess.run(list(map(str,argv)),check=True,**kw)
assert sha(source)==meta['native_after'] and sha(target)==meta['native_before']
assert inspect('chatlog-reader')['Image']==meta['reader_before']
assert output(['docker','image','inspect','-f','{{.Id}}',meta['reader_after']]).strip()==meta['reader_after']
for field in ('reader_before','reader_after'):assert re.fullmatch('sha256:[a-f0-9]{64}',meta[field])
def identity():
 with sqlite3.connect('file:'+str(data/'data/archive.sqlite3')+'?mode=ro',uri=True) as db:
  epoch=db.execute('SELECT value FROM meta WHERE key="epoch"').fetchone()[0]
  maximum=db.execute('SELECT COALESCE(MAX(seq),0) FROM messages').fetchone()[0]
  return epoch,maximum
old_epoch,old_max=identity();wechat=inspect('wechat-bot')['State']['StartedAt']
compose_files=inspect('maibot-wechat-bridge')['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
assert all(Path(p).parent==native and Path(p).is_file() for p in compose_files)
bridge=['docker','compose','--profile','bridge',*[v for p in compose_files for v in ('-f',p)]]
reader=['docker','compose','--env-file',str(root/'.env'),'-f',str(package/'compose.yaml')]
control=persist/'bridge/control.json';original=control.read_bytes();value=json.loads(original)
maintenance=(json.dumps({**value,'enabled':False})+'\n').encode()
def atomic(path,content,mode=0o600):
 tmp=path.with_name(path.name+'.references-tmp');tmp.write_bytes(content);tmp.chmod(mode);tmp.replace(path)
def restore():
 if control.read_bytes()==maintenance:atomic(control,original);return True
 return False
backup=data/'backups'/('references-'+datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700,parents=True)
shutil.copy2(target,backup/'chatlog_runtime.py');shutil.copy2(root/'.env',backup/'reader.env');(backup/'manifest.json').write_bytes(args.manifest.read_bytes());(backup/'control.json').write_bytes(original)
private=[persist/'maibot/config/model_config.toml',persist/'maibot/config/bot_config.toml',native/'limits/policy.json',persist/'bridge/groups.json'];private_before={str(p):sha(p) for p in private}
previous_current=root.resolve()/'current';old_link=os.readlink(previous_current) if previous_current.is_symlink() else None
atomic(control,maintenance);print('Paused ingress; waiting for existing tasks, without restarting WeChat.',flush=True)
time.sleep(5);deadline=time.time()+480
def busy():
 with sqlite3.connect('file:'+str(persist/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
  now=time.time();return bool(db.execute('SELECT 1 FROM turns WHERE status="active" AND expires>?',(now,)).fetchone() or db.execute('SELECT 1 FROM attempts a JOIN turns t ON a.turn_id=t.id WHERE a.state="reserved" AND (t.expires>? OR a.ts>?)',(now,now-180)).fetchone())
while busy():
 if time.time()>deadline:restore();raise RuntimeError('Existing work did not finish; runtime unchanged')
 time.sleep(3)
log=(backup/'deploy.log').open('w');changed=False
try:
 run(bridge+['stop','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT)
 for dbpath,label in [(data/'data/archive.sqlite3','archive.sqlite3'),(persist/'bridge/delivery.sqlite3','delivery.sqlite3'),(persist/'limits/limits.sqlite3','limits.sqlite3')]:
  with sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True) as src,sqlite3.connect(backup/label) as dest:src.backup(dest)
 env=(root/'.env').read_text();assert len(re.findall(r'^CHATLOG_READER_IMAGE=.*$',env,re.M))==1
 changed=True;atomic(target,source.read_bytes(),0o644);atomic(root/'.env',re.sub(r'^CHATLOG_READER_IMAGE=.*$',lambda _: 'CHATLOG_READER_IMAGE='+meta['reader_after'],env,flags=re.M).encode())
 run(reader+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','reader'],cwd=package,stdout=log,stderr=subprocess.STDOUT)
 if identity()[0]!=old_epoch:raise RuntimeError('Reader archive epoch changed')
 run(bridge+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT)
 if {str(p):sha(p) for p in private}!=private_before or inspect('wechat-bot')['State']['StartedAt']!=wechat:raise RuntimeError('Unexpected configuration or WeChat change')
 for name,digest in meta['reader_sources'].items():
  actual=output(['docker','exec','chatlog-reader','python','-c',"from pathlib import Path;import hashlib;print(hashlib.sha256(Path('/app/chatlog_reader/"+name+"').read_bytes()).hexdigest())"]).strip()
  if actual!=digest:raise RuntimeError('Reader source mismatch: '+name)
 if previous_current.is_symlink():previous_current.unlink()
 previous_current.symlink_to(package)
 restored=restore();result={'release':args.release,'backup':str(backup),'control_restored':restored,'reader_epoch_unchanged':True,'archive_before_max_seq':old_max,'configuration_unchanged':True,'wechat_started_at':wechat,'reader_image':meta['reader_after'],'tests':meta['tests']}
 (backup/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
except BaseException:
 if previous_current.is_symlink() and previous_current.resolve()==package:
  previous_current.unlink()
  if old_link:previous_current.symlink_to(old_link)
 if changed:
  atomic(target,(backup/'chatlog_runtime.py').read_bytes(),0o644);atomic(root/'.env',(backup/'reader.env').read_bytes())
  run(reader+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','reader'],cwd=package,stdout=log,stderr=subprocess.STDOUT)
 run(bridge+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT);restore();raise
finally:log.close()
