"""Validate the precise policy baseline and all hunks before writing."""
from pathlib import Path
import ast,hashlib,json,re,sys
pkg=Path(__file__).resolve().parent;p=Path(sys.argv[1]);digests=json.loads((pkg/'policy-baseline.json').read_text());data=p.read_bytes();sha=lambda x:hashlib.sha256(x).hexdigest()
if sha(data)==digests['after']:print('Reply limits policy already installed');raise SystemExit(0)
if sha(data)!=digests['before']:raise ValueError('Unknown policy baseline')
source=data.decode().splitlines(keepends=True);patch=(pkg/'policy.patch').read_text().splitlines(keepends=True);result=[];cursor=0;i=2
while i<len(patch):
 m=re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',patch[i]);assert m,'Invalid hunk';position=int(m[1])-1;assert position>=cursor
 result.extend(source[cursor:position]);cursor=position;i+=1
 while i<len(patch) and not patch[i].startswith('@@ '):
  line=patch[i];assert line[0] in ' +-'
  if line[0] in ' -':assert source[cursor]==line[1:];cursor+=1
  if line[0] in ' +':result.append(line[1:])
  i+=1
result.extend(source[cursor:]);out=''.join(result).encode();assert sha(out)==digests['after'];ast.parse(out.decode());p.write_bytes(out);print('Checked reply limits policy installed')
