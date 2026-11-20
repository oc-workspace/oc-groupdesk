"""Linux Docker smoke test; uses synthetic identities/credentials only, excluded from distribution.
Run after loading/building the standalone image; lab must not already exist.
"""
import argparse,importlib.util,json,os,secrets,subprocess,sys,urllib.request
from pathlib import Path
os.umask(0o077)
parser=argparse.ArgumentParser(description='Synthetic standalone install/backup/restore smoke test; never point lab at an existing directory')
parser.add_argument('--bundle',required=True);parser.add_argument('--image',required=True);parser.add_argument('--lab',required=True);a=parser.parse_args()
b=Path(a.lab).resolve();assert not b.exists(),'Use a NEW test directory';b.mkdir(mode=0o700)
(b/'admin-password').write_text(secrets.token_urlsafe(32));(b/'recovery-password').write_text(secrets.token_urlsafe(48))
cli=Path(a.bundle).resolve()/'distribution/manage.py';s=importlib.util.spec_from_file_location('manage',cli);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
nonce=secrets.token_hex(4)
subprocess.run(['python3',str(cli),'init','--target',str(b/'empty'),'--project','gd-smoke-empty-'+nonce,'--image',a.image,'--port','43124','--isolated','--admin-password-file',str(b/'admin-password')],check=True)
subprocess.run(['python3',str(cli),'up','--target',str(b/'empty')],check=True)
i=m.Instance(b/'empty');report={}

checks=['managed_bots','managed_model_keys','groups','topics','personas','knowledge_bases','persona_materials','managed_runtime_hosts']
for table in checks:
 count=int(i.sql('groupdesk','SELECT count(*) FROM '+table));assert count==0,(table,count)
assert i.sql('groupdesk','SELECT count(*) FROM admins')=='1';report['empty_install']={'private_business_tables_empty':checks,'administrator_count':1}
def request(path,body=None,cookie=None,csrf=None,bot=None,port=43124):
 headers={'Content-Type':'application/json'}
 if cookie:headers['Cookie']=cookie
 if csrf:headers['X-CSRF-Token']=csrf
 if bot:headers['X-GroupDesk-Bot']=bot
 js="const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));fetch('http://127.0.0.1:3110/api'+x.path,{method:x.body===null?'GET':'POST',headers:x.headers,body:x.body===null?undefined:JSON.stringify(x.body)}).then(async r=>{let data=await r.json();process.stdout.write(JSON.stringify({status:r.status,data,headers:{...Object.fromEntries(r.headers),'set-cookie':r.headers.getSetCookie().join('@@COOKIE@@')}}))}).catch(()=>process.exit(1));"
 instance=i if port==43124 else m.Instance(b/'roundtrip')
 result=json.loads(subprocess.check_output(instance.dc('exec','-T','app','node','-e',js),input=json.dumps({'path':path,'body':body,'headers':headers}).encode()))
 assert result['status']<300,('test_api_failed',path,result['status'],result['data'].get('error'))
 return result['data'],{k.title():v for k,v in result['headers'].items()}

login,headers=request('/auth/login',{'username':'admin','password':(b/'admin-password').read_text()});cookie=next(v for v in headers['Set-Cookie'].split('@@COOKIE@@') if v.startswith('groupdesk_session=')).split(';')[0];csrf=login['csrf']
created,_=request('/bots',{'name':'Synthetic roundtrip robot','wechat_id':'synthetic_roundtrip','host_label':'','notes':''},cookie,csrf);bot=created['id']
group,_=request('/groups',{'name':'Synthetic recovery group'},cookie,csrf,bot)
row=json.loads(i.sql('groupdesk',"SELECT row_to_json(b) FROM managed_bots b WHERE id='"+bot+"'"));business=row['db_name'];assert i.sql(business,'SELECT count(*) FROM groups')=='1'
marker=i.root/'data/files/bots'/row['data_namespace']/'uploads/check.txt';marker.parent.mkdir(parents=True,exist_ok=True);marker.write_text('synthetic file for backup roundtrip');os.chown(marker,1000,1000)

