#!/usr/bin/env python3
"""Build a source-only public distribution from an explicit allowlist. No private image snapshots."""
import ast,argparse,hashlib,json,os,re,shutil,subprocess,tarfile,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
# These are runtime code/data definitions, never uploads, private skills, tests or deployment history.
TREES={'server','shared','web','migrations','catalog','integration','distribution'}
SUFFIX={'.ts','.mts','.tsx','.css','.html','.json','.sql','.py','.swift','.mjs','.toml','.yaml','.sh','.txt','.conf','.service','.timer','.socket','.svg'}
FILES={'scripts/provision-runtime-host.ts','package.json','package-lock.json','tsconfig.json','vite.config.ts'}
DENY=re.compile(r'sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|GT 🇨🇦|hyyyylhyy|Children that Jay left behind')
def selected(path):
 rel=path.relative_to(ROOT)
 if rel.as_posix() in FILES:return True
 if rel.parts[0] not in TREES or any(part in {'node_modules','__pycache__','fixtures','secrets','data','logs','artifacts','docs','hermes'} for part in rel.parts):return False
 if rel.as_posix() in {'integration/local-collector/macos-gui/README.md','integration/local-collector/macos-gui/continuous/README.md','integration/local-collector/macos-gui/continuous/test_stream.py'}:return True
 if path.name.startswith(('test_','test-')) or path.name.endswith(('.test.ts','_test.py')):return False
 if rel.parts[0]=='integration' and path.name.startswith('LICENSE'):return True
 if rel.parts[0]=='distribution':return path.suffix in SUFFIX or path.suffix=='.md' or path.name=='Dockerfile'
 return path.suffix in SUFFIX and (path.name not in {'agent-config.json','connection.json'})
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--version',required=True);a=p.parse_args()
 if not re.fullmatch('[a-zA-Z0-9_.-]{1,80}',a.version):raise ValueError('Invalid version')
 dest=Path(a.output).resolve()
 if dest.exists():raise ValueError('Output must not exist')
 with tempfile.TemporaryDirectory(prefix='gd-package-') as temp:
  root=Path(temp)/('groupdesk-'+a.version);root.mkdir()
  for path in ROOT.rglob('*'):
   if not path.is_file() or not selected(path):continue
   if path.is_symlink():raise ValueError('Symlink in public code allowlist')
   content=path.read_bytes()
   if DENY.search(content.decode('utf-8')):raise ValueError('Sensitive content in '+str(path.relative_to(ROOT)))
   target=root/path.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content);target.chmod(0o755 if path.suffix in {'.py','.sh'} else 0o644)
  # No historical copied Skill or private persona ships. Generic prompts are original to this distribution.
  (root/'Dockerfile').write_bytes((ROOT/'distribution/Dockerfile').read_bytes())
  (root/'.dockerignore').write_text('.git\n.env*\n**/secrets\n**/data\n**/*.gpg\n**/*.key\nnode_modules\ndist\n')
  required=['distribution/summary-templates/'+s+'.md' for s in ['comprehensive','technical','ranking','entertainment','news']]+['integration/participation/matcher.d.mts','integration/local-collector/macos-gui/continuous/test_stream.py','integration/local-collector/macos-gui/continuous/README.md']
  downloads=ast.literal_eval(re.search(r'const sourceNames=(\[[\s\S]*?\]);',(ROOT/'server/device-onboarding.ts').read_text()).group(1))
  required += ['integration/local-collector/macos-gui/'+name for name in downloads]
  if any(not (root/p).is_file() for p in required):raise ValueError('Missing runtime package dependency')
  hashes={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(root.rglob('*')) if f.is_file()}
  report={'format':1,'version':a.version,'private_data_included':False,'private_images_used':False,'auto_import_personas':False,'third_party_skills_bundled':False,'files':hashes}
  (root/'PACKAGE-MANIFEST.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
  (root/'SHA256SUMS').write_text(''.join(v+'  '+k+'\n' for k,v in hashes.items()))
  with tarfile.open(dest,'w:gz') as tar:tar.add(root,arcname=root.name)
 print(json.dumps({'file':str(dest),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'files':len(hashes),'bytes':dest.stat().st_size}))
if __name__=='__main__':main()
