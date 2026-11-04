"""Hash-checked reader/summary upgrade. Never restores a live ledger or key."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path,required=True);p.add_argument('--release',required=True);p.add_argument('--check',action='store_true');args=p.parse_args()
os.umask(0o077)
assert re.fullmatch('[a-f0-9]{40}',args.release)
meta=json.loads(args.manifest.read_text());assert meta['release']==args.release
assert all(meta['tests'].get(k,0)>0 for k in ('unit','database','reader','native'))
root=Path('/opt/docker/oc-projects/chatlog-reader');native=Path('/opt/docker/oc-projects/maibot-wechat');persist=Path('/opt/persist/maibot-wechat');data=Path('/opt/persist/chatlog-reader')
package=Path(__file__).resolve().parent
files={'limits/chatlog_runtime.py':package.parent/'maibot/chatlog_runtime.py','limits/summary_runtime.py':package.parent/'maibot/summaries/summary_runtime.py'}
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
def out(argv):return subprocess.check_output(list(map(str,argv)),text=True)
def inspect(name):return json.loads(out(['docker','inspect',name]))[0]
def run(argv,**kw):return subprocess.run(list(map(str,argv)),check=True,**kw)
for name,source in files.items():assert sha(source)==meta['after'][name] and sha(native/name)==meta['before'][name]
assert inspect('chatlog-reader')['Image']==meta['reader_before']
assert out(['docker','image','inspect','-f','{{.Id}}',meta['reader_after']]).strip()==meta['reader_after']
for field in ('reader_before','reader_after'):assert re.fullmatch('sha256:[a-f0-9]{64}',meta[field])
for name,expected in meta['reader_before_sources'].items():assert sha(root/'current/chatlog_reader'/name)==expected
for name,expected in meta['reader_after_sources'].items():assert sha(package/'chatlog_reader'/name)==expected
compose_files=inspect('maibot-wechat-bridge')['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
assert all(Path(f).parent==native and Path(f).is_file() for f in compose_files)
bridge=['docker','compose','--profile','bridge',*[v for f in compose_files for v in ('-f',f)]]
reader=['docker','compose','--env-file',str(root/'.env'),'-f',str(package/'compose.yaml')]
run(bridge+['config','--quiet'],cwd=native);run(reader+['config','--quiet'],cwd=package)
if args.check:print(json.dumps({'preflight':'ok','release':args.release,'tests':meta['tests']}));raise SystemExit(0)
wechat=inspect('wechat-bot')['State']['StartedAt'];maibot=inspect('maibot-gt')['State']['StartedAt']
def identity():
 with sqlite3.connect('file:'+str(data/'data/archive.sqlite3')+'?mode=ro',uri=True) as db:
  return db.execute('SELECT value FROM meta WHERE key="epoch"').fetchone()[0],db.execute('SELECT COALESCE(max(seq),0) FROM messages').fetchone()[0]
old_epoch,old_max=identity()
private=[persist/'maibot/config/model_config.toml',persist/'maibot/config/bot_config.toml',native/'limits/policy.json',persist/'bridge/groups.json',data/'secrets/wechat-key.enc',data/'secrets/vault-private.pem',data/'client/api-token']
private_before={str(path):sha(path) for path in private}
control=persist/'bridge/control.json';original=control.read_bytes();maintenance=(json.dumps({**json.loads(original),'enabled':False})+'\n').encode()
def atomic(path,content,mode=0o600):
 temp=path.with_name(path.name+'.summary-tmp');temp.write_bytes(content);temp.chmod(mode);temp.replace(path)
def restore():
 if control.read_bytes()==maintenance:atomic(control,original);return True
 return False
backup=data/'backups'/('summary-batches-'+datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700,parents=True)
for name in files:
 dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(native/name,dest)
shutil.copy2(root/'.env',backup/'reader.env');(backup/'control.json').write_bytes(original);(backup/'manifest.json').write_bytes(args.manifest.read_bytes())
link=root/'current';old_link=os.readlink(link);env=(root/'.env').read_text();assert len(re.findall(r'^CHATLOG_READER_IMAGE=.*$',env,re.M))==1
atomic(control,maintenance);print('Paused new ingress; waiting for already accepted turns.',flush=True)
try:
 time.sleep(5);deadline=time.time()+480
 while True:
  with sqlite3.connect('file:'+str(persist/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
   now=time.time();busy=db.execute('SELECT 1 FROM turns WHERE status="active" AND expires>?',(now,)).fetchone() or db.execute('SELECT 1 FROM attempts a JOIN turns t ON a.turn_id=t.id WHERE a.state="reserved" AND (t.expires>? OR a.ts>?)',(now,now-180)).fetchone()
  if not busy:break
  if time.time()>deadline:restore();raise RuntimeError('Existing work did not finish; no code changed')
  time.sleep(3)
except BaseException:
 restore();raise
log=(backup/'deploy.log').open('w');changed=False
try:
 run(bridge+['stop','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT)
 for dbpath,label in [(data/'data/archive.sqlite3','archive.sqlite3'),(persist/'bridge/delivery.sqlite3','delivery.sqlite3'),(persist/'limits/limits.sqlite3','limits.sqlite3')]:
  with sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True) as src,sqlite3.connect(backup/label) as dest:
   src.backup(dest);assert dest.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 changed=True
 for name,source in files.items():atomic(native/name,source.read_bytes(),0o644)
 atomic(root/'.env',re.sub(r'^CHATLOG_READER_IMAGE=.*$',lambda _:'CHATLOG_READER_IMAGE='+meta['reader_after'],env,flags=re.M).encode())
 run(reader+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','reader'],cwd=package,stdout=log,stderr=subprocess.STDOUT)
 assert identity()[0]==old_epoch and identity()[1]>=old_max
 run(bridge+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT)
 assert {str(path):sha(path) for path in private}==private_before
 assert inspect('wechat-bot')['State']['StartedAt']==wechat and inspect('maibot-gt')['State']['StartedAt']==maibot
 for name,expected in meta['reader_after_sources'].items():assert out(['docker','exec','chatlog-reader','python','-c',"from pathlib import Path;import hashlib;print(hashlib.sha256(Path('/app/chatlog_reader/"+name+"').read_bytes()).hexdigest())"]).strip()==expected
 for name in files:assert sha(native/name)==meta['after'][name]
 link.unlink();link.symlink_to(package)
 restored=restore()
 checks=[path for path in backup.rglob('*') if path.is_file() and path.name not in {'deploy.log','SHA256SUMS','result.json'}]
 (backup/'SHA256SUMS').write_text(''.join(sha(path)+'  '+str(path.relative_to(backup))+'\n' for path in checks))
 result={'release':args.release,'backup':str(backup),'control_restored':restored,'reader_epoch_unchanged':True,'configuration_and_keys_unchanged':True,'wechat_and_maibot_not_restarted':True,'reader_image':meta['reader_after'],'tests':meta['tests']}
 (backup/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
except BaseException:
 if link.is_symlink() and link.resolve()==package:link.unlink();link.symlink_to(old_link)
 if changed:
  for name in files:atomic(native/name,(backup/name).read_bytes(),0o644)
  atomic(root/'.env',(backup/'reader.env').read_bytes())
  run(reader+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','reader'],cwd=package,stdout=log,stderr=subprocess.STDOUT)
 run(bridge+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','180','wechat-bridge'],cwd=native,stdout=log,stderr=subprocess.STDOUT);restore();raise
finally:log.close()
