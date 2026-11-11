"""Apply the reviewed native Quote UI sender patch to the pinned Bowxt build."""
import ast
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

package=Path(__file__).resolve().parent
root=Path(sys.argv[1]).resolve()
manifest=json.loads((package/'manifest.json').read_text())
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
before={name:digest(root/'src/bowxt'/name) for name in manifest}
if before=={name:item['after'] for name,item in manifest.items()}:
    sys.exit(0)
if before!={name:item['before'] for name,item in manifest.items()}:
    raise ValueError('Bowxt source changed; native Quote patch requires review')
subprocess.run(['patch','--batch','--fuzz=0','-p1','-i',str(package/'native-quote.patch')],cwd=root,check=True)
shutil.copyfile(package/'quote-menu-en.png',root/'src/bowxt/quote-menu-en.png')
for name,item in manifest.items():
    data=(root/'src/bowxt'/name).read_bytes()
    if hashlib.sha256(data).hexdigest()!=item['after']:
        raise ValueError('Native Quote patch output differs from reviewed manifest')
    if name.endswith('.py'):ast.parse(data,filename=name)
