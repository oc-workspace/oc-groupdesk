"""Patch only the reviewed bridge lifecycle hook; never modifies private files."""
from pathlib import Path
import argparse,ast,hashlib
p=argparse.ArgumentParser();p.add_argument('bridge',type=Path);p.add_argument('--baseline',required=True);a=p.parse_args()
s=a.bridge.read_text()
after='status=await asyncio.to_thread(bot_runtime.sync,self)'
if after in s and 'import bot_runtime' in s:raise SystemExit(0)
if hashlib.sha256(a.bridge.read_bytes()).hexdigest()!=a.baseline:raise ValueError('Unknown bridge baseline')
if s.count('status=await asyncio.to_thread(gd.sync)')!=1 or s.count('import groupdesk_runtime as gd')!=1:raise ValueError('Unknown lifecycle hook')
s=s.replace('import groupdesk_runtime as gd','import groupdesk_runtime as gd\nimport bot_runtime',1).replace('status=await asyncio.to_thread(gd.sync)',after,1)
ast.parse(s);a.bridge.write_text(s)
