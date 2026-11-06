"""One-time operator deployment of the scoped Docker agent and narrow broker."""
import argparse,json,os,re,shutil,subprocess,uuid
from pathlib import Path

def run(args,**kw):return subprocess.run(args,check=True,**kw)
def main():
 p=argparse.ArgumentParser();p.add_argument('bot_id');p.add_argument('--source',required=True);p.add_argument('--python-image',required=True);p.add_argument('--agent-image',required=True);a=p.parse_args();bot=str(uuid.UUID(a.bot_id));slug=bot.replace('-','')
 if bot!=a.bot_id or bot=='00000000-0000-4000-8000-000000000001' or not re.fullmatch('[a-f0-9]{40}',a.source) or not re.fullmatch('sha256:[a-f0-9]{64}',a.python_image) or not re.fullmatch('groupdesk-onboarding-agent:[a-f0-9]{40}',a.agent_image):raise ValueError('Reviewed independent bot and fixed images required')
 code=Path(__file__).resolve().parent;root=Path('/opt/docker/oc-projects/groupdesk-bots')/slug;persist=Path('/opt/persist/groupdesk-bots')/slug
 meta=json.loads((root/'deployment.json').read_text());conf=json.loads((persist/'groupdesk/connection.json').read_text())
 if meta['bot_id']!=bot or conf['bot_id']!=bot or meta['runtime_instance_id']!=conf['runtime_instance_id']:raise ValueError('Own account binding required')
 release=Path('/opt/docker/oc-projects/groupdesk-onboarding/releases')/a.source;release.mkdir(mode=0o755,parents=True,exist_ok=True)
 for name in ['host.py','ops.py','discover.py','greeting.py','agent.py','wechat_egress.py']:
  source=code/name if name!='wechat_egress.py' else code.parent/'maibot/bots/wechat_egress.py'
  shutil.copy2(source,release/name)
 current=release.parent.parent/'current';tmp=current.with_name('current-next');tmp.unlink(missing_ok=True);tmp.symlink_to(release,target_is_directory=True);tmp.replace(current)
 Path('/run/groupdesk-onboarding').mkdir(mode=0o700,exist_ok=True);Path('/run/groupdesk-bot-egress').mkdir(mode=0o700,exist_ok=True)
 for name in ['groupdesk-onboarding-control@.service','groupdesk-onboarding-egress@.service']:shutil.copy2(code/name,Path('/etc/systemd/system')/name)
 python_tag='groupdesk-onboarding-python:'+a.source
 run(['docker','image','inspect',a.python_image],stdout=subprocess.DEVNULL)
 run(['docker','image','tag',a.python_image,python_tag])
 run(['docker','build','--network=none','--pull=false','-f',str(code/'Dockerfile'),'--build-arg','PYTHON_IMAGE='+python_tag,'-t',a.agent_image,str(code)])
 run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','groupdesk-onboarding-control@'+bot+'.service'])
 namespace='gdbot-'+slug
 service={'image':a.agent_image,'pull_policy':'never','restart':'unless-stopped','init':True,'read_only':True,'user':'0:0','cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'tmpfs':['/tmp:rw,nosuid,nodev,size=16m,mode=1777'],'volumes':[str(persist/'groupdesk')+':/groupdesk:ro','/run/groupdesk-onboarding/'+bot+':/control:ro'],'networks':['bot'],'mem_limit':'96m','pids_limit':32,'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}},'healthcheck':{'test':['CMD','python','-c',"import time;from pathlib import Path;assert time.time()-Path('/tmp/onboarding-heartbeat').stat().st_mtime<120"],'interval':'30s','timeout':'5s','retries':3,'start_period':'60s'}}
 compose={'name':namespace,'services':{'group-onboarding-agent':service},'networks':{'bot':{'external':True,'name':namespace+'_bot'}}}
 path=root/'compose.onboarding.json';path.write_text(json.dumps(compose,indent=2)+'\n');path.chmod(0o600)
 run(['docker','compose','-f',str(path),'up','-d','--no-build','group-onboarding-agent'])
 run(['systemctl','enable','--now','groupdesk-onboarding-egress@'+bot+'.service'])
 (root/'onboarding-agent-source-version').write_text(a.source+'\n');print('Account-scoped onboarding agent deployed; no group, WeChat or existing runtime was changed.')
if __name__=='__main__':main()
