"""Root-only Docker deployment operations. Never emits credentials or chat bodies."""
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,time,urllib.request,uuid
from contextlib import contextmanager
from pathlib import Path

ROOT=Path('/opt/docker/oc-projects/chatlog-reader')
NATIVE=Path('/opt/docker/oc-projects/maibot-wechat')
PERSIST=Path('/opt/persist/chatlog-reader')
BOT=Path('/opt/persist/maibot-wechat')
CODE=Path(__file__).resolve().parent
CONTROL=BOT/'bridge/control.json'
STATE=PERSIST/'maintenance.json'

def run(argv,**kw):return subprocess.run(list(map(str,argv)),check=True,**kw)
def output(argv):return subprocess.check_output(list(map(str,argv)),text=True)
def atomic(path,data,mode=0o600):
    temp=path.with_name(path.name+'.reader-tmp');temp.write_bytes(data);temp.chmod(mode);os.replace(temp,path)
def save(path,data):atomic(path,(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode())
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def reader(*args):return run(['docker','compose','--env-file',ROOT/'.env','-f',CODE/'compose.yaml',*args],cwd=CODE)
def native(overlay=False):
    value=['docker','compose','--env-file',NATIVE/'.env','--project-directory',NATIVE,'--profile','bridge','-f',NATIVE/'compose.yaml']
    if overlay:value+=['-f',CODE/'compose.bridge.yaml']
    return value

def api(route,value=None):
    request=urllib.request.Request('http://127.0.0.1:18087/api/'+route,data=None if value is None else json.dumps(value).encode(),headers={'Content-Type':'application/json'},method='GET' if value is None else 'PATCH')
    with urllib.request.urlopen(request,timeout=15) as response:return json.load(response)
def configuration():
    return {str(p):digest(p) for p in [BOT/'maibot/config/model_config.toml',BOT/'maibot/config/bot_config.toml',NATIVE/'limits/policy.json',BOT/'bridge/groups.json']}
def active():
    with sqlite3.connect('file:'+str(BOT/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
        now=time.time()
        return db.execute('SELECT COUNT(*) FROM turns WHERE status="active" AND expires>?',(now,)).fetchone()[0]+db.execute('SELECT COUNT(*) FROM attempts a JOIN turns t ON a.turn_id=t.id WHERE a.state="reserved" AND (t.expires>? OR a.ts>?)',(now,now-180)).fetchone()[0]
def pause():
    if STATE.exists():raise RuntimeError('Resume or roll back the existing maintenance first')
    status=api('status')
    if status.get('queue_depth') or status.get('image_queue_depth'):raise RuntimeError('Outgoing queue is busy')
    timer=subprocess.run(['systemctl','is-active','--quiet','maibot-availability.timer']).returncode==0
    saved={'control':json.loads(CONTROL.read_text()),'mode':status['mode'],'timer':timer,'configuration':configuration(),'started':time.time()}
    save(STATE,saved)
    save(CONTROL,{**saved['control'],'enabled':False})
    deadline=time.time()+480
    while active():
        if time.time()>deadline:
            save(CONTROL,saved['control']);STATE.unlink();raise RuntimeError('In-flight work did not finish; no runtime changed')
        time.sleep(3)
    save(CONTROL,{**saved['control'],'enabled':False,'send_enabled':False})
    api('control',{'mode':'paused'})
    if timer:run(['systemctl','stop','maibot-availability.timer'])
    return saved

def resume(mode=None):
    saved=json.loads(STATE.read_text())
    api('control',{'mode':mode or saved['mode']})
    deadline=time.time()+90
    while time.time()<deadline:
        status=api('status')
        if status.get('wechat_connected') and not status.get('ui_input_blocked'):break
        time.sleep(3)
    else:raise RuntimeError('WeChat needs login or UI recovery; sending remains paused')
    if saved['configuration']!=configuration():raise RuntimeError('Native configuration changed during maintenance')
    save(CONTROL,saved['control'])
    if saved['timer']:run(['systemctl','start','maibot-availability.timer'])
    STATE.unlink()
    print(json.dumps({'maintenance_restored':True,'mode':status['mode']}),flush=True)

def prepare(image,bootstrap):
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',image) and re.fullmatch(r'sha256:[a-f0-9]{64}',bootstrap)
    for path in [PERSIST,*[PERSIST/n for n in ['config','secrets','client','data','key-import','backups']]]:
        path.mkdir(mode=0o700,parents=True,exist_ok=True);path.chmod(0o700);os.chown(path,1000,1000)
    accounts=list((BOT/'wechat/xwechat_files').glob('*/db_storage/message/message_0.db'))
    if len(accounts)!=1:raise RuntimeError('Select exactly one verified account')
    account=accounts[0].parents[2].name
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',account):raise RuntimeError('Invalid account')
    groups=json.loads((BOT/'bridge/groups.json').read_text())
    if not 1<=len(groups)<=10:raise RuntimeError('Invalid explicit group scope')
    config={'account':account,'groups':[{'name':name,'chat_id':value['chat_id']} for name,value in groups.items()]}
    path=PERSIST/'config/reader.json'
    if path.exists() and json.loads(path.read_text())!=config:raise RuntimeError('Existing reader configuration differs')
    save(path,config);os.chown(path,1000,1000)
    env={'CHATLOG_READER_IMAGE':image,'CHATLOG_BOOTSTRAP_IMAGE':bootstrap,'READER_PERSIST':str(PERSIST),'READER_ACCOUNT':account,'WECHAT_ACCOUNT_DATABASES':str(accounts[0].parents[1])}
    atomic(ROOT/'.env',('\n'.join(k+'='+v for k,v in env.items())+'\n').encode())
    reader('config','--quiet');reader('--profile','ops','run','--rm','credentials','init')
    print(json.dumps({'prepared':True,'scoped_group_count':len(groups),'key_present':(PERSIST/'secrets/wechat-key.enc').exists()}))

@contextmanager
def bootstrap_tools(desktop):
    # Stage only public files from the locked Docker image. Running the
    # one-shot observer inside the existing WeChat container reuses its real
    # desktop sockets without exposing the desktop to another container.
    tag=uuid.uuid4().hex
    prefix='/opt/groupdesk-chatlog-bootstrap-'+tag
    imports=BOT/'wechat/bowxt'/('reader-key-'+tag)
    inside='/config/bowxt/'+imports.name
    artifacts='chatlog-reader-bootstrap-artifacts'
    compose=['docker','compose','--env-file',ROOT/'.env','-f',CODE/'compose.bootstrap.yaml','--profile','bootstrap']
    if subprocess.run(['docker','inspect',artifacts],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise RuntimeError('Bootstrap artifact staging already exists')
    imports.mkdir(mode=0o700);os.chown(imports,1000,1000)
    try:
        run(compose+['create','bootstrap-artifacts'])
        run(['docker','exec','wechat-bot','mkdir','-p',prefix+'/bin'])
        for source in ['/opt/validation-deps','/opt/chatlog-keeper','/opt/reader-python','/app/chatlog_reader']:
            producer=subprocess.Popen(['docker','cp',artifacts+':'+source,'-'],stdout=subprocess.PIPE)
            try:run(['docker','cp','-','wechat-bot:'+prefix+'/'],stdin=producer.stdout)
            finally:
                producer.stdout.close()
                if producer.wait()!=0:raise RuntimeError('Public bootstrap staging failed')
        run(['docker','cp',PERSIST/'secrets/vault-public.pem','wechat-bot:'+prefix+'/vault-public.pem'])
        wrapper=("#!/bin/sh\nexport LD_LIBRARY_PATH="+prefix+"/validation-deps/usr/lib/x86_64-linux-gnu\nexec "+prefix+"/validation-deps/usr/bin/gdb --data-directory="+prefix+"/validation-deps/usr/share/gdb -iex 'unset environment LD_LIBRARY_PATH' \"$@\"\n")
        writer="import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o755)"
        run(['docker','exec','-i','wechat-bot','/usr/bin/python3','-c',writer,prefix+'/bin/gdb'],input=wrapper.encode())
        run(['docker','exec','wechat-bot','chown','1000:1000',prefix+'/vault-public.pem'])
        env={**desktop,'HOME':'/config','PYTHONDONTWRITEBYTECODE':'1','PYTHONUNBUFFERED':'1',
            'PYTHONPATH':':'.join([prefix,prefix+'/chatlog-keeper',prefix+'/reader-python',prefix+'/validation-deps/usr/lib/python3/dist-packages']),
            'PATH':prefix+'/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'READER_ACCOUNT':json.loads((PERSIST/'config/reader.json').read_text())['account'],
            'READER_BOOTSTRAP_PUBLIC_PATH':prefix+'/vault-public.pem','READER_BOOTSTRAP_IMPORT_PATH':inside+'/encrypted-key.json'}
        command=['docker','exec','--user','abc']
        for key,value in env.items():command+=['--env',key+'='+value]
        command+=['wechat-bot']
        probe="import hashlib,pathlib,subprocess;from Crypto.Cipher import AES;from chatlog_keeper import linux_key;assert hashlib.sha256(pathlib.Path('/opt/wechat/wechat').read_bytes()).hexdigest()=='2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959';r=subprocess.run(['gdb','--batch','-ex','run','--args','/bin/true'],capture_output=True,text=True,check=True);assert 'exited normally' in r.stdout;print('bootstrap_tools_verified_inside_wechat_docker')"
        run(command+['/usr/bin/python3','-c',probe],timeout=45)
        yield command,imports/'encrypted-key.json'
    finally:
        run(['docker','exec','wechat-bot','rm','-rf',prefix])
        subprocess.run(['docker','rm','-f',artifacts],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(imports)

def capture():
    container=json.loads(output(['docker','inspect','wechat-bot']))[0]
    container_id=container['Id']
    mains=[]
    for cmd in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            if os.readlink(cmd.with_name('exe'))=='/opt/wechat/wechat' and container_id in cmd.with_name('cgroup').read_text():mains.append(cmd)
        except OSError:continue
    if len(mains)!=1:raise RuntimeError('Expected one current WeChat main process')
    main=mains[0]
    environment=dict(part.split(b'=',1) for part in main.with_name('environ').read_bytes().split(b'\0') if b'=' in part)
    allowed=['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XAUTHORITY','LC_ALL','LANG','QT_LINUX_ACCESSIBILITY_ALWAYS_ON','NO_AT_BRIDGE']
    desktop={k:environment[k.encode()].decode() for k in allowed if k.encode() in environment}
    argv=[v.decode() for v in main.read_bytes().split(b'\0') if v];argv[0]='/opt/wechat/wechat'
    with bootstrap_tools(desktop) as (command,encrypted):
        saved=pause();saved.update(desktop=desktop,argv=argv);save(STATE,saved)
        stopped=False
        try:
            namespace_pid=next(line.split()[-1] for line in main.with_name('status').read_text().splitlines() if line.startswith('NSpid:'))
            run(['docker','exec','--user','abc','wechat-bot','kill','-TERM',namespace_pid]);stopped=True
            deadline=time.time()+30
            while main.exists() and time.time()<deadline:time.sleep(.5)
            if main.exists():raise RuntimeError('WeChat did not stop normally')
            run(command+['/usr/bin/python3','-m','chatlog_reader.bootstrap'],timeout=660)
            envelope=encrypted.read_bytes()
            if len(envelope)>2048:raise RuntimeError('Invalid encrypted key envelope')
            target=PERSIST/'key-import/encrypted-key.json';atomic(target,envelope);os.chown(target,1000,1000)
            reader('--profile','ops','run','--rm','credentials','import-key')
        finally:
            if stopped:start_wechat()
            resume()
    reader('up','-d','reader')

def start_wechat():
    saved=json.loads(STATE.read_text())
    script='''import json,os,subprocess,sys\nv=json.load(sys.stdin);e=dict(os.environ);e.update(v["desktop"]);e["LC_ALL"]="zh_CN.UTF-8";subprocess.Popen(v["argv"],env=e,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)'''
    run(['docker','exec','-i','--user','abc','wechat-bot','/usr/bin/python3','-c',script],input=json.dumps({'desktop':saved['desktop'],'argv':saved['argv']}).encode())

def cutover(sender_image):
    assert re.fullmatch(r"sha256:[a-f0-9]{64}",sender_image)
    reader('up','-d','--wait','--wait-timeout','90','reader')
    saved=pause()
    backup=PERSIST/'backups'/time.strftime('%Y%m%d-%H%M%S');backup.mkdir(mode=0o700)
    files=['bridge/app.py','wechat-adapter/launch-bowxt.py','limits/summary_runtime.py','limits/chatlog_runtime.py','availability/monitor.py','.build/wechat-adapter/bowxt/src/bowxt/service.py','.build/wechat-adapter/bowxt/tests/test_send_only.py','compose.chatlog-reader.yaml','.env','build-wechat-adapter.sh']
    before={}
    for name in files:
        source=NATIVE/name
        if source.exists():
            dest=backup/name;dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copy2(source,dest);before[name]=digest(dest)
        else:before[name]=None
    save(backup/'manifest.json',before)
    atomic(backup/'maintenance.json',STATE.read_bytes())
    atomic(backup/'runtime.json',(BOT/'wechat/bowxt/runtime.json').read_bytes())
    for name in ['limits/limits.sqlite3','bridge/delivery.sqlite3']:
        source=BOT/name
        with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as db,sqlite3.connect(backup/(name.replace('/','-'))) as dest:
            db.backup(dest)
            if dest.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Ledger backup validation failed')
    save(backup/'SHA256SUMS.json',{str(p.relative_to(backup)):digest(p) for p in backup.rglob('*') if p.is_file()})
    try:
        run(native()+['stop','wechat-bridge'],cwd=NATIVE)
        run(['python3',CODE/'native-patch.py','--root',NATIVE])
        shutil.copy2(CODE/'compose.bridge.yaml',NATIVE/'compose.chatlog-reader.yaml')
        env=(NATIVE/'.env').read_text()
        if len(re.findall(r'^WECHAT_IMAGE=.*$',env,re.M))!=1:raise RuntimeError('Expected one WeChat image setting')
        atomic(NATIVE/'.env',re.sub(r'^WECHAT_IMAGE=.*$','WECHAT_IMAGE='+sender_image,env,flags=re.M).encode())
        script=NATIVE/'build-wechat-adapter.sh';text=script.read_text()
        hook='python3 '+str(CODE/'native-patch.py')+' --root '+str(NATIVE)+' --bowxt-only\n'
        marker='docker run --rm --name maibot-bowxt-deps'
        if marker not in text:raise RuntimeError('Unknown adapter build script')
        if hook not in text:atomic(script,text.replace(marker,hook+marker,1).encode(),0o755)
        runtime=BOT/'wechat/bowxt/runtime.json';value=json.loads(runtime.read_text());value['mode']='send_only';save(runtime,value);os.chown(runtime,1000,1000)
        run(['docker','cp',NATIVE/'wechat-adapter/launch-bowxt.py','wechat-bot:/opt/bowxt-launcher.py'])
        run(['docker','cp',NATIVE/'.build/wechat-adapter/bowxt/src/bowxt/service.py','wechat-bot:/opt/bowxt/src/bowxt/service.py'])
        run(['docker','exec','wechat-bot','s6-svc','-r','/run/service/custom-svc-bowxt'])
        for _ in range(30):
            try:
                api('control',{'mode':'send_only'});break
            except (OSError,ValueError):time.sleep(2)
        else:raise RuntimeError('Send adapter restart failed')
        # Prepare current watermarks before the bridge can consume anything.
        run(native(True)+['run','--rm','--no-deps','wechat-bridge','-m','chatlog_runtime','prepare'],cwd=NATIVE)
        run(native(True)+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','150','wechat-bridge'],cwd=NATIVE)
        health=json.loads((BOT/'bridge/health.json').read_text())
        if health.get('data_source')!='chatlog-keeper':raise RuntimeError('Bridge source not switched')
        resume('send_only')
        save(PERSIST/'active-release.json',{'code':str(CODE),'backup':str(backup),'switched_at':time.time(),'reader_source':True})
        print(json.dumps({'cutover':True,'backup':str(backup)}),flush=True)
    except BaseException:
        rollback(backup)
        raise

def rollback(backup):
    manifest=json.loads((backup/'manifest.json').read_text())
    if not STATE.exists():
        saved=pause();saved['mode']=json.loads((backup/'maintenance.json').read_text())['mode'];save(STATE,saved)
    run(native()+['stop','wechat-bridge'],cwd=NATIVE)
    for name,expected in manifest.items():
        path=NATIVE/name
        if expected is None:path.unlink(missing_ok=True)
        else:
            source=backup/name
            if digest(source)!=expected:raise RuntimeError('Backup checksum mismatch')
            atomic(path,source.read_bytes(),0o600 if name=='.env' else 0o755 if name.endswith('.sh') else 0o644)
    atomic(BOT/'wechat/bowxt/runtime.json',(backup/'runtime.json').read_bytes());os.chown(BOT/'wechat/bowxt/runtime.json',1000,1000)
    run(['docker','cp',NATIVE/'wechat-adapter/launch-bowxt.py','wechat-bot:/opt/bowxt-launcher.py'])
    run(['docker','cp',NATIVE/'.build/wechat-adapter/bowxt/src/bowxt/service.py','wechat-bot:/opt/bowxt/src/bowxt/service.py'])
    run(['docker','exec','wechat-bot','s6-svc','-r','/run/service/custom-svc-bowxt'])
    run(native()+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','150','wechat-bridge'],cwd=NATIVE)
    resume()

if __name__=='__main__':
    os.umask(0o077)
    if os.geteuid()!=0:raise SystemExit('Run on rococo-root2 as root')
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','capture','resume','cutover','rollback']);p.add_argument('--image');p.add_argument('--bootstrap');p.add_argument('--sender-image');p.add_argument('--backup',type=Path);args=p.parse_args()
    if args.action=='prepare':prepare(args.image,args.bootstrap)
    elif args.action=='capture':capture()
    elif args.action=='resume':resume()
    elif args.action=='cutover':cutover(args.sender_image)
    elif args.action=='rollback':rollback(args.backup)
