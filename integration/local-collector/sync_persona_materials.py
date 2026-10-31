#!/usr/bin/env python3
"""Read a fresh local WeChat snapshot and incrementally import it to GroupDesk.

Uses the already configured collector and SSH alias; never stores an admin
password/API key or sends a chat message. Run in the local collector project.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid


def load_collector_env(project):
    allowed={'COLLECTOR_KIND','ALLOWED_GROUPS','SUMMARY_TIMEZONE','WECHAT_DB_ROOT',
             'WECHAT_KEY_FILE','MACOS_WECHAT_EXPORT_DIR','WECHAT_SELF_ID'}
    for line in (project/'.env').read_text().splitlines():
        line=line.strip().removeprefix('export ')
        if not line or line.startswith('#') or '=' not in line:
            continue
        key,value=line.split('=',1)
        if key not in allowed:
            continue
        parts=shlex.split(value,comments=True)
        if len(parts)==1:
            os.environ.setdefault(key,parts[0])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group',required=True)
    parser.add_argument('--collection',type=uuid.UUID)
    parser.add_argument('--host',default='rococo-root')
    parser.add_argument('--collector-project',type=Path,default=Path.cwd())
    parser.add_argument('--snapshot',type=Path,help='Retry an existing completed snapshot without rereading WeChat')
    parser.add_argument('--export-only',action='store_true')
    args=parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*',args.host):
        parser.error('Invalid SSH alias')
    if not args.export_only and not args.collection:
        parser.error('--collection is required unless --export-only')
    project=args.collector_project.resolve()
    if args.snapshot:
        output=args.snapshot.resolve()
        manifest=json.loads((output/'manifest.json').read_text())
    else:
        load_collector_env(project)
        sys.path.insert(0,str(project/'scripts'))
        from export_group_messages import export_group
        from wechat_summary_bridge import build_collector
        collector=build_collector()
        stamp=datetime.now(collector.zone).strftime('%Y%m%d-%H%M%S-%f')
        output=project/'data/personas/group-history'/hashlib.sha256(args.group.encode()).hexdigest()[:16]/'snapshots'/stamp
        manifest=export_group(collector,args.group,output)
    path=output/'messages.jsonl'
    expected=manifest['files']['messages.jsonl']['sha256']
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise RuntimeError('Snapshot checksum mismatch; import cancelled')
    result={'snapshot':str(output),'count':manifest['count'],'sha256':expected}
    if not args.export_only:
        name='wechat-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.jsonl'
        command='docker exec -i groupdesk-app-1 /app/node_modules/.bin/tsx /app/scripts/import-persona-archive.ts --collection '+str(args.collection)+' --name '+shlex.quote(name)
        with path.open('rb') as stream:
            process=subprocess.run(['ssh','-o','BatchMode=yes',args.host,command],stdin=stream,capture_output=True,text=True,timeout=600)
        if process.returncode:
            raise RuntimeError('SSH import failed; local snapshot is preserved. Check the SSH connection and GroupDesk collection, then retry with --snapshot.')
        response=json.loads(process.stdout)
        result['import']={k:response.get(k) for k in ['id','added','updated','unchanged','reused','sha256']}
        if result['import']['sha256']!=expected:
            raise RuntimeError('Server checksum differs from local snapshot')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error) if isinstance(error,RuntimeError) else 'Export/sync failed; previous snapshots are preserved. Check the collector and connection.',file=sys.stderr)
        sys.exit(1)
