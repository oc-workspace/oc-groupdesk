"""Release the tested SDK files; restart bowxt only, never WeChat.

Run from a reviewed production release, after building its labelled image.
The image is used on the next normal container recreation. The current
container receives the identical files using the established s6 hot rollout.
"""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,time

parser=argparse.ArgumentParser()
parser.add_argument('--stage',type=Path,required=True)
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--release',required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
assert re.fullmatch('[a-f0-9]{40}',args.release)
os.umask(0o077)
root=Path('/opt/docker/oc-projects/maibot-wechat');persist=Path('/opt/persist/maibot-wechat')
sdk=root/'.build/wechat-adapter/bowxt';package=Path(__file__).resolve().parent
manifest=json.loads(args.manifest.read_text());names=list(manifest['candidate'])
assert manifest['sdk_tests']==158 and manifest['native_tests']==280
def run(command,**kwargs):return subprocess.run(command,check=True,**kwargs)
def output(command):return subprocess.check_output(command,text=True)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def container_hashes():
    lines=output(['docker','exec','wechat-bot','sha256sum',*['/opt/bowxt/src/bowxt/'+n for n in names if n in manifest['baseline']]])
    return {Path(line.split()[1]).name:line.split()[0] for line in lines.splitlines()}
for name,value in manifest['baseline'].items():assert digest(sdk/'src/bowxt'/name)==value,'Host SDK baseline changed'
assert container_hashes()==manifest['baseline'],'Container SDK baseline changed'
if 'frame_identity.py' not in manifest['baseline']:
    assert not (sdk/'src/bowxt/frame_identity.py').exists(),'Unexpected module'
for name,value in manifest['candidate'].items():assert digest(args.stage/'src/bowxt'/name)==value,'Untested SDK source'
assert digest(root/'build-wechat-adapter.sh')==manifest['build_script_sha'],'Build script changed'
image='wechat-bot:frame-identities-'+args.release[:12]
assert json.loads(output(['docker','image','inspect',image]))[0]['Config']['Labels']['org.rococo.groupdesk.revision']==args.release,'Wrong release image'
image_files=output(['docker','run','--rm','--network=none','--entrypoint','sha256sum',image,*['/opt/bowxt/src/bowxt/'+n for n in names]])
assert {Path(x.split()[1]).name:x.split()[0] for x in image_files.splitlines()}==manifest['candidate'],'Release image source differs from tests'
def wechat_state():return json.loads(output(['docker','inspect','-f','{{json .State}}','wechat-bot']))
def wechat_pids():
    code="from pathlib import Path;import json;print(json.dumps({p.name:(p/'stat').read_text().split()[21] for p in Path('/proc').iterdir() if p.name.isdigit() and (p/'comm').exists() and (p/'comm').read_text().strip()=='wechat'}))"
    return json.loads(output(['docker','exec','wechat-bot','python3','-c',code]))
def status():
    code="import json,urllib.request;r=json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:8787/api/status',timeout=3));print(json.dumps({k:r.get(k) for k in ['wechat_connected','running','active_chat','queue_depth','sender_queue_depth']}))"
    return json.loads(output(['docker','exec','wechat-bot','python3','-c',code]))
started=wechat_state()['StartedAt'];pids=wechat_pids();assert pids and status()['wechat_connected']
if args.check:print(json.dumps({'preflight':'ok','release':args.release,'image':image,'sdk_files':manifest['candidate'],'wechat_started_at':started}));raise SystemExit(0)
backup=root/'install-artifacts'/('frame-identity-'+datetime.now(ZoneInfo('Asia/Singapore')).strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700,parents=True)
shutil.copytree(package,backup/'package',ignore=shutil.ignore_patterns('__pycache__'))
shutil.copy2(args.manifest,backup/'validation.json')
for name in manifest['baseline']:
    dest=backup/'before'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(sdk/'src/bowxt'/name,dest)
for name in ['.env','build-wechat-adapter.sh']:shutil.copy2(root/name,backup/'before'/name)
if (sdk/'tests/test_frame_identity.py').exists():shutil.copy2(sdk/'tests/test_frame_identity.py',backup/'before/test_frame_identity.py')
control=persist/'bridge/control.json';original_control=control.read_bytes()
maintenance=(json.dumps({**json.loads(original_control),'enabled':False})+'\n').encode()
(backup/'control.json').write_bytes(original_control)
def atomic(path,data,mode=0o644):
    temp=path.with_name(path.name+'.frame-release-tmp');temp.write_bytes(data);temp.chmod(mode);temp.replace(path)
def restore_control():
    if control.read_bytes()==maintenance:atomic(control,original_control,0o600);return True
    return False
def supervise(action):run(['docker','exec','wechat-bot','s6-svc',action,'/run/service/custom-svc-bowxt'],stdout=subprocess.DEVNULL)
def wait_down():
    end=time.monotonic()+20
    while time.monotonic()<end:
        if output(['docker','exec','wechat-bot','s6-svstat','/run/service/custom-svc-bowxt']).startswith('down'):return
        time.sleep(.2)
    raise RuntimeError('SDK did not stop')
