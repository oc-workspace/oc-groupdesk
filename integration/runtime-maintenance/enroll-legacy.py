"""Trusted operator enrollment, metadata only. Does not stop or read account files."""
import argparse,importlib.util,json,os,uuid
from pathlib import Path
s=importlib.util.spec_from_file_location('agent',Path(__file__).with_name('agent.py'));a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
p=argparse.ArgumentParser();p.add_argument('--instance-id',required=True);args=p.parse_args();uuid.UUID(args.instance_id)
assert os.geteuid()==0
rows=a.containers();wanted={'wechat-bot':('maibot-wechat','wechat'), 'maibot-gt':('maibot-wechat','maibot'),'maibot-wechat-bridge':('maibot-wechat','wechat-bridge'),'chatlog-reader':('chatlog-reader','reader')};pins=[]
for name,(project,service) in wanted.items():
 c=next(x for x in rows if x['name']=='/'+name);labels=c['labels'] or {};assert labels.get('com.docker.compose.project')==project and labels.get('com.docker.compose.service')==service
 for m in c['mounts']:
  source=Path(m['Source']);assert m['Type']=='bind' and any(root==source or root in source.parents for root in [a.LEGACY_PERSIST,a.LEGACY_READER,Path('/opt/docker/oc-projects/maibot-wechat')])
 pins.append({k:c[k] for k in ['id','name','image','labels','mounts']})
ids={c['id'] for c in pins};names={n for c in rows if c['id'] in ids for n in c['networks']};nets=[]
for name in names:
 fmt='{"id":{{json .Id}},"name":{{json .Name}},"containers":{{json .Containers}}}'
 n=json.loads(a.run('docker','network','inspect','--format',fmt,name));assert all(cid in ids for cid in n['containers']);nets.append({'id':n['id'],'name':n['name']})
units={u['name']:a.unit_fingerprint(u['name']) for u in a.units(a.LEGACY) if u['loaded']}
approved=[];excluded=[]
for kind,path in a.legacy_candidate_paths():
 if not path.exists():continue
 info=a.size_tree(path,allow_contained_links=True)
 if not info['blocked']:approved.append([kind,str(path)]);continue
 if kind=='wechat':
  for child in path.iterdir():
   if child.is_dir() and not child.is_symlink():
    sub=a.size_tree(child,allow_contained_links=True)
    if not sub['blocked']:approved.append([kind,str(child)]);continue
   excluded.append({'path':str(child),'reason':'原备份、目录外链接或未登记文件仅保留，不随清理删除'})
 else:excluded.append({'path':str(path),'reason':'；'.join(info['blocked'])})
profile={'profile':'legacy-ryubuddy-v1','bot_id':a.LEGACY,'instance_id':args.instance_id,'containers':pins,'networks':nets,'units':units,'approved_paths':approved,'excluded_paths':excluded}
assert not a.LEGACY_PROFILE.exists(),'Explicitly reconcile an existing enrollment instead of silently replacing it'
a.atomic(a.LEGACY_PROFILE,profile);print('Legacy profile enrolled from exact container/network IDs; no credentials or account content read.')
