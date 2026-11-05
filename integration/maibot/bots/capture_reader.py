"""First-time key capture for one independent, not-yet-running bot stack.

The verified startup observer runs as the WeChat user inside its own desktop.
Only the public vault key enters that desktop; the database key is wrapped in
memory and authenticated against this account before encrypted persistence.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid


def run(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def output(args):
    return subprocess.check_output(list(map(str, args)), text=True)


def paths(bot):
    canonical = str(uuid.UUID(bot))
    if canonical != bot or bot == '00000000-0000-4000-8000-000000000001':
        raise ValueError('Independent canonical bot UUID required')
    slug = bot.replace('-', '')
    return (Path('/opt/docker/oc-projects/groupdesk-bots') / slug,
            Path('/opt/persist/groupdesk-bots') / slug, 'gdbot-' + slug)


def selection(bot):
    root, persist, project = paths(bot)
    meta = json.loads((root / 'deployment.json').read_text())
    if root.resolve() != root or persist.resolve() != persist or meta['bot_id'] != bot or meta['deployment'] != str(root) or meta['persist'] != str(persist):
        raise ValueError('Independent deployment identity mismatch')
    connection = json.loads((persist / 'groupdesk/connection.json').read_text())
    settings = json.loads((persist / 'reader/config/reader.json').read_text())
    account = settings['account']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', account):
        raise ValueError('Invalid account directory')
    database = persist / 'wechat/xwechat_files' / account / 'db_storage'
    if not database.is_dir() or not database.resolve().is_relative_to((persist / 'wechat').resolve()):
        raise ValueError('Account database must belong to this bot')
    if connection['bot_id'] != bot or connection['wechat_id'] != meta['wechat_id'] or connection['runtime_instance_id'] != meta['runtime_instance_id'] or connection['account_fingerprint'] != hashlib.sha256(account.encode()).hexdigest():
        raise ValueError('Account bindings differ')
    if {str(g['chat_id']) for g in settings['groups']} != set(connection['groups']):
        raise ValueError('Reader and connection group scope differs')
    compose = json.loads((root / 'compose.json').read_text())
    image = compose['services']['reader']['image']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Verified local reader image required')
    for service in ['maibot', 'wechat-bridge']:
        rows=json.loads(output(['docker','ps','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service,'--format','json']) or 'null')
        if rows:
            raise ValueError('First-time capture requires runtime containers stopped')
    return root, persist, project, account, database, image


def main_process(container):
    identifier = output(['docker', 'inspect', '--format', '{{.Id}}', container]).strip()
    found = []
    for cmd in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            if os.readlink(cmd.with_name('exe')) == '/opt/wechat/wechat' and identifier in cmd.with_name('cgroup').read_text():
                if not re.search(r'^Uid:\s+1000\s', cmd.with_name('status').read_text(), re.M):
                    raise ValueError('Unexpected WeChat process owner')
                found.append(cmd)
        except OSError:
            continue
    if len(found) > 1:
        raise ValueError('Multiple WeChat main processes')
    return found[0] if found else None


@contextmanager
def tools(container, persist, account, bootstrap_image, desktop):
    if not re.fullmatch('sha256:[a-f0-9]{64}', bootstrap_image):
        raise ValueError('Verified bootstrap image required')
    if output(['docker','image','inspect','--format','{{.Id}}',bootstrap_image]).strip()!=bootstrap_image:
        raise ValueError('Bootstrap image mismatch')
    tag=uuid.uuid4().hex
    artifact='gdbot-capture-artifacts-'+tag
    prefix='/opt/groupdesk-chatlog-bootstrap-'+tag
    imports=persist/'wechat/bowxt'/('reader-key-'+tag)
    imports.mkdir(mode=0o700);os.chown(imports,1000,1000)
    inside='/config/bowxt/'+imports.name
    try:
        run(['docker','create','--name',artifact,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','/usr/bin/true',bootstrap_image],stdout=subprocess.DEVNULL)
        run(['docker','exec',container,'mkdir','-p',prefix+'/bin'])
        for source in ['/opt/validation-deps','/opt/chatlog-keeper','/opt/reader-python','/app/chatlog_reader']:
            producer=subprocess.Popen(['docker','cp',artifact+':'+source,'-'],stdout=subprocess.PIPE)
            try:
                run(['docker','cp','-',container+':'+prefix+'/'],stdin=producer.stdout)
            finally:
                producer.stdout.close()
                if producer.wait()!=0:raise RuntimeError('Public artifact transfer failed')
        run(['docker','cp',persist/'reader/secrets/vault-public.pem',container+':'+prefix+'/vault-public.pem'])
        wrapper='#!/bin/sh\nexport LD_LIBRARY_PATH='+prefix+'/validation-deps/usr/lib/x86_64-linux-gnu\nexec '+prefix+'/validation-deps/usr/bin/gdb --data-directory='+prefix+'/validation-deps/usr/share/gdb -iex \'unset environment LD_LIBRARY_PATH\' "$@"\n'
        writer='import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o755)'
        run(['docker','exec','-i',container,'python3','-c',writer,prefix+'/bin/gdb'],input=wrapper.encode())
        run(['docker','exec',container,'chown','1000:1000',prefix+'/vault-public.pem'])
        env={**desktop,'HOME':'/config','PYTHONDONTWRITEBYTECODE':'1','PYTHONUNBUFFERED':'1','PYTHONPATH':':'.join([prefix,prefix+'/chatlog-keeper',prefix+'/reader-python',prefix+'/validation-deps/usr/lib/python3/dist-packages']),'PATH':prefix+'/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','READER_ACCOUNT':account,'READER_BOOTSTRAP_PUBLIC_PATH':prefix+'/vault-public.pem','READER_BOOTSTRAP_IMPORT_PATH':inside+'/encrypted-key.json'}
        command=['docker','exec','--user','1000:1000']
        for key,value in env.items():command+=['--env',key+'='+value]
        command+=[container]
        probe="import hashlib,pathlib,subprocess;from Crypto.Cipher import AES;from chatlog_keeper import linux_key;assert hashlib.sha256(pathlib.Path('/opt/wechat/wechat').read_bytes()).hexdigest()=='2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959';r=subprocess.run(['gdb','--batch','-ex','run','--args','/bin/true'],capture_output=True,text=True,check=True);assert 'exited normally' in r.stdout;print('independent_bootstrap_preflight_passed')"
        run(command+['python3','-c',probe],timeout=45)
        yield command, imports/'encrypted-key.json'
    finally:
        subprocess.run(['docker','exec',container,'rm','-rf',prefix],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['docker','rm','-f',artifact],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(imports)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['check','capture'])
    parser.add_argument('bot_id')
    parser.add_argument('--bootstrap-image',required=True)
    parser.add_argument('--authorized-account-key-capture',action='store_true')
    args=parser.parse_args()
    if args.action=='capture' and not args.authorized_account_key_capture:
        raise ValueError('Explicit authorization for this account is required')
    root,persist,project,account,database,image=selection(args.bot_id)
    container=project+'-wechat-1'
    main=main_process(container)
    if main is None:raise ValueError('This account’s WeChat must be logged in first')
    if (persist/'reader/secrets/wechat-key.enc').exists():raise ValueError('Encrypted key already exists; do not recapture automatically')
    values=dict(v.split(b'=',1) for v in main.with_name('environ').read_bytes().split(b'\0') if b'=' in v)
    allowed=['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XAUTHORITY','LC_ALL','LANG','QT_LINUX_ACCESSIBILITY_ALWAYS_ON','NO_AT_BRIDGE']
    desktop={k:values[k.encode()].decode() for k in allowed if k.encode() in values}
    argv=[v.decode() for v in main.read_bytes().split(b'\0') if v];argv[0]='/opt/wechat/wechat'
    with tools(container,persist,account,args.bootstrap_image,desktop) as (command,encrypted):
        if args.action=='check':return
        stopped=False
        try:
            namespace_pid=next(l.split()[-1] for l in main.with_name('status').read_text().splitlines() if l.startswith('NSpid:'))
            run(['docker','exec','--user','1000:1000',container,'kill','-TERM',namespace_pid]);stopped=True
            deadline=time.monotonic()+25
            while main.exists() and time.monotonic()<deadline:time.sleep(.25)
            if main.exists():raise RuntimeError('WeChat did not stop normally')
            run(command+['python3','-m','chatlog_reader.bootstrap'],timeout=660)
            envelope=encrypted.read_bytes()
            if not 128<len(envelope)<=2048:raise ValueError('Invalid encrypted envelope')
            target=persist/'reader/key-import/encrypted-key.json';target.write_bytes(envelope);target.chmod(0o600);os.chown(target,1000,1000)
            credential=['docker','run','--rm','--read-only','--network','none','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','256m','--pids-limit','32','--ulimit','core=0','--tmpfs','/work:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=700']
            for source,dest in [(persist/'reader/config','/config:ro'),(persist/'reader/secrets','/secrets'),(persist/'reader/client','/client:ro'),(persist/'reader/key-import','/imports:ro'),(database,'/wechat/'+account+'/db_storage:ro')]:credential+=['-v',str(source)+':'+dest]
            run(credential+[image,'import-key'],timeout=45)
        finally:
            if stopped and main_process(container) is None:
                start='import json,os,subprocess,sys;v=json.load(sys.stdin);e=dict(os.environ);e.update(v["desktop"]);e["LC_ALL"]="zh_CN.UTF-8";subprocess.Popen(v["argv"],env=e,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)'
                run(['docker','exec','-i','--user','1000:1000',container,'python3','-c',start],input=json.dumps({'desktop':desktop,'argv':argv}).encode())
    print(json.dumps({'independent_key_encrypted_and_verified':True,'runtime_not_activated':True}))


if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(json.dumps({'error_type':type(exc).__name__,'runtime_not_activated':True}),flush=True)
        raise SystemExit(1)
