"""Operator-only exact-baseline policy hook; no private config changes."""
import argparse,ast,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('policy',type=Path);p.add_argument('--baseline',required=True);a=p.parse_args()
s=a.policy.read_text();hook='from bot_names import NAME'
if hook in s:raise SystemExit(0)
if hashlib.sha256(a.policy.read_bytes()).hexdigest()!=a.baseline:raise ValueError('Unexpected policy baseline')
lines=s.splitlines();matches=[i for i,line in enumerate(lines) if line.startswith('NAME = re.compile(')]
if len(matches)!=1:raise ValueError('Unexpected name hook')
lines[matches[0]]=hook;s='\n'.join(lines)+'\n';ast.parse(s);a.policy.write_text(s)
