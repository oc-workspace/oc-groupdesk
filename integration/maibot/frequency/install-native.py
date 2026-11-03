"""Apply all reviewed source hunks only after every baseline is verified."""
from pathlib import Path
import ast,hashlib,json,re,sys
pkg=Path(__file__).resolve().parent

def apply_patch(data,patch):
 source=data.decode().splitlines(keepends=True);lines=patch.splitlines(keepends=True);out=[];cursor=0;i=2
 while i<len(lines):
  m=re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',lines[i])
  if not m:raise ValueError('Invalid hunk')
  pos=int(m[1])-1
  if pos<cursor:raise ValueError('Overlapping hunk')
  out.extend(source[cursor:pos]);cursor=pos;i+=1
  while i<len(lines) and not lines[i].startswith('@@ '):
   line=lines[i]
   if line[:1] not in ' +-':raise ValueError('Invalid patch line')
   if line[0] in ' -':
    if cursor>=len(source) or source[cursor]!=line[1:]:raise ValueError('Source hunk mismatch')
    cursor+=1
   if line[0] in ' +':out.append(line[1:])
   i+=1
 out.extend(source[cursor:]);return ''.join(out).encode()

def install(root):
 meta=json.loads((pkg/'native-baselines.json').read_text());prepared={};sha=lambda v:hashlib.sha256(v).hexdigest()
 for name,item in meta.items():
  data=(root/name).read_bytes()
  if sha(data)==item['after']:continue
  if sha(data)!=item['before']:raise ValueError('Unknown native baseline: '+name)
  result=apply_patch(data,(pkg/item['patch']).read_text())
  if sha(result)!=item['after']:raise ValueError('Unexpected native result: '+name)
  ast.parse(result);prepared[root/name]=result
 module=(pkg.parent/'reply_frequency.py').read_bytes();ast.parse(module);target=root/'limits/reply_frequency.py'
 if target.exists() and target.read_bytes()!=module:raise ValueError('Unexpected existing reply frequency module')
 prepared[target]=module
 for path,data in prepared.items():
  tmp=path.with_name(path.name+'.frequency-tmp');tmp.write_bytes(data);tmp.chmod(0o644);tmp.replace(path)
 return len(prepared)

if __name__=='__main__':print(json.dumps({'installed':install(Path(sys.argv[1]))}))