# HTTP download must include every source and license, not just render the page.
download_js="const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));fetch('http://127.0.0.1:3110/api/bots/'+x.id+'/onboarding/device-tool',{headers:{cookie:x.cookie}}).then(async r=>{const text=await r.text();if(!r.ok||!text.includes('MAC_GUI_SOURCES')||!text.includes('ReadProbe.swift')||!text.includes('continuous/test_stream.py'))process.exit(1);console.log(JSON.stringify({download_bytes:text.length}))});"
download=json.loads(subprocess.check_output(i.dc('exec','-T','app','node','-e',download_js),input=json.dumps({'id':bot,'cookie':cookie}).encode()));report['device_tool_download']=download
fixture_js="""
import {randomUUID,createHash} from 'node:crypto';
import {controlPool,pool,closeBusinessPools} from './server/db.ts';
import {withBot} from './server/bot-workspaces.ts';
import {sealControlSecret} from './server/bot-secrets.ts';
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>resolve(s));}));
try{
const owner=(await controlPool.query("SELECT id FROM admins WHERE role='super_admin' ORDER BY created_at LIMIT 1")).rows[0].id;
const key=randomUUID(),fake='synthetic-never-call-key';
await controlPool.query("INSERT INTO managed_model_keys(id,owner_user_id,created_by_user_id,name,scope,base_url,client_type,secret_ciphertext,key_digest,key_hint,enabled) VALUES($1,$2,$2,'Synthetic unused key','private','https://example.invalid/v1','openai',$3,$4,'000000',false)",[key,owner,sealControlSecret(fake),createHash('sha256').update(fake).digest('hex')]);
await withBot(input.bot,async()=>{
const credential=randomUUID(),persona=randomUUID(),collection=randomUUID(),dataset=randomUUID();
await pool.query("INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,enabled,vault_key_id) VALUES($1,'Synthetic unused alias','https://example.invalid/v1','vault:v1','000000',$2,false,$3)",[credential,'synthetic-'+credential,key]);
await pool.query("INSERT INTO personas(id,name,skill_name) VALUES($1,'Synthetic pending persona','synthetic-pending')",[persona]);
await pool.query("INSERT INTO persona_jobs(id,persona_id,draft_revision,credential_id,credential_revision,model_id,input_file,provenance) VALUES($1,$2,1,$3,1,'synthetic','synthetic-input.json','{}')",[randomUUID(),persona,credential]);
await pool.query("INSERT INTO persona_collections(id,name) VALUES($1,'Synthetic collection')",[collection]);
await pool.query("INSERT INTO persona_datasets(id,collection_id,name) VALUES($1,$2,'Synthetic dataset')",[dataset,collection]);
await pool.query("INSERT INTO conversation_jobs(id,dataset_id,credential_id,credential_revision,model_id,input,provenance) VALUES($1,$2,$3,1,'synthetic','{}','{}')",[randomUUID(),dataset,credential]);
await pool.query("INSERT INTO group_onboarding_jobs(id,request_id,kind,input,input_sha256,created_by) VALUES($1,$2,'greeting','{}',$3,'synthetic')",[randomUUID(),randomUUID(),'a'.repeat(64)]);
});
console.log('synthetic_pending_jobs_created');
}finally{await closeBusinessPools();await controlPool.end();}
"""
subprocess.run(i.dc('exec','-T','app','node','--import','tsx','--input-type=module','-e',fixture_js),input=json.dumps({'bot':bot}).encode(),check=True,stdout=subprocess.DEVNULL)

backup=b/'synthetic-roundtrip-rc6.gpg'
subprocess.run(['python3',str(cli),'backup','--target',str(i.root),'--output',str(backup),'--passphrase-file',str(b/'recovery-password')],check=True)
report['new_backup']=json.loads(Path(str(backup)+'.verification.json').read_text())
# Refuse using a live source instance as a restore target before any database changes.
r=subprocess.run(['python3',str(cli),'restore','--target',str(i.root),'--source',str(backup),'--passphrase-file',str(b/'recovery-password'),'--confirm-empty-target'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);assert r.returncode!=0;assert i.sql(business,'SELECT count(*) FROM groups')=='1';report['nonempty_target_rejected']=True
restore=b/'roundtrip'
subprocess.run(['python3',str(cli),'init','--target',str(restore),'--project','gd-smoke-restore-'+nonce,'--image',a.image,'--port','43125','--isolated','--admin-password-file',str(b/'admin-password')],check=True)
subprocess.run(['python3',str(cli),'restore','--target',str(restore),'--source',str(backup),'--passphrase-file',str(b/'recovery-password'),'--confirm-empty-target'],check=True)
r=m.Instance(restore);assert r.sql(business,'SELECT count(*) FROM groups')=='1';assert (restore/'data/files'/marker.relative_to(i.root/'data/files')).read_text()==marker.read_text();assert r.sql('groupdesk',"SELECT count(*) FROM managed_bots WHERE state<>'paused'")=='0';assert r.sql('groupdesk','SELECT count(*) FROM managed_bot_adapters')=='0';assert not r.container('worker')
request('/auth/login',{'username':'admin','password':(b/'admin-password').read_text()},port=43125)
assert r.sql(business,"SELECT count(*) FROM persona_jobs WHERE status IN ('pending','processing')")=='0';assert r.sql(business,"SELECT count(*) FROM conversation_jobs WHERE status IN ('pending','processing')")=='0';assert r.sql(business,"SELECT count(*) FROM group_onboarding_jobs WHERE status IN ('queued','working')")=='0';report['pending_model_and_greeting_jobs_not_replayed']=True
report['roundtrip']=json.loads((restore/'restore-validation.json').read_text());report['restored_file_matches']=True;report['restored_login_passed']=True
(b/'roundtrip-result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)

for directory in [b/"roundtrip",b/"empty"]:
 if (directory/"instance.json").exists():subprocess.run(m.Instance(directory).dc("down"),check=True)
