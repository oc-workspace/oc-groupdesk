"""Controlled upgrade of RyuBuddy's existing bridge; never restarts WeChat.

Run as the host operator using the merged release directory. Stops new intake,
drains already admitted turns, backs up code/private binding and SQLite evidence,
then changes only the reviewed lifecycle hook and Reader client. No ledger restore.
"""
import argparse,hashlib,json,os,shutil,sqlite3,subprocess,time,uuid
from pathlib import Path
BASE=Path('/opt/docker/oc-projects/maibot-wechat');PERSIST=Path('/opt/persist/maibot-wechat')
BRIDGE_SHA='ca0a77a111342347ceacd78455e04900dde4f711b7606648aeba273c17a13c24'
CLIENT_SHA='a99b63fd412ba8a6e49fb6b59c8a6ef67a99a381ae13f621e8461919918956da'
BOT='00000000-0000-4000-8000-000000000001'

def atomic(path,data):
    stat=path.stat() if path.exists() else None;temp=path.with_name(path.name+'.multibot-tmp');temp.write_bytes(data)
    temp.chmod(stat.st_mode&0o777 if stat else 0o600)
    if stat:os.chown(temp,stat.st_uid,stat.st_gid)
    temp.replace(path)

def sender_status():
    code="import json;from bowxt import AgentClient;s=AgentClient('maibot-gt',base_url='http://wechat:8787').status();print(json.dumps({k:s.get(k) for k in ['queue_depth','wechat_connected']}))"
    return json.loads(subprocess.check_output(['docker','exec','maibot-wechat-bridge','/MaiMBot/.venv/bin/python','-c',code],text=True))

def active():
    with sqlite3.connect('file:'+str(PERSIST/'limits/limits.sqlite3')+'?mode=ro',uri=True) as c:
        return c.execute('SELECT count(*) FROM turns WHERE status="active" AND expires>?',(time.time(),)).fetchone()[0]

def main():
    p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('--apply',action='store_true');a=p.parse_args()
    if not a.apply:raise ValueError('Explicit --apply required')
    bridge=BASE/'bridge/app.py';client=BASE/'limits/chatlog_runtime.py';module=BASE/'limits/bot_runtime.py'
    if hashlib.sha256(bridge.read_bytes()).hexdigest()!=BRIDGE_SHA or hashlib.sha256(client.read_bytes()).hexdigest()!=CLIENT_SHA:raise ValueError('Unknown native baseline; review before upgrade')
    source=a.release/'integration/maibot';sources=[source/'chatlog_runtime.py',source/'bots/bot_runtime.py',source/'bots/install.py']
    for file in sources:compile(file.read_text(),str(file),'exec')
    control=PERSIST/'bridge/control.json';original=control.read_bytes();paused=json.loads(original);paused['enabled']=False
    held=(json.dumps(paused)+'\n').encode();backup=Path('/opt/docker/backups/maibot-multibot')/time.strftime('%Y%m%d-%H%M%S');backup.mkdir(parents=True,mode=0o700)
    connection=PERSIST/'groupdesk/connection.json';stopped=False;changed=False
    dc=['docker','compose','-f',str(BASE/'compose.yaml'),'-f',str(BASE/'compose.chatlog-reader.yaml'),'--profile','bridge']
    try:
        atomic(control,held)
        deadline=time.monotonic()+180
        while True:
            status=sender_status()
            if type(status.get('queue_depth')) is not int:raise RuntimeError('No sender queue status')
            if not active() and status['queue_depth']==0:break
            if time.monotonic()>deadline:raise RuntimeError('Admitted work still running; no upgrade applied')
            time.sleep(2)
        if control.read_bytes()!=held:raise RuntimeError('Local controls changed; no upgrade applied')
        paused['send_enabled']=False;held=(json.dumps(paused)+'\n').encode();atomic(control,held)
        time.sleep(2)
        if active() or sender_status()['queue_depth']!=0:raise RuntimeError('Work started during drain; no upgrade applied')
        subprocess.run(dc+['stop','wechat-bridge'],cwd=BASE,check=True);stopped=True
        for path,name in [(bridge,'bridge.py'),(client,'chatlog_runtime.py'),(connection,'connection.json')]:shutil.copy2(path,backup/name)
        (backup/'control.json').write_bytes(original);(backup/'control.json').chmod(0o600)
        for path,name in [(PERSIST/'bridge/delivery.sqlite3','delivery.sqlite3'),(PERSIST/'limits/limits.sqlite3','limits.sqlite3')]:
            with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as src,sqlite3.connect(backup/name) as dst:
                src.backup(dst)
                if dst.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('SQLite backup verification failed')
        sums=[hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name for f in backup.iterdir() if f.is_file()];(backup/'SHA256SUMS').write_text('\n'.join(sums)+'\n')
        conf=json.loads(connection.read_text());reader=json.loads(Path('/opt/persist/chatlog-reader/config/reader.json').read_text())
        conf.update(bot_id=BOT,wechat_id='RyuBuddy',runtime_instance_id=conf.get('runtime_instance_id') or str(uuid.uuid4()),account_fingerprint=hashlib.sha256(reader['account'].encode()).hexdigest())
        changed=True;atomic(connection,(json.dumps(conf,ensure_ascii=False)+'\n').encode())
        atomic(module,sources[1].read_bytes());os.chmod(module,0o644)
        atomic(client,sources[0].read_bytes())
        subprocess.run(['python3',str(sources[2]),str(bridge),'--baseline',BRIDGE_SHA],check=True)
        if control.read_bytes()!=held:raise RuntimeError('Local controls changed during upgrade')
        atomic(control,original)
        subprocess.run(dc+['up','-d','--no-deps','wechat-bridge'],cwd=BASE,check=True);stopped=False
        print('Legacy bridge upgraded; existing account, source cursors and ledgers preserved. Private backup: '+str(backup))
    except Exception:
        if stopped and changed:
            # Restore code/config only. Runtime evidence is deliberately never rewound.
            for dst,name in [(bridge,'bridge.py'),(client,'chatlog_runtime.py'),(connection,'connection.json')]:atomic(dst,(backup/name).read_bytes())
        raise
    finally:
        if control.read_bytes()==held:atomic(control,original)
        if stopped:subprocess.run(dc+['up','-d','--no-deps','wechat-bridge'],cwd=BASE,check=True)
if __name__=='__main__':main()
