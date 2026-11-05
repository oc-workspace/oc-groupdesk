"""Render an empty per-account Docker deployment. Does not copy or start an account.

Run on the operator host after registering a real account in GroupDesk. Secrets
are supplied separately in private env/config files, never as command arguments.
"""
import argparse,json,re,uuid
from pathlib import Path

def render(bot_id,wechat_id,ports,images):
    identifier=str(uuid.UUID(bot_id));slug=identifier.replace('-','')
    if identifier=='00000000-0000-4000-8000-000000000001':raise ValueError('Legacy account uses its existing deployment')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',wechat_id):raise ValueError('Invalid WeChat ID')
    if len(ports)!=4 or len(set(ports))!=4 or any(type(p) is not int or not 1024<=p<=65535 for p in ports):raise ValueError('Four distinct loopback ports required')
    if set(images)!={'maibot','wechat','reader'} or any(not re.fullmatch(r'(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}',s) for s in images.values()):raise ValueError('Use three verified image digests')
    root=f'/opt/persist/groupdesk-bots/{slug}'
    deployment=f'/opt/docker/oc-projects/groupdesk-bots/{slug}'
    log={'driver':'json-file','options':{'max-size':'10m','max-file':'3'}}
    common={'restart':'unless-stopped','init':True,'logging':log,'pull_policy':'never'}
    maibot={**common,'image':images['maibot'],'profiles':['runtime'],'stop_grace_period':'75s','environment':{'TZ':'Asia/Singapore','HTTP_HOST':'0.0.0.0','WEBUI_HOST':'0.0.0.0','PYTHONPATH':'/limits','GT_LIMITS_STATE':'/limits-state','GT_PERSONA_SKILL_DIR':'/persona/base'},'env_file':[root+'/secrets/maibot.env'],'ports':[f'127.0.0.1:{ports[0]}:8001'],'volumes':[root+'/maibot/config:/MaiMBot/config',root+'/maibot/data:/MaiMBot/data',root+'/maibot/plugins:/MaiMBot/plugins',root+'/maibot/logs:/MaiMBot/logs',root+'/maibot/depends-data:/MaiMBot/depends-data',deployment+'/runtime/limits:/limits:ro',root+'/groupdesk:/groupdesk:ro',root+'/limits:/limits-state',root+'/persona/base:/persona/base:ro'],'networks':['bot'],'mem_limit':'1280m','pids_limit':512}
    for source,target in {'utils_model.py':'src/llm_models/utils_model.py','gemini_client.py':'src/llm_models/model_client/gemini_client.py','send_service.py':'src/services/send_service.py','reasoning_engine.py':'src/maisaka/reasoning_engine.py','reply.py':'src/maisaka/builtin_tool/reply.py'}.items():maibot['volumes'].append(deployment+'/runtime/patched/'+source+':/MaiMBot/'+target+':ro')
    bridge={**common,'image':images['maibot'],'profiles':['runtime'],'entrypoint':['/MaiMBot/.venv/bin/python'],'command':['/bridge/app.py'],'working_dir':'/bridge','env_file':[root+'/secrets/bridge.env'],'environment':{'TZ':'Asia/Singapore','PYTHONPATH':'/limits:/opt/bowxt/src','PYTHONUNBUFFERED':'1','BOWXT_BASE_URL':'http://wechat:8787','MAIBOT_WS_URL':'ws://maibot:8000/ws','BRIDGE_STATE':'/state','GT_LIMITS_STATE':'/limits-state','CHATLOG_READER_URL':'http://chatlog-reader:5030','CHATLOG_READER_TOKEN_FILE':'/reader-client/api-token'},'volumes':[deployment+'/runtime/bridge:/bridge:ro',deployment+'/runtime/bowxt:/opt/bowxt:ro',deployment+'/runtime/limits:/limits:ro',root+'/bridge:/state',root+'/limits:/limits-state',root+'/groupdesk:/groupdesk:ro',root+'/reader/client:/reader-client:ro'],'networks':['bot','data'],'mem_limit':'256m','pids_limit':64}
    # The desktop image uses s6, which must own PID 1 (Docker --init wraps it).
    wechat={**common,'init':False,'image':images['wechat'],'env_file':[root+'/secrets/desktop.env'],'environment':{'PUID':'1000','PGID':'1000','TZ':'Asia/Singapore','LC_ALL':'zh_CN.UTF-8','TITLE':'Bot WeChat '+wechat_id,'AUTO_START_WECHAT':'true','AUTO_START_QQ':'false','ENABLE_WECHAT_NIGHTLY_RESTART':'false','ENABLE_WECHAT_AUTO_LOGIN':'false','QT_LINUX_ACCESSIBILITY_ALWAYS_ON':'1','NO_AT_BRIDGE':'0','BOWXT_SYNC_MODE':'paused'},'ports':[f'127.0.0.1:{ports[1]}:3000',f'127.0.0.1:{ports[2]}:3001',f'127.0.0.1:{ports[3]}:8787'],'volumes':[root+'/wechat:/config'],'shm_size':'512m','mem_limit':'1664m','pids_limit':512,'networks':['bot']}
    reader={**common,'image':images['reader'],'profiles':['runtime'],'read_only':True,'user':'1000:1000','cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'volumes':[root+'/reader/config:/config:ro',root+'/reader/secrets:/secrets:ro',root+'/reader/client:/client:ro',root+'/reader/data:/state','${WECHAT_ACCOUNT_DATABASES:?Select this bot account db_storage}:/wechat/${READER_ACCOUNT:?Select this bot account}/db_storage:ro'],'tmpfs':['/work:rw,nosuid,nodev,size=536870912,uid=1000,gid=1000,mode=700','/tmp:rw,nosuid,nodev,size=16777216,mode=1777'],'healthcheck':{'test':['CMD','python','-m','chatlog_reader','health'],'interval':'15s','timeout':'8s','retries':4},'mem_limit':'512m','pids_limit':64,'ulimits':{'core':0},'networks':{'data':{'aliases':['chatlog-reader']}}}
    return {'bot_id':identifier,'wechat_id':wechat_id,'runtime_instance_id':str(uuid.uuid4()),'deployment':deployment,'persist':root,'compose':{'name':'gdbot-'+slug,'services':{'wechat':wechat,'maibot':maibot,'wechat-bridge':bridge,'reader':reader},'networks':{'bot':{'driver':'bridge'},'data':{'driver':'bridge','internal':True}}}}

def main():
    p=argparse.ArgumentParser();p.add_argument('manifest',type=Path);p.add_argument('output',type=Path);a=p.parse_args();m=json.loads(a.manifest.read_text());result=render(m['bot_id'],m['wechat_id'],m['ports'],m['images'])
    a.output.mkdir(parents=True,exist_ok=False,mode=0o700)
    compose=result.pop('compose')
    (a.output/'compose.json').write_text(json.dumps(compose,ensure_ascii=False,indent=2)+'\n')
    (a.output/'compose.desktop.json').write_text(json.dumps({'name':compose['name'],'services':{'wechat':compose['services']['wechat']},'networks':{'bot':compose['networks']['bot']}},ensure_ascii=False,indent=2)+'\n')
    (a.output/'deployment.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    (a.output/'README.txt').write_text('Empty deployment scaffold only. Supply this account’s private configs, verified runtime code, login and encrypted Reader key before starting runtime. See docs/multi-bot-management.md.\n')
    print('Independent Docker deployment rendered; no services started or account data copied.')
if __name__=='__main__':main()
