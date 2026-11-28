#!/usr/bin/env python3
"""GroupDesk standalone installer and encrypted recovery utility. Python 3.10+, Docker Compose v2."""
import argparse,datetime,getpass,hashlib,json,os,re,secrets,shutil,socket,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
os.umask(0o077)
BUNDLE=Path(__file__).resolve().parent.parent

def fail(message):raise RuntimeError(message)
def run(args,**kw):return subprocess.run([str(a) for a in args],check=True,**kw)
def capture(args,**kw):return subprocess.check_output([str(a) for a in args],text=True,**kw).strip()
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()
def env_read(path):return dict(line.split('=',1) for line in path.read_text().splitlines() if line and not line.startswith('#'))
def env_write(path,values):
 if any('\n' in str(v) or '\r' in str(v) for v in values.values()):fail('Configuration contains a newline')
 path.write_text(''.join(k+'='+str(v)+'\n' for k,v in values.items()));path.chmod(0o600)
def json_write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2));path.chmod(0o600)
def check_docker():capture(['docker','compose','version']);capture(['docker','info','--format','{{.OSType}}'])
def extract(tar,dest,prefix=''):
 # No archive-controlled symlinks, absolute paths or traversal may escape the new target.
 for m in tar:
  if prefix and not (m.name==prefix.rstrip('/') or m.name.startswith(prefix)):continue
  rel=m.name[len(prefix):] if prefix else m.name
  parts=Path(rel).parts
  if not rel:continue
  if Path(rel).is_absolute() or '..' in parts or m.issym() or m.islnk() or not (m.isfile() or m.isdir()):fail('Unsafe recovery archive member')
  path=dest/rel
  if any(p.is_symlink() for p in [path,*path.parents]):fail('Recovery path contains a symlink')
  if m.isdir():path.mkdir(parents=True,exist_ok=True,mode=0o700)
  else:
   path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   with tar.extractfile(m) as source,path.open('xb') as f:shutil.copyfileobj(source,f)
   path.chmod(m.mode&0o777)
def manifest(root):
 if any(p.is_symlink() for p in root.rglob('*')):fail('Symlinks are not supported in standalone backup payloads')
 return {str(p.relative_to(root)):{'sha256':sha(p),'bytes':p.stat().st_size} for p in sorted(root.rglob('*')) if p.is_file() and p.name!='MANIFEST.json'}
def verify(root):
 expected=json.loads((root/'MANIFEST.json').read_text())
 if expected!=manifest(root):fail('Backup file manifest differs')
def gpg(args,key):
 if not shutil.which('gpg'):fail('Install GnuPG first (for example Homebrew gnupg on Mac), then retry')
 if key:
  p=Path(key).resolve()
  if not p.is_file() or p.stat().st_mode&0o077:fail('Passphrase file must be private (chmod 600)')
  return ['gpg','--batch','--pinentry-mode','loopback','--no-symkey-cache','--passphrase-file',str(p),*args]
 return ['gpg',*args]
