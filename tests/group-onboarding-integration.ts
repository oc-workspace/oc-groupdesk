import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {pool,controlPool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {sealKey} from '../server/model-security.js';
import {legacyBotId} from '../server/bot-context.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,url='',cookie='',csrf='',a:any,b:any,ta='',tb='',chosen:any,discoverId='',connectId='',created:any[]=[];
const instances=new Map<string,string>();let aiOutput:any;
async function req(path:string,method='GET',body?:any,botId?:string,token?:string){const r=await fetch(url+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(botId?{'X-GroupDesk-Bot':botId}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function bot(name:string){const r=await req('/bots','POST',{name,wechat_id:'wx_'+name,host_label:'synthetic',notes:''});assert.equal(r.status,201);const id=r.data.id;created.push(id);instances.set(id,randomUUID());const row=await botRecord(id);const token=(await req('/bots/'+id+'/connection-token','POST',{revision:row.revision})).data.token;await controlPool.query("UPDATE managed_bots SET state='paused',runtime_instance_id=$2,account_fingerprint=$3 WHERE id=$1",[id,instances.get(id),id.replaceAll('-','').repeat(2)]);return {id,token};}
function identity(id:string){return {contract:1,instance_id:instances.get(id),account_fingerprint:id.replaceAll('-','').repeat(2)};}
async function claim(id=a.id,token=ta){const r=await req('/runtime/group-onboarding/claim','POST',{...identity(id),version:'1'},undefined,token);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.task;}
async function report(task:any,result:any,status='succeeded',extra:any={}){return req('/runtime/group-onboarding/report','POST',{...identity(a.id),id:task.id,lease_token:task.lease_token,stage:'ready',status,result,...extra},undefined,ta);}
async function overview(id=a.id){return (await req('/overview','GET',undefined,id)).data;}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();server=createServer(createApp({topicDraftCaller:async()=>({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(aiOutput)}]}]})}));await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const r=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=r.response.headers.get('set-cookie')!.split(';')[0];csrf=r.data.csrf;a=await bot('Onboard_A');b=await bot('Onboard_B');ta=a.token;tb=b.token;await controlPool.query("UPDATE managed_bots SET state='paused' WHERE state='active'");await controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[a.id]);
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of created){const b=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(b.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(b.db_role));}const legacy=await botRecord(legacyBotId);if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}await pool.end();});
test('requires login, CSRF, an active bot and a bound local agent',async()=>{
 assert.equal((await fetch(url+'/api/group-onboarding')).status,401);
 assert.equal((await fetch(url+'/api/group-onboarding/discover',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-GroupDesk-Bot':a.id},body:JSON.stringify({request_id:randomUUID()})})).status,403);
 assert.equal((await req('/group-onboarding/discover','POST',{request_id:randomUUID()},a.id)).status,409);
 assert.equal((await req('/runtime/group-onboarding/claim','POST',{...identity(b.id),version:'1'},undefined,ta)).status,403);
 assert.equal((await req('/runtime/group-onboarding/claim','POST',{...identity(a.id),version:'1'},b.id,ta)).status,403);
 assert.equal(await claim(),null);assert.equal((await req('/group-onboarding','GET',undefined,a.id)).status,200);
});
test('discovery is metadata-only, idempotent and scoped; candidate lists from another robot are rejected',async()=>{
 const request={request_id:randomUUID()};const r=await req('/group-onboarding/discover','POST',request,a.id);assert.equal(r.status,202);discoverId=r.data.id;assert.equal((await req('/group-onboarding/discover','POST',request,a.id)).data.id,discoverId);
 const task=await claim();assert.equal(task.kind,'discover');assert.equal(await claim(),null);
 const native='synthetic_room@chatroom';chosen={id:createHash('sha256').update(a.id+'\0'+native).digest('hex'),native_id:native,name:'Synthetic new group',ambiguous:false,external_id:null};
 assert.equal((await report(task,{candidates:[{...chosen,chat_history:['forbidden']}]})).status,400);
 assert.equal((await report(task,{candidates:[chosen]})).status,200);
 assert.equal((await req('/group-onboarding/jobs/'+discoverId,'GET',undefined,b.id)).status,404);
 const input={request_id:randomUUID(),discovery_id:discoverId,candidate_id:chosen.id,confirmation:{joined:true,scope:true},config:{}};assert.equal((await req('/runtime/group-onboarding/claim','POST',{...identity(b.id),version:'1'},undefined,tb)).status,403);
 assert.equal((await req('/group-onboarding/connect','POST',input,b.id)).status,409);
});
let cfg:any,topic:string;
test('validated config creates one disabled draft; forged IDs and unknown authority fields cannot cross workspaces',async()=>{
 const oa=await overview(),ob=await overview(b.id);topic=oa.topics[0].id;
 cfg={name:chosen.name,topic_ids:[topic],kb_ids:[],participation:'quiet',topic_scope:'proactive',language:'auto',model_routes:{text:{mode:'inherit'},image:{mode:'inherit'}},base_version_id:null,features:[],source_group_id:null,enable:true};
 const body={request_id:randomUUID(),discovery_id:discoverId,candidate_id:chosen.id,confirmation:{joined:true,scope:true},config:cfg};
 assert.equal((await req('/group-onboarding/connect','POST',{...body,config:{...cfg,topic_ids:[ob.topics[0].id]}},a.id)).status,400);
 assert.equal((await req('/group-onboarding/connect','POST',{...body,config:{...cfg,external_id:'forged'}},a.id)).status,400);
 const results=await Promise.all([req('/group-onboarding/connect','POST',body,a.id),req('/group-onboarding/connect','POST',body,a.id)]);assert(results.every(r=>r.status===202),JSON.stringify(results));connectId=results[0].data.id;assert.equal(results[1].data.id,connectId);
 const groups=(await overview()).groups;assert.equal(groups.length,1);assert.equal(groups[0].enabled,false);assert.equal(groups[0].external_id,null);
 assert.equal((await req('/group-onboarding/connect','POST',{...body,request_id:randomUUID()},a.id)).status,409);
});
test('failed jobs remain disabled and can retry, with new lease rejecting stale or forged runtime reports',async()=>{
 const first=await claim();assert.equal(first.id,connectId);assert.equal(first.candidate.native_id,chosen.native_id);
 assert.equal((await report({...first,lease_token:randomUUID()},{},'failed',{error_code:'busy'})).status,409);
 assert.equal((await report(first,{},'failed',{error_code:'busy'})).status,200);
 const r=await req('/group-onboarding/jobs/'+connectId,'GET',undefined,a.id);assert.equal(r.data.group.enabled,false);assert.match(r.data.error,/在途任务/);
 assert.equal((await req('/group-onboarding/jobs/'+connectId+'/retry','POST',{},a.id)).status,200);
 const second=await claim();assert.notEqual(second.lease_token,first.lease_token);
 assert.equal((await report(first,{})).status,409);
 const external='bowxt-'+a.id.replaceAll('-','')+':2';assert.equal((await report(second,{external_id:'bowxt-'+b.id.replaceAll('-','')+':2',chat_id:2})).status,400);
 assert.equal((await report(second,{external_id:external,chat_id:2,wechat:true,reader:true,sender:true})).status,200);
 const finished=(await req('/group-onboarding/jobs/'+connectId,'GET',undefined,a.id)).data;assert.equal(finished.status,'succeeded');assert.equal(finished.group.enabled,true);assert.equal(finished.group.revision,2);assert.equal(finished.ready,false);
 const adapter=(await controlPool.query('SELECT group_external_ids FROM managed_bot_adapters WHERE bot_id=$1',[a.id])).rows[0];assert.deepEqual(adapter.group_external_ids,[external]);assert.deepEqual((await overview(b.id)).groups,[]);
});
test('final acknowledgement and greeting/verify actions stay separate; concurrent repeated greetings share one task',async()=>{
 assert.equal((await req('/group-onboarding/jobs/'+connectId+'/greeting','POST',{request_id:randomUUID(),confirmed:true},a.id)).status,409);
 await withBot(a.id,async()=>{await pool.query('UPDATE groups SET applied_revision=revision');});
 const parent=(await req('/group-onboarding/jobs/'+connectId,'GET',undefined,a.id)).data;assert.equal(parent.ready,true);
 const results=await Promise.all([req('/group-onboarding/jobs/'+connectId+'/greeting','POST',{request_id:randomUUID(),confirmed:true},a.id),req('/group-onboarding/jobs/'+connectId+'/greeting','POST',{request_id:randomUUID(),confirmed:true},a.id)]);assert(results.every(r=>r.status===202));assert.equal(results[0].data.id,results[1].data.id);
 const task=await claim();assert.equal(task.kind,'greeting');assert.equal((await report(task,{greeting_status:'sent'})).status,200);
 assert.equal((await req('/group-onboarding/jobs/'+connectId+'/greeting','POST',{request_id:randomUUID(),confirmed:true},a.id)).data.id,task.id);
 assert.equal((await req('/group-onboarding/jobs/'+task.id+'/retry','POST',{},a.id)).status,409);
 const check=await req('/group-onboarding/jobs/'+connectId+'/verify','POST',{request_id:randomUUID(),confirmed:true},a.id);assert.equal(check.status,202);const verify=await claim();assert.equal(verify.kind,'verify');assert.equal((await report(verify,{wechat:true,reader:true,sender:true})).status,200);
});
test('model helper default is independent and AI cannot choose foreign IDs or enable groups',async()=>{
 let key='';await withBot(a.id,async()=>{key=randomUUID();await pool.query("INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type) VALUES($1,'maibot-gpt','https://example.com/v1',$2,'synthetic','synthetic','openai_responses')",[key,sealKey('synthetic-not-real')]);await pool.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,'gpt-6-luna','gpt-6-luna','text','manual')",[key]);});
 let models=(await req('/models','GET',undefined,a.id)).data;const before=(await overview()).groups.map((g:any)=>g.revision);
 assert.equal((await req('/model-defaults','PUT',{revision:models.defaults.revision,routes:{...models.defaults.routes,onboarding:{credential_id:key,model_id:'gpt-6-luna'}}},a.id)).status,200);assert.deepEqual((await overview()).groups.map((g:any)=>g.revision),before);
 aiOutput={topic_ids:[topic],participation:'quiet',topic_scope:'proactive',language:'auto',base_version_id:null,explanation:'Synthetic recommendation'};
 const body={prompt:'A quiet technical group',discovery_id:discoverId,candidate_id:chosen.id};assert.equal((await req('/group-onboarding/suggest','POST',body,a.id)).status,200);
 aiOutput={...aiOutput,topic_ids:[randomUUID()]};assert.equal((await req('/group-onboarding/suggest','POST',body,a.id)).status,502);assert.deepEqual((await overview()).groups.map((g:any)=>g.revision),before);
});
test('expired discovery and cancelled jobs are explicit, never creating a new group automatically',async()=>{
 await withBot(a.id,()=>pool.query("UPDATE group_onboarding_jobs SET updated_at=now()-interval '20 minutes' WHERE id=$1",[discoverId]));
 assert.equal((await req('/group-onboarding/suggest','POST',{prompt:'expired',discovery_id:discoverId,candidate_id:chosen.id},a.id)).status,409);
 const pending=await req('/group-onboarding/discover','POST',{request_id:randomUUID()},a.id);assert.equal((await req('/group-onboarding/jobs/'+pending.data.id+'/cancel','POST',{},a.id)).data.status,'cancelled');assert.equal(await claim(),null);assert.equal((await overview()).groups.length,1);
});
test('upgrade selects maibot-gpt / gpt-5.5 once and preserves all previous chat defaults',async()=>{
 await withBot(b.id,async()=>{
  const key=randomUUID();await pool.query("INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type) VALUES($1,'maibot-gpt','https://example.com/v1',$2,'synthetic','seed-synthetic','openai_responses')",[key,sealKey('synthetic-seed-only')]);await pool.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,'gpt-6-luna','gpt-6-luna','text','manual'),($1,'gpt-5.5','gpt-5.5','text','manual')",[key]);
  const before=(await pool.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes;
  await pool.query("DROP TABLE group_onboarding_bindings,group_onboarding_jobs,group_onboarding_agent;DELETE FROM schema_migrations WHERE name IN ('019_group_onboarding.sql','020_onboarding_model_default.sql');UPDATE model_settings SET routes=routes-'onboarding'");
  await migrate({controlPlane:false,bootstrapAdmin:false});let current=(await pool.query('SELECT routes,revision FROM model_settings WHERE singleton=true')).rows[0];assert.deepEqual(current.routes.onboarding,{credential_id:key,model_id:'gpt-5.5'});assert.deepEqual(current.routes.text,before.text);assert.deepEqual(current.routes.image,before.image);
  const revision=current.revision;await migrate({controlPlane:false,bootstrapAdmin:false});current=(await pool.query('SELECT revision FROM model_settings WHERE singleton=true')).rows[0];assert.equal(current.revision,revision);
  await pool.query("UPDATE model_settings SET routes=jsonb_set(routes,'{onboarding}',jsonb_build_object('credential_id',$1::text,'model_id','gpt-custom'))",[key]);await pool.query("DELETE FROM schema_migrations WHERE name='020_onboarding_model_default.sql'");await migrate({controlPlane:false,bootstrapAdmin:false});assert.equal((await pool.query('SELECT routes FROM model_settings')).rows[0].routes.onboarding.model_id,'gpt-custom');
 });
});
test('template copies keep full restricted language and follow flags without changing the source group',async()=>{
 const original=(await overview()).groups[0];const restricted={mode:'restricted',allowed:['en','ja'],fallback:'ja',allow_requested:false};const policy={...original.policy,language:restricted};
 await withBot(a.id,()=>pool.query('UPDATE groups SET policy=$2,allow_language_override=false WHERE id=$1',[original.id,policy]));
 const discovery=await req('/group-onboarding/discover','POST',{request_id:randomUUID()},a.id);const task=await claim();const native='another_synthetic_room@chatroom';const c={...chosen,name:'Another synthetic group',native_id:native,id:createHash('sha256').update(a.id+'\0'+native).digest('hex')};assert.equal((await report(task,{candidates:[c]})).status,200);
 const r=await req('/group-onboarding/connect','POST',{request_id:randomUUID(),discovery_id:discovery.data.id,candidate_id:c.id,confirmation:{joined:true,scope:true},config:{...cfg,name:c.name,language:'source',source_group_id:original.id,base_follow_latest:false}},a.id);assert.equal(r.status,202,JSON.stringify(r.data));
 const groups=(await overview()).groups;const copy=groups.find((g:any)=>g.id===r.data.group.id);assert.deepEqual(copy.policy.language,restricted);assert.equal(copy.allow_language_override,false);assert.equal(copy.enabled,false);assert.deepEqual(groups.find((g:any)=>g.id===original.id).policy,policy);
 await req('/group-onboarding/jobs/'+r.data.id+'/cancel','POST',{},a.id);
});

test('named discovery validates input and agent capability, carries exact query and records an empty result without binding',async()=>{
 assert.equal((await req('/group-onboarding/discover','POST',{request_id:randomUUID(),group_name:'   '},a.id)).status,400);
 assert.equal((await req('/group-onboarding/discover','POST',{request_id:randomUUID(),group_name:'Shanghai Entrepreneurs Meetup'},a.id)).status,409);
 assert.equal((await req('/runtime/group-onboarding/claim','POST',{...identity(a.id),version:'2'},undefined,ta)).status,200);
 const body={request_id:randomUUID(),group_name:'  Shanghai Entrepreneurs Meetup  '};const before=(await overview()).groups;
 const job=await req('/group-onboarding/discover','POST',body,a.id);assert.equal(job.status,202);assert.equal(job.data.requested_group_name,'Shanghai Entrepreneurs Meetup');assert.equal((await req('/group-onboarding/discover','POST',body,a.id)).data.id,job.data.id);
 const task=(await req('/runtime/group-onboarding/claim','POST',{...identity(a.id),version:'2'},undefined,ta)).data.task;assert.equal(task.group_name,'Shanghai Entrepreneurs Meetup');assert.equal((await report(task,{candidates:[]})).status,200);
 const done=(await req('/group-onboarding/jobs/'+job.data.id,'GET',undefined,a.id)).data;assert.equal(done.status,'succeeded');assert.equal(done.requested_group_name,'Shanghai Entrepreneurs Meetup');assert.deepEqual(done.result.candidates,[]);assert.deepEqual((await overview()).groups,before);
});
