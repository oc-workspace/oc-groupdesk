"""Prepare only checksum-pinned public build inputs, never production data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

parser=argparse.ArgumentParser()
parser.add_argument('--inputs',type=Path,required=True)
parser.add_argument('--runtime-only',action='store_true')
args=parser.parse_args()
root=Path(__file__).resolve().parent
lock=json.loads((root/'inputs.lock.json').read_text())
target=root/'inputs';target.mkdir(exist_ok=True)

def check(path,expected):
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise ValueError('Unverified public build input: '+path.name)

archive=args.inputs/'upstream.tar.gz'
check(archive,lock['upstream_archive_sha256'])
unpack=target/'upstream';unpack.mkdir(exist_ok=True)
with tarfile.open(archive,'r:gz') as source:
    prefix='chatlog-keeper-'+lock['upstream_commit']+'/'
    for member in source.getmembers():
        if not member.name.startswith(prefix):
            if member.isdir() and member.name==prefix.rstrip('/'):continue
            raise ValueError('Unexpected archive root')
        member.name=member.name[len(prefix):]
        if not member.name:continue
        source.extract(member,unpack,filter='data')
wheels=target/'wheels';wheels.mkdir(exist_ok=True)
for name,expected in lock['wheels'].items():
    check(args.inputs/'wheels'/name,expected)
    shutil.copy2(args.inputs/'wheels'/name,wheels/name)
if set(path.name for path in wheels.iterdir())!=set(lock['wheels']):
    raise ValueError('Unexpected wheel in build input')
if not args.runtime_only:
    archive=args.inputs/'bootstrap-debs.tar.gz'
    check(archive,lock['bootstrap_debs_sha256'])
    packages=target/'bootstrap-debs';packages.mkdir(exist_ok=True)
    with tarfile.open(archive,'r:gz') as source:
        for member in source.getmembers():
            if member.isfile() and member.name.endswith('.deb'):
                member.name=Path(member.name).name
                source.extract(member,packages,filter='data')
shutil.copy2(root.parent/'maibot/chatlog_runtime.py',target/'chatlog_runtime.py')
print(json.dumps({'public_inputs_verified':True,'upstream_commit':lock['upstream_commit']}))
