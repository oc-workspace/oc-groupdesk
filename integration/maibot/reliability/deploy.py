"""Deploy the reviewed reliability files while preserving the WeChat process."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time

from install import install

parser=argparse.ArgumentParser()
parser.add_argument('--bot',required=True)
parser.add_argument('--release',required=True)
parser.add_argument('--baseline',type=Path,required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
if not re.fullmatch('[a-f0-9]{32}',args.bot) or not re.fullmatch('[a-f0-9]{40}',args.release):
    raise ValueError('Invalid bot/release')
stack=Path('/opt/docker/oc-projects/groupdesk-bots')/args.bot
persist=Path('/opt/persist/groupdesk-bots')/args.bot
runtime=stack/'runtime'
names=['limits/policy.py','limits/group_guard.py','bridge/app.py','patched/reasoning_engine.py']
baseline=json.loads(args.baseline.read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
for name in names:
    if sha(runtime/name)!=baseline[name]:
        raise RuntimeError('Runtime changed after review: '+name)
with tempfile.TemporaryDirectory(prefix='gd-reliability-') as directory:
    candidate=Path(directory)
    for name in names:
        target=candidate/name
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(runtime/name,target)
    install(candidate)
    install(candidate)
    files=names+['limits/chat_reliability.py']
    result={name:sha(candidate/name) for name in files}
    print(json.dumps({'preflight':'ok','release':args.release,'candidate':result}),flush=True)
    if args.check:raise SystemExit()
    bridge='gdbot-'+args.bot+'-wechat-bridge-1'
    maibot='gdbot-'+args.bot+'-maibot-1'
    wechat='gdbot-'+args.bot+'-wechat-1'
    def command(*items):
        return subprocess.check_output(items,text=True).strip()
    def started(container):
        return command('docker','inspect','-f','{{.State.StartedAt}}',container)
    desktop_started=started(wechat)
    wechat_pid=command('docker','exec',wechat,'pgrep','-xo','wechat')
    control=persist/'bridge/control.json'
    original=control.read_bytes()
    value=json.loads(original)
    if not value.get('enabled') or not value.get('send_enabled'):
        raise RuntimeError('Robot already paused; inspect owner state first')
    paused=(json.dumps({**value,'enabled':False})+'\n').encode()
    backup=persist/'backups'/('chat-reliability-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700,parents=True)
    (backup/'control.json').write_bytes(original)
    for name in files+['SHA256SUMS']:
        source=runtime/name
        if source.exists():
            target=backup/name
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,target)
    def write_control(data):
        temp=control.with_suffix('.reliability-tmp')
        temp.write_bytes(data);temp.chmod(0o600);temp.replace(control)
    def restore_control():
        if control.read_bytes()==paused:
            write_control(original)
            return True
        return False
    stopped=False
    changed=False
    write_control(paused)
    try:
        for attempt in range(60):
            if control.read_bytes()!=paused:
                raise RuntimeError('Control settings changed during preparation')
            now=time.time()
            with sqlite3.connect('file:'+str(persist/'limits/limits.sqlite3')+'?mode=ro',uri=True) as db:
                active=db.execute("SELECT 1 FROM turns WHERE status='active' AND expires>?",(now,)).fetchone()
                inflight=db.execute("SELECT 1 FROM attempts WHERE state='reserved' AND ts>?",(now-330,)).fetchone()
            if not active and not inflight:break
            time.sleep(1)
        else:raise RuntimeError('In-flight task still running')
        subprocess.run(['docker','stop','--time','15',bridge,maibot],check=True,stdout=subprocess.DEVNULL)
        stopped=True
        for relative in ('limits/limits.sqlite3','bridge/delivery.sqlite3'):
            source=persist/relative
            target=backup/(relative.replace('/','-'))
            with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as src,sqlite3.connect(target) as dest:
                src.backup(dest)
        changed=True
        for name in files:
            # reasoning_engine.py is a single-file Docker bind mount.
            # Keep its inode so the existing stopped container sees the write.
            with (runtime/name).open('wb') as target:
                target.write((candidate/name).read_bytes())
        manifest=runtime/'SHA256SUMS'
        remaining=set(files)
        lines=[]
        for line in manifest.read_text().splitlines():
            _,_,path=line.partition('  ')
            key=path.removeprefix('./')
            if key in remaining:
                line=sha(runtime/key)+'  '+path
                remaining.remove(key)
            lines.append(line)
        for name in sorted(remaining):lines.append(sha(runtime/name)+'  ./'+name)
        manifest.write_text('\n'.join(lines)+'\n')
        boot=time.time()
        subprocess.run(['docker','start',maibot,bridge],check=True,stdout=subprocess.DEVNULL)
        for attempt in range(60):
            health=json.loads((persist/'bridge/health.json').read_text())
            if health.get('updated_at',0)>boot and time.time()-health.get('updated_at',0)<8 and health.get('connected'):
                break
            time.sleep(1)
        else:raise RuntimeError('Bridge health did not recover')
        if started(wechat)!=desktop_started or command('docker','exec',wechat,'pgrep','-xo','wechat')!=wechat_pid:
            raise RuntimeError('Unexpected WeChat process change')
        restored=restore_control()
        if not restored:raise RuntimeError('Owner controls changed; inspect before resuming')
        record={'release':args.release,'installed':result,'wechat_started_at':desktop_started,
            'wechat_pid':wechat_pid,'control_restored':restored,'backup':str(backup)}
        (backup/'result.json').write_text(json.dumps(record,indent=2)+'\n')
        print(json.dumps(record),flush=True)
    except BaseException:
        if changed:
            subprocess.run(['docker','stop','--time','10',bridge,maibot],check=False,stdout=subprocess.DEVNULL)
            for name in files+['SHA256SUMS']:
                old=backup/name
                if old.exists():
                    with (runtime/name).open('wb') as target:target.write(old.read_bytes())
                elif (runtime/name).exists():(runtime/name).unlink()
        if stopped:subprocess.run(['docker','start',maibot,bridge],check=False,stdout=subprocess.DEVNULL)
        restore_control()
        raise
