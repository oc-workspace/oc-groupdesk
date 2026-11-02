"""Apply exact-baseline unified hunks in memory; no external patch binary."""
from pathlib import Path
import ast,hashlib,json,re,sys
package=Path(__file__).resolve().parent;root=Path(sys.argv[1])
baseline=json.loads((package/'baseline.json').read_text());candidate=json.loads((package/'candidate.json').read_text())
sha=lambda b:hashlib.sha256(b).hexdigest()
patch=(package/'identity-recovery.patch').read_text().splitlines(keepends=True)
outputs={}
for name,digest in baseline.items():
 path=root/'src/bowxt'/name;original=path.read_bytes()
 if sha(original)==candidate[name]:outputs[name]=original;continue
 if sha(original)!=digest:raise ValueError('Unknown SDK baseline: '+name)
 source=original.decode().splitlines(keepends=True);cursor=0;result=[]
 start=next(i for i,line in enumerate(patch) if line=='--- a/src/bowxt/'+name+'\n')+2
 i=start
 while i<len(patch) and not patch[i].startswith('--- '):
  match=re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',patch[i]);assert match,'Unknown hunk header'
  position=int(match[1])-1 if match[2]!='0' else int(match[1]);assert position>=cursor
  result.extend(source[cursor:position]);cursor=position;i+=1
  while i<len(patch) and not patch[i].startswith(('@@ ','--- ')):
   line=patch[i];assert line[:1] in {' ','+','-'},'Unknown patch line'
   if line[0] in {' ','-'}:assert cursor<len(source) and source[cursor]==line[1:],'Hunk differs';cursor+=1
   if line[0] in {' ','+'}:result.append(line[1:])
   i+=1
 result.extend(source[cursor:]);data=''.join(result).encode();assert sha(data)==candidate[name]
 ast.parse(data.decode());outputs[name]=data
module=(package/'identity_recovery.py').read_bytes();assert sha(module)==candidate['identity_recovery.py'];ast.parse(module.decode())
existing=root/'src/bowxt/identity_recovery.py'
if existing.exists():assert sha(existing.read_bytes())==candidate['identity_recovery.py'],'Conflicting module'
outputs['identity_recovery.py']=module
# Validate every file before changing any file.
for name,data in outputs.items():(root/'src/bowxt'/name).write_bytes(data)
(root/'tests/test_identity_recovery.py').write_bytes((package/'test_identity_recovery.py').read_bytes())
print('Checked identity recovery patch installed')