class Instance:
 def __init__(self,path):
  self.root=Path(path).resolve();self.config=self.root/'config';self.meta=json.loads((self.root/'instance.json').read_text())
  if not re.fullmatch(r'gd-[a-z0-9][a-z0-9-]{0,36}',self.meta['project']):fail('Not a standalone project')
  self.compose=env_read(self.config/'compose.env');self.appenv=env_read(self.config/'app.env')
  if self.compose['INSTANCE_ROOT']!=str(self.root):fail('Instance moved: review paths before use')
 def dc(self,*args):return ['docker','compose','-p',self.meta['project'],'--env-file',str(self.config/'compose.env'),'-f',str(BUNDLE/'distribution/compose.yaml'),*args]
 def container(self,service):return capture(self.dc('ps','-q',service))
 def sql(self,db,sql):
  return capture(self.dc('exec','-T','postgres','psql','-X','-U',self.compose['BOOTSTRAP_USER'],'-d',db,'-At','-v','ON_ERROR_STOP=1','-c',sql))
 def pg(self):run(self.dc('up','-d','--wait','postgres'),stdout=subprocess.DEVNULL)
 def runtime(self,*args,stdin=None):return run(self.dc('run','--rm','-T','--no-deps','app',*args),stdin=stdin,stdout=subprocess.DEVNULL)
 def fingerprints(self,db):
  result={}
  for table in self.sql(db,"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines():
   if not re.fullmatch('[a-z_0-9]+',table):fail('Unexpected SQL identifier')
   rows,digest=self.sql(db,'SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(t)::text),\'\' ORDER BY md5(row_to_json(t)::text)),\'\')) FROM public."'+table+'" t').split('|')
   result[table]={'rows':int(rows),'row_digest':digest}
  return result
 def health(self):
  for i in range(90):
   try:
    capture(self.dc('exec','-T','app','node','-e',"fetch('http://127.0.0.1:3110/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"),stderr=subprocess.DEVNULL);return
   except subprocess.CalledProcessError:time.sleep(1)
  fail('Application is not healthy; inspect this instance logs')

def initialize(a):
 check_docker();root=Path(a.target).resolve()
 if not a.admin.strip() or len(a.admin)>80:fail('Administrator name must contain 1-80 characters')
 if root.exists():fail('Choose a new directory; existing directories are never overwritten')
 if not re.fullmatch(r'gd-[a-z0-9][a-z0-9-]{0,36}',a.project):fail('Project must start with gd- and contain lowercase letters/numbers/hyphens')
 if capture(['docker','ps','-aq','--filter','label=com.docker.compose.project='+a.project]):fail('Docker project already exists')
 if not 1024<=a.port<=65535:fail('Choose a port between 1024 and 65535')
 with socket.socket() as s:s.bind(('127.0.0.1',a.port))
 origin=urlsplit(a.origin or 'http://localhost:'+str(a.port))
 if origin.scheme not in {'http','https'} or not origin.hostname or origin.username or origin.password or origin.path not in {'','/'} or origin.query or origin.fragment:fail('Use a site origin')
 if origin.scheme=='http' and origin.hostname not in {'localhost','127.0.0.1','::1'}:fail('Public access requires an HTTPS origin and a separately configured TLS proxy')
 password=None
 if a.admin_password_file:
  p=Path(a.admin_password_file)
  if p.stat().st_mode&0o077:fail('Admin password file must be private')
  password=p.read_text().rstrip('\r\n')
 else:
  password=getpass.getpass('Set the first administrator password (16+ characters): ')
  if password!=getpass.getpass('Repeat password: '):fail('Passwords differ')
 if len(password)<16:fail('Administrator password requires 16+ characters')
 root.parent.mkdir(parents=True,exist_ok=True);root.mkdir(mode=0o700);root.chmod(0o700);config=root/'config';config.mkdir(mode=0o700)
 (root/'data/files').mkdir(parents=True,mode=0o700);(root/'data/postgres').mkdir(mode=0o700)
 pgpass=secrets.token_hex(32)
 env_write(config/'app.env',{'DATABASE_URL':'postgres://groupdesk:'+pgpass+'@postgres:5432/groupdesk','ADMIN_USERNAME':a.admin,'ADMIN_PASSWORD':password,'BOT_API_TOKEN':secrets.token_hex(32),'MODEL_ENCRYPTION_KEY':secrets.token_hex(32),'COOKIE_SECURE':str(origin.scheme=='https').lower(),'PUBLIC_ORIGIN':a.origin or 'http://localhost:'+str(a.port),'INSTANCE_LABEL':a.project,'GROUPDESK_SUMMARY_LIBRARY':'generic'})
 env_write(config/'compose.env',{'INSTANCE_ROOT':str(root),'APP_IMAGE':a.image,'POSTGRES_IMAGE':'postgres:16.13-bookworm','APP_PORT':a.port,'BOOTSTRAP_USER':'gdboot_'+secrets.token_hex(6),'BOOTSTRAP_PASSWORD':secrets.token_hex(32),'ISOLATED':str(a.isolated).lower()})
 json_write(root/'instance.json',{'format':1,'project':a.project,'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'isolated':a.isolated})
 print('Private configuration saved:',root,'\nNo AI key, OAuth identity or WeChat data was imported. Next: up')
def up(a):
 i=Instance(a.target);check_docker()
 if a.workers and i.meta['isolated']:fail('Workers cannot be enabled in an isolated instance')
 i.pg()
 if i.sql('postgres',"SELECT count(*) FROM pg_database WHERE datname='groupdesk'")=='0':
  password=urlsplit(i.appenv['DATABASE_URL']).password
  if not re.fullmatch('[a-f0-9]{64}',password or ''):fail('Unexpected initial database password')
  # Never expose SQL/password in process arguments, logs or stdout.
  sql=("CREATE ROLE groupdesk LOGIN SUPERUSER PASSWORD '"+password+"';CREATE DATABASE groupdesk OWNER groupdesk;\n").encode()
  run(i.dc('exec','-T','postgres','psql','-X','-U',i.compose['BOOTSTRAP_USER'],'-d','postgres','-v','ON_ERROR_STOP=1'),input=sql,stdout=subprocess.DEVNULL)
 permissions(i)
 run(i.dc('up','-d','--wait','app'),stdout=subprocess.DEVNULL);i.health()
 if a.workers:
  if i.meta['isolated']:fail('Workers cannot be enabled in an isolated instance')
  run(i.dc('--profile','workers','up','-d','worker','interaction-worker'),stdout=subprocess.DEVNULL)
 print('Healthy:',i.appenv['PUBLIC_ORIGIN'],'; workers', 'enabled' if a.workers else 'not started')
def permissions(i):
 # Handles bind-mount ownership on Linux; no host chown of unrelated directories.
 run(i.dc('run','--rm','-T','--no-deps','--user','0','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--entrypoint','sh','app','-c','chown -R 1000:1000 /data'),stdout=subprocess.DEVNULL)
def backup(a):
 i=Instance(a.target);dest=Path(a.output).resolve()
 if dest.exists():fail('Backup destination already exists')
 gpg([],a.passphrase_file);running=[]
 for service in ['interaction-worker','worker','app']:
  c=i.container(service)
  if c and json.loads(capture(['docker','inspect',c]))[0]['State']['Running']:running.append(service)
 with tempfile.TemporaryDirectory(prefix='groupdesk-backup-') as temp:
  root=Path(temp)/'backup';root.mkdir();(root/'databases').mkdir()
  try:
   for service in running:run(i.dc('stop',service),stdout=subprocess.DEVNULL)
   for table,condition in [('managed_runtime_jobs',"status IN ('preparing','executing')"),('managed_bot_purges',"status='processing'"),('managed_deletion_cleanups',"status='processing'")]:
    if i.sql('groupdesk',"SELECT to_regclass('public."+table+"') IS NOT NULL")=='t' and i.sql('groupdesk','SELECT count(*) FROM '+table+' WHERE '+condition)!='0':fail('Maintenance still active: reconcile before backup')
   dbs=[];fingerprints={}
   for line in i.sql('postgres',"SELECT datname,pg_get_userbyid(datdba) FROM pg_database WHERE NOT datistemplate AND datname<>'postgres' ORDER BY datname").splitlines():
    db,owner=line.split('|')
    if not re.fullmatch(r'groupdesk|gdb_[a-f0-9]{32}',db):fail('Unexpected database in instance')
    dbs.append({'name':db,'owner':owner})
    with (root/'databases'/(db+'.dump')).open('wb') as f:run(i.dc('exec','-T','postgres','pg_dump','-U',i.compose['BOOTSTRAP_USER'],'-d',db,'-Fc'),stdout=f)
    fingerprints[db]=i.fingerprints(db)
   with (root/'roles.sql').open('wb') as f:run(i.dc('exec','-T','postgres','pg_dumpall','-U',i.compose['BOOTSTRAP_USER'],'--globals-only'),stdout=f)
   json_write(root/'databases.json',dbs);json_write(root/'database-fingerprints.json',fingerprints)
   shutil.copytree(i.root/'data/files',root/'files',symlinks=True);shutil.copy2(i.config/'app.env',root/'app.env')
   # Pin every actually running service image separately, including mixed releases.
   images={}
   for service in ['postgres','app','worker','interaction-worker']:
    c=i.container(service)
    if c:images[service]=json.loads(capture(['docker','inspect',c]))[0]['Image']
   json_write(root/'images.json',images)
   with (root/'images.tar').open('wb') as f:run(['docker','image','save',*sorted(set(images.values()))],stdout=f)
   json_write(root/'metadata.json',{'format':1,'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'project':i.meta['project'],'scope':'site databases, files, matching secrets and exact images; WeChat runtime backups are separate'})
  finally:
   for service in reversed(running):run(i.dc('start',service),stdout=subprocess.DEVNULL)
  json_write(root/'MANIFEST.json',manifest(root))
  plain=Path(temp)/'backup.tar'
  with tarfile.open(plain,'w') as tar:tar.add(root,arcname='backup')
  run(gpg(['--symmetric','--cipher-algo','AES256','--output',str(dest),str(plain)],a.passphrase_file))
  # Full authenticated decryption plus every file digest, not just pg_restore --list.
  check=Path(temp)/'check.tar';run(gpg(['--output',str(check),'--decrypt',str(dest)],a.passphrase_file),stdout=subprocess.DEVNULL)
  checked=Path(temp)/'checked';checked.mkdir()
  with tarfile.open(check) as tar:extract(tar,checked)
  verify(checked/'backup')
 dest.chmod(0o600);json_write(dest.with_suffix(dest.suffix+'.verification.json'),{'sha256':sha(dest),'bytes':dest.stat().st_size,'decryption_verified':True,'manifest_verified':True})
 print('Encrypted, fully verified backup:',dest)

def restore(a):
 i=Instance(a.target);check_docker()
 if capture(i.dc('ps','-aq')) or any((i.root/'data/postgres').iterdir()) or any((i.root/'data/files').iterdir()):fail('Restore requires a NEW empty instance; existing data is never replaced')
 if not a.confirm_empty_target:fail('Review the new target and use --confirm-empty-target')
 with tempfile.TemporaryDirectory(prefix='groupdesk-restore-') as temp:
  temp=Path(temp);source=Path(a.source).resolve()
  if source.is_file():
   decrypted=temp/'input.tar';run(gpg(['--output',str(decrypted),'--decrypt',str(source)],a.passphrase_file),stdout=subprocess.DEVNULL)
   unpack=temp/'unpacked';unpack.mkdir()
   with tarfile.open(decrypted) as tar:extract(tar,unpack)
   roots=list(unpack.iterdir())
   if len(roots)!=1 or not roots[0].is_dir():fail('Expected one recovery root')
   source=roots[0]
  portable=(source/'metadata.json').exists()
  if portable:verify(source)
  elif (source/'FINAL-MANIFEST.json').exists():
   expected=json.loads((source/'FINAL-MANIFEST.json').read_text())
   for name,meta in expected.items():
    path=source/name
    if Path(name).is_absolute() or '..' in Path(name).parts or not path.is_file() or sha(path)!=meta.get('sha256'):fail('Legacy recovery manifest differs')
  else:fail('Unsupported recovery directory; manifest required')
  # Keep new origin/port/instance identity but recover the exact data-encryption key.
  if portable:oldenv=env_read(source/'app.env')
  else:
   old=json.loads((source/'containers.json').read_text())['groupdesk-app-1']['Config']['Env'];oldenv=dict(v.split('=',1) for v in old if '=' in v)
  for key in ['MODEL_ENCRYPTION_KEY','ADMIN_USERNAME','ADMIN_PASSWORD']:
   if key in oldenv:i.appenv[key]=oldenv[key]
  i.appenv['BOT_API_TOKEN']=secrets.token_hex(32)
  oldurl=urlsplit(oldenv['DATABASE_URL']);i.appenv['DATABASE_URL']=urlunsplit((oldurl.scheme,oldurl.netloc.rsplit('@',1)[0]+'@postgres:5432',oldurl.path,oldurl.query,oldurl.fragment))
  env_write(i.config/'app.env',i.appenv)
  files=i.root/'data/files'
  if portable:
   shutil.rmtree(files);shutil.copytree(source/'files',files,symlinks=False)
  else:
   with tarfile.open(source/'files-and-release.tar.gz') as tar:extract(tar,files,'opt/persist/groupdesk/files/')
  i.pg()
  with (source/'roles.sql').open('rb') as f:run(i.dc('exec','-T','postgres','psql','-X','-U',i.compose['BOOTSTRAP_USER'],'-d','postgres','-v','ON_ERROR_STOP=1'),stdin=f,stdout=subprocess.DEVNULL)
  dbs=json.loads((source/'databases.json').read_text());expected=json.loads((source/'database-fingerprints.json').read_text());matched=0
  for record in dbs:
   db,owner=record['name'],record['owner']
   if not re.fullmatch(r'groupdesk|gdb_[a-f0-9]{32}',db) or not re.fullmatch('[a-z_0-9]+',owner):fail('Unsafe database binding')
   run(i.dc('exec','-T','postgres','createdb','-U',i.compose['BOOTSTRAP_USER'],'-O',owner,db),stdout=subprocess.DEVNULL)
   with (source/'databases'/(db+'.dump')).open('rb') as f:run(i.dc('exec','-T','postgres','pg_restore','--exit-on-error','-U',i.compose['BOOTSTRAP_USER'],'-d',db),stdin=f,stdout=subprocess.DEVNULL)
   actual=i.fingerprints(db)
   if actual!=expected[db]:fail('Restored table content differs: '+db)
   matched+=len(actual)
  permissions(i)
  # Only this clean package image is started. Archived old images are retained in backup, never auto-activated.
  i.runtime('node','--import','tsx','distribution/reconcile.ts')
  run(i.dc('up','-d','--wait','app'),stdout=subprocess.DEVNULL);i.health()
  json_write(i.root/'restore-validation.json',{'status':'passed','restored_databases':len(dbs),'matching_tables':matched,'old_data_checked_before_migrations':True,'robots_paused':True,'workers_started':False,'runtime_connections_invalidated':True,'package_image':i.compose['APP_IMAGE']})
 print('Restore passed. Robots paused, old connections invalidated, workers NOT started. Review:',i.root/'restore-validation.json')

def main():
 p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
 init=sub.add_parser('init');init.add_argument('--target',required=True);init.add_argument('--project',required=True);init.add_argument('--image',required=True);init.add_argument('--port',type=int,default=3110);init.add_argument('--origin');init.add_argument('--admin',default='admin');init.add_argument('--admin-password-file');init.add_argument('--isolated',action='store_true')
 for action in ['up','status','backup','restore']:
  s=sub.add_parser(action);s.add_argument('--target',required=True)
  if action=='up':s.add_argument('--workers',action='store_true')
  if action=='backup':s.add_argument('--output',required=True);s.add_argument('--passphrase-file')
  if action=='restore':s.add_argument('--source',required=True);s.add_argument('--passphrase-file');s.add_argument('--confirm-empty-target',action='store_true')
 a=p.parse_args()
 if a.action=='init':initialize(a)
 elif a.action=='up':up(a)
 elif a.action=='backup':backup(a)
 elif a.action=='restore':restore(a)
 else:run(Instance(a.target).dc('ps'))
if __name__=='__main__':
 try:main()
 except (RuntimeError,subprocess.CalledProcessError,OSError,ValueError) as error:
  # No environment values or subprocess input are included in exceptions.
  print('GroupDesk operation stopped:',type(error).__name__,str(error) if isinstance(error,RuntimeError) else 'Check prerequisites and private instance logs. No existing instance is replaced.',file=sys.stderr);sys.exit(1)
