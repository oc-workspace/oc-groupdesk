"""Operator-only Docker startup with fixed per-account paths and private inputs."""
import argparse,hashlib,json,re,subprocess
from pathlib import Path

def inside(path,root):
    return path.resolve().is_relative_to(root.resolve())

def verify_runtime(root,persist,meta):
    expected={'bridge/app.py','limits/bot_runtime.py','limits/chatlog_runtime.py','limits/groupdesk_runtime.py','limits/policy.py','limits/policy.json','bowxt/src/bowxt/__init__.py','patched/utils_model.py','patched/gemini_client.py','patched/send_service.py','patched/reasoning_engine.py','patched/reply.py'}
    code=root/'runtime';entries={}
    for line in (code/'SHA256SUMS').read_text().splitlines():
        digest,relative=line.split(None,1);relative=relative.lstrip('*')
        if not re.fullmatch('[a-f0-9]{64}',digest) or not inside(code/relative,code):raise ValueError('Invalid runtime manifest')
        if hashlib.sha256((code/relative).read_bytes()).hexdigest()!=digest:raise ValueError('Runtime file digest mismatch')
        entries[relative]=digest
    if not expected.issubset(entries):raise ValueError('Incomplete reviewed runtime bundle')
    for tree in ['bridge','limits','bowxt','patched']:
        for file in (code/tree).rglob('*'):
            if file.is_symlink():raise ValueError('Runtime symlinks are not allowed')
            if file.is_file() and '__pycache__' not in file.parts and file.suffix!='.pyc' and file.relative_to(code).as_posix() not in entries:raise ValueError('Unreviewed runtime file')
    connection=json.loads((persist/'groupdesk/connection.json').read_text())
    for key in ['bot_id','wechat_id','runtime_instance_id']:
        if connection.get(key)!=meta[key]:raise ValueError('Connection belongs to a different robot')
    if not isinstance(connection.get('token'),str) or len(connection['token'])<32:raise ValueError('Missing private GroupDesk token')
    reader=json.loads((persist/'reader/config/reader.json').read_text())
    account=reader.get('account','')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',account):raise ValueError('Select this account database')
    if connection.get('account_fingerprint')!=hashlib.sha256(account.encode()).hexdigest():raise ValueError('Reader and robot account bindings differ')
    groups=connection.get('groups',{});native=reader.get('groups',[])
    if not groups or set(groups)!={str(g['chat_id']) for g in native}:raise ValueError('Group scopes differ')
    env={}
    for line in (root/'.env').read_text().splitlines():
        if not line or line.startswith('#'):continue
        k,v=line.split('=',1)
        if k not in {'WECHAT_ACCOUNT_DATABASES','READER_ACCOUNT'}:raise ValueError('Unexpected source environment variable')
        env[k]=v
    databases=Path(env['WECHAT_ACCOUNT_DATABASES'])
    if env.get('READER_ACCOUNT')!=account or databases.name!='db_storage' or databases.parent.name!=account or not inside(databases,persist/'wechat') or not databases.is_dir():raise ValueError('Reader must mount only this robot’s own account database')
    for relative in ['secrets/maibot.env','secrets/bridge.env','reader/secrets/wechat-key.enc','reader/secrets/vault-private.pem','reader/client/api-token','maibot/config/bot_config.toml','maibot/config/model_config.toml','persona/base/SKILL.md','bridge/control.json']:
        path=persist/relative
        if not path.is_file() or path.stat().st_size==0 or not inside(path,persist):raise ValueError('Incomplete independent private configuration')

def main():
    p=argparse.ArgumentParser();p.add_argument('deployment',type=Path);p.add_argument('--desktop-only',action='store_true');a=p.parse_args()
    root=a.deployment.resolve();meta=json.loads((root/'deployment.json').read_text());persist=Path(meta['persist'])
    if str(root)!=meta['deployment'] or root!=Path('/opt/docker/oc-projects/groupdesk-bots')/meta['bot_id'].replace('-','') or persist!=Path('/opt/persist/groupdesk-bots')/meta['bot_id'].replace('-',''):raise ValueError('Unexpected deployment directory')
    if a.desktop_only:
        if not (persist/'secrets/desktop.env').is_file():raise ValueError('Create this account’s private desktop credentials first')
        command=['docker','compose','-f',str(root/'compose.desktop.json'),'up','-d','wechat']
    else:
        verify_runtime(root,persist,meta)
        command=['docker','compose','--env-file',str(root/'.env'),'-f',str(root/'compose.json'),'--profile','runtime','up','-d']
    subprocess.run(command,cwd=root,check=True)
if __name__=='__main__':main()