def wait_ready():
    end=time.monotonic()+40
    while time.monotonic()<end:
        try:
            if status()['wechat_connected']:return
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError('SDK did not reconnect')
def copy_runtime(name,path):run(['docker','cp',str(path),'wechat-bot:/opt/bowxt/src/bowxt/'+name],stdout=subprocess.DEVNULL)
down=False;changed=False
atomic(control,maintenance,0o600)
print('Ingress paused briefly; waiting for idle requests and SDK.',flush=True)
try:
    time.sleep(5)
    with sqlite3.connect('file:'+str(persist/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
        now=time.time()
        assert db.execute('SELECT count(*) FROM turns WHERE status="active" AND expires>?',(now,)).fetchone()[0]==0,'Active model request; retry after completion'
        assert db.execute('SELECT count(*) FROM attempts WHERE state="reserved" AND ts>?',(now-180,)).fetchone()[0]==0,'Active send; retry after completion'
    deadline=time.monotonic()+20
    while True:
        state=status()
        if state['active_chat'] is None and not state.get('queue_depth') and not state.get('sender_queue_depth'):break
        if time.monotonic()>deadline:raise RuntimeError('SDK remains busy; no update made')
        time.sleep(.3)
    supervise('-d');down=True;wait_down()
    for path in [persist/'wechat/bowxt/messages.db',persist/'bridge/delivery.sqlite3',persist/'limits/limits.sqlite3']:
        with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as source,sqlite3.connect(backup/(path.parent.name+'-'+path.name)) as target:source.backup(target)
    changed=True
    for name in names:
        path=args.stage/'src/bowxt'/name;atomic(sdk/'src/bowxt'/name,path.read_bytes());copy_runtime(name,path)
    shutil.copy2(package/'test_frame_identity.py',sdk/'tests/test_frame_identity.py')
    build=(root/'build-wechat-adapter.sh').read_text();anchor='python3 wechat-adapter/patch-responsiveness.py "$context/bowxt"'
    build=''.join(line for line in build.splitlines(keepends=True) if not ('/package/install-frame-identity.py' in line or '/package/test_frame_identity.py' in line))
    assert build.count(anchor)==1,'Unknown SDK build hook'
    hook=f'\npython3 "{backup}/package/install-frame-identity.py" "$context/bowxt" "{backup}/package/baseline.json"\ncp "{backup}/package/test_frame_identity.py" "$context/bowxt/tests/"'
    atomic(root/'build-wechat-adapter.sh',build.replace(anchor,anchor+hook,1).encode(),0o755)
    env=(root/'.env').read_text();assert len(re.findall(r'^WECHAT_IMAGE=.*$',env,re.M))==1
    atomic(root/'.env',re.sub(r'^WECHAT_IMAGE=.*$','WECHAT_IMAGE='+image,env,flags=re.M).encode(),0o600)
    run(['docker','compose','--profile','bridge','config','--quiet'],cwd=root,stdout=subprocess.DEVNULL)
    supervise('-u');down=False;wait_ready()
    assert wechat_state()['StartedAt']==started,'Unexpected WeChat container restart'
    after=wechat_pids();assert all(after.get(pid)==value for pid,value in pids.items()),'Unexpected WeChat process restart'
    expected=manifest['candidate'];actual=output(['docker','exec','wechat-bot','sha256sum',*['/opt/bowxt/src/bowxt/'+n for n in names]])
    assert {Path(x.split()[1]).name:x.split()[0] for x in actual.splitlines()}==expected
    restored=restore_control()
    result={'release':args.release,'image_for_recreation':image,'backup':str(backup),'sdk_files':expected,'wechat_started_at':started,'wechat_processes_unchanged':True,'control_restored':restored}
    (backup/'result.json').write_text(json.dumps(result,indent=2)+'\n');atomic(persist/'bowxt-release.json',json.dumps(result,indent=2).encode(),0o600)
    print(json.dumps(result),flush=True)
except BaseException:
    if changed:
        supervise('-d');down=True;wait_down()
        for name in manifest['baseline']:
            path=backup/'before'/name;atomic(sdk/'src/bowxt'/name,path.read_bytes());copy_runtime(name,path)
        for name in set(names)-set(manifest['baseline']):
            (sdk/'src/bowxt'/name).unlink(missing_ok=True)
            run(['docker','exec','wechat-bot','rm','-f','/opt/bowxt/src/bowxt/'+name],stdout=subprocess.DEVNULL)
        if (backup/'before/test_frame_identity.py').exists():shutil.copy2(backup/'before/test_frame_identity.py',sdk/'tests/test_frame_identity.py')
        else:(sdk/'tests/test_frame_identity.py').unlink(missing_ok=True)
        for name in ['.env','build-wechat-adapter.sh']:shutil.copy2(backup/'before'/name,root/name)
    if down:supervise('-u');wait_ready()
    restore_control();raise
