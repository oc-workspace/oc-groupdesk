import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {createBot,sqlIdentifier,ensureLegacyIsolation} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {initializeUserOwners} from '../server/user-access.js';
import {digest,token} from '../server/security.js';
import {syncAliases,botId,keyForAlias,reserveUsage,settleUsage,parseUsage} from '../server/key-vault.js';
import {executeKeyCall,proxyRoute,responseUsage} from '../server/model-proxy.js';
import {openControlSecret} from '../server/bot-secrets.js';
import type {ModelTransport} from '../server/model-transport.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',admin:any,a:any,b:any,botA='',botB='',privateId='',siteId='',privateAlias='',siteAlias='',group='',grantId='';const bots:string[]=[],secret='synthetic-private-key-123456',siteSecret='synthetic-site-key-654321';let wireCalls=0;
const transport:ModelTransport=async(url,key,protocol,body,timeout,signal,dispatched)=>{wireCalls++;if(body.messages?.[1]?.content==='请回复 OK。'){await dispatched?.();if(key==='synthetic-probe-failure-key')throw Error('模型请求失败（HTTP 503）');assert.equal(key,'synthetic-probe-success-key');return {text:JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:8,completion_tokens:1}}),contentType:'application/json'};}if(body.input==='请回复 OK。'){await dispatched?.();assert.equal(key,'synthetic-probe-responses-key');return {text:JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:8,output_tokens:1}}),contentType:'application/json'};}assert.equal(key,siteSecret);await dispatched?.();return {text:JSON.stringify({choices:[{message:{content:'Synthetic answer'}}],usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:20}}}),contentType:'application/json'};};
async function req(path:string,method='GET',body?:any,u=admin,bot?:string){const response=await fetch(base+'/api'+path,{method,headers:{...(u?{Cookie:u.cookie,'X-CSRF-Token':u.csrf}:{}),...(bot?{'X-GroupDesk-Bot':bot}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json().catch(()=>null),response};}
async function user(name:string){const id=randomUUID(),session=token(),csrf=token();await controlPool.query("INSERT INTO admins(id,username,password_hash,role,permissions) VALUES($1,$2,'!test-only','user',$3)",[id,name,{'models.manage':true,'groups.manage':true}]);await controlPool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);return {id,cookie:'groupdesk_session='+session,csrf};}
const limits=()=>({daily_requests:20,monthly_requests:100,daily_tokens:200000,monthly_tokens:1e6,daily_cost:10,monthly_cost:100,concurrency:2});
const grantBody=()=>({key_id:siteId,user_id:a.id,enabled:true,bot_ids:[botA],group_ids:[],model_ids:['synthetic-model'],features:['chat','summary','persona','topic','onboarding','analysis','interaction'],expires_at:new Date(Date.now()+86400000).toISOString(),limits:limits(),review_note:'Synthetic approval'});
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();await initializeUserOwners();server=createServer(createApp({modelTransport:transport}));await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const r=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD},null);admin={...r.data,cookie:r.response.headers.get('set-cookie')!.split(';')[0]};a=await user('synthetic-owner');b=await user('synthetic-other');
 for(const u of [a,b]){const id=await createBot({name:'Synthetic '+u.id,wechat_id:'synthetic-'+u.id,host_label:'test',notes:''},'admin').catch((e:any)=>{console.error('Synthetic fixture cause',e.cause?.message);throw e;});bots.push(id);await controlPool.query("UPDATE managed_bots SET owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[id,u.id]);}
 [botA,botB]=bots;await controlPool.query("UPDATE managed_bots SET state='paused' WHERE state='active'");await controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[botA]);await withBot(botA,async()=>{group=randomUUID();await pool.query("INSERT INTO groups(id,name,enabled,external_id) VALUES($1,'Synthetic group',true,$2)",[group,'bowxt-'+botA.replaceAll('-','')+':1']);});
});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of bots){const row=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH(FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}await controlPool.query('DROP OWNED BY gdr_00000000000040008000000000000001');await controlPool.query('DROP ROLE gdr_00000000000040008000000000000001');await pool.end();});
test('private owner reveal works while another user and super admin only receive last six characters',async()=>{
 const r=await req('/keys','POST',{name:'Private paid key',base_url:'https://api.example.com/v1',client_type:'openai',api_key:secret},a);assert.equal(r.status,201);privateId=r.data.id;
 assert.equal((await req('/keys/'+privateId+'/reveal','POST',{},a)).data.api_key,secret);
 for(const u of [admin,b]){const denied=await req('/keys/'+privateId+'/reveal','POST',{},u);assert.equal(denied.status,403);assert(!JSON.stringify(denied.data).includes(secret));}
 const list=(await req('/keys','GET',undefined,admin)).data.keys;const k=list.find((k:any)=>k.id===privateId);assert.equal(k.key_hint,'••••••123456');assert.equal(k.can_reveal,false);assert(!JSON.stringify(list).includes(secret));assert(!JSON.stringify(list).includes('secret_ciphertext'));
 assert(!(await req('/keys','GET',undefined,b)).data.keys.some((k:any)=>k.id===privateId));
 assert.equal((await req('/keys/'+privateId+'/reveal','POST',{},null)).status,401);
});
test('admin may add a private key for a user but never reveal or rotate it after saving',async()=>{
 const r=await req('/keys','POST',{name:'On behalf',scope:'private',owner_user_id:a.id,base_url:'https://api.example.com/v1',client_type:'openai',api_key:'synthetic-on-behalf-abcdef'},admin);assert.equal(r.status,201);
 assert.equal((await req('/keys/'+r.data.id+'/reveal','POST',{},admin)).status,403);assert.equal((await req('/keys/'+r.data.id+'/reveal','POST',{},a)).data.api_key,'synthetic-on-behalf-abcdef');
 const k=(await req('/keys','GET',undefined,admin)).data.keys.find((k:any)=>k.id===r.data.id);
 assert.equal((await req('/keys/'+k.id,'PUT',{revision:k.revision,name:k.name,scope:'site',base_url:k.base_url,client_type:k.client_type,api_key:'new-synthetic-key',enabled:true,archived:false,currency:'CNY',prices:{},limits:limits()},admin)).status,403);
});
test('private keys cannot be consumed from a different owner bot even by admin',async()=>{
 await withBot(botA,async()=>{await syncAliases();privateAlias=(await pool.query('SELECT id FROM model_credentials WHERE vault_key_id=$1',[privateId])).rows[0].id;const row=(await pool.query('SELECT key_ciphertext,key_hint FROM model_credentials WHERE id=$1',[privateAlias])).rows[0];assert.equal(row.key_ciphertext,'vault:v1');assert.equal(row.key_hint,'••••••123456');});
 await req('/keys/'+privateId+'/models','POST',{model_id:'synthetic-model',capability:'text'},a);
 await withBot(botB,async()=>{const k=(await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[privateId])).rows[0],id=randomUUID();await pool.query("INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type,vault_key_id) VALUES($1,'Forged reference',$2,'vault:v1',$3,$4,'openai',$5)",[id,k.base_url,k.key_hint,'forged',k.id]);await assert.rejects(reserveUsage(id,'synthetic-model',{feature:'chat'},10,100),/属于其他用户/);});
});
test('site key application, admin approval and assigned model choice are separate and validated',async()=>{
 const r=await req('/keys','POST',{name:'Site paid key',scope:'site',base_url:'https://api.example.com/v1',client_type:'openai',api_key:siteSecret},admin);siteId=r.data.id;assert.equal(r.status,201);await req('/keys/'+siteId+'/models','POST',{model_id:'synthetic-model',capability:'text'},admin);
 let k=(await req('/keys','GET',undefined,admin)).data.keys.find((k:any)=>k.id===siteId);assert.equal((await req('/keys/'+siteId,'PUT',{revision:k.revision,name:k.name,scope:k.scope,base_url:k.base_url,client_type:k.client_type,enabled:true,archived:false,currency:'CNY',prices:{'synthetic-model':{input:1,output:3,cached:.1}},limits:{...limits(),daily_requests:100,monthly_requests:1000}},admin)).status,200);
 assert(!(await req('/models','GET',undefined,a,botA)).data.credentials.some((c:any)=>c.vault_key_id===siteId));
 const request=await req('/keys/'+siteId+'/request','POST',{bot_id:botA,reason:'Synthetic group summaries',model_ids:['synthetic-model'],features:['chat','summary'],requested_limits:limits()},a);assert.equal(request.status,201);
 assert.equal((await req('/key-grants','PUT',grantBody(),a)).status,403);
 assert.equal((await req('/key-grants','PUT',{...grantBody(),request_id:request.data.id},admin)).status,200);
 const data=(await req('/keys','GET',undefined,a)).data;assert.equal(data.requests.find((x:any)=>x.id===request.data.id).status,'approved');grantId=data.grants.find((g:any)=>g.key_id===siteId).id;
 const overview=await req('/models','GET',undefined,a,botA);assert.equal(overview.status,200);siteAlias=overview.data.credentials.find((c:any)=>c.vault_key_id===siteId).id;assert(siteAlias);assert(!JSON.stringify(overview.data).includes(siteSecret));
});
test('owner can probe selected models across keys and see individual failures without exposing secrets',async()=>{
 const success=await req('/keys','POST',{name:'Chat probe key',base_url:'https://first.example.com/v1',client_type:'openai',api_key:'synthetic-probe-success-key'},a);assert.equal(success.status,201);
 await req('/keys/'+success.data.id+'/models','POST',{model_id:'synthetic-model',capability:'text'},a);
 const created=await req('/keys','POST',{name:'Responses probe key',base_url:'https://second.example.com/v1',client_type:'openai_responses',api_key:'synthetic-probe-responses-key'},a);assert.equal(created.status,201);
 await req('/keys/'+created.data.id+'/models','POST',{model_id:'synthetic-model',capability:'text'},a);
 const failed=await req('/keys','POST',{name:'Failed probe key',base_url:'https://third.example.com/v1',client_type:'openai',api_key:'synthetic-probe-failure-key'},a);assert.equal(failed.status,201);
 await req('/keys/'+failed.data.id+'/models','POST',{model_id:'synthetic-model',capability:'text'},a);
 const targets=[{key_id:success.data.id,model_id:'synthetic-model'},{key_id:created.data.id,model_id:'synthetic-model'},{key_id:failed.data.id,model_id:'synthetic-model'}];
 assert.equal((await req('/keys/probe','POST',{targets},b)).status,403);
 assert.equal((await req('/keys/probe','POST',{targets},admin)).status,403);
 assert.equal((await req('/keys/probe','POST',{targets:[targets[0],targets[0]]},a)).status,400);
 assert.equal((await req('/keys/probe','POST',{targets:[{key_id:success.data.id,model_id:'missing'}]},a)).status,400);
 const own=await req('/keys/probe','POST',{targets},a);assert.equal(own.status,200,JSON.stringify(own.data));assert.deepEqual(own.data.results.map((r:any)=>r.reachable),[true,true,false]);assert.match(own.data.results[2].error,/HTTP 503/);
 const usage=(await req('/key-usage','GET',undefined,a)).data.rows.filter((u:any)=>u.feature==='probe');assert.equal(usage.length,3);assert.deepEqual(usage.map((u:any)=>u.status).sort(),['completed','completed','unknown']);assert(usage.every((u:any)=>u.dispatched));
 const key=(await req('/keys','GET',undefined,a)).data.keys.find((k:any)=>k.id===success.data.id);
 assert.equal((await req('/keys/'+key.id,'PUT',{revision:key.revision,name:key.name,enabled:true,archived:false,scope:'private',base_url:key.base_url,client_type:key.client_type,currency:key.currency,prices:{},limits:{...limits(),daily_requests:1,daily_cost:null,monthly_cost:null}},a)).status,200);
 const before=wireCalls,limited=await req('/keys/probe','POST',{targets:[targets[0]]},a);assert.equal(limited.status,200);assert.equal(limited.data.results[0].reachable,false);assert.equal(wireCalls,before);assert.equal((await req('/key-usage','GET',undefined,a)).data.rows.filter((u:any)=>u.feature==='probe').length,3);
 assert(!JSON.stringify(own.data).includes(secret));assert(!JSON.stringify(own.data).includes('synthetic-probe-responses-key'));
});
test('all paid feature requests create usage; cached tokens and estimates settle without double counting',async()=>{
 await withBot(botA,async()=>{for(const feature of ['chat','summary','persona','topic','onboarding','analysis','interaction'])await executeKeyCall(siteAlias,'synthetic-model',{feature,groupId:group},{model:'synthetic-model',messages:[{role:'user',content:'Synthetic'}],max_tokens:100},1000,undefined,transport);});
 const usage=(await req('/key-usage','GET',undefined,a)).data.rows.filter((u:any)=>u.key_id===siteId);assert.equal(usage.length,7);for(const u of usage){assert.equal(u.status,'completed');assert.equal(Number(u.input_tokens),100);assert.equal(Number(u.output_tokens),10);assert.equal(Number(u.cached_tokens),20);assert.equal(Number(u.cost),112);}
 assert(!(await req('/key-usage','GET',undefined,b)).data.rows.some((u:any)=>u.key_id===siteId));
});
test('parallel reservations obey atomic limits and unknown usage keeps reserved quota',async()=>{
 await req('/key-grants','PUT',{...grantBody(),limits:{...limits(),concurrency:1}},admin);
 await withBot(botA,async()=>{const results=await Promise.allSettled([reserveUsage(siteAlias,'synthetic-model',{feature:'chat'},10,100),reserveUsage(siteAlias,'synthetic-model',{feature:'chat'},10,100)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const success=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>;await settleUsage(success.value,null,true,'synthetic_timeout');});
 const row=(await req('/key-usage','GET',undefined,a)).data.rows[0];assert.equal(row.status,'unknown');assert.equal(row.input_tokens,null);assert(Number(row.reserved_tokens)>0);
 await req('/key-grants','PUT',grantBody(),admin);
});
test('gateway gives expiring substitute credential, never the paid key, and checks group/model live',async()=>{
 await withBot(botA,async()=>{const route={credential_id:siteAlias,model_id:'synthetic-model',client_type:'openai',credential_revision:1},p=await proxyRoute(route,group);assert(!p.api_key.includes(siteSecret));assert(p.base_url.includes('/api/model-proxy/v1'));const claim=JSON.parse(openControlSecret(p.api_key));assert.equal(claim.group,group);
 const call=async(model='synthetic-model')=>fetch(base+'/api/model-proxy/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+p.api_key,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Synthetic'}],max_tokens:100})});assert.equal((await call('wrong-model')).status,403);assert.equal((await call()).status,200);
 await controlPool.query('UPDATE managed_model_grants SET enabled=false WHERE id=$1',[grantId]);assert.equal((await call()).status,403);await controlPool.query('UPDATE managed_model_grants SET enabled=true WHERE id=$1',[grantId]);await pool.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[group]);assert.equal((await call()).status,409);
 });
});
test('scope, expiry, unsupported models and quota failures are rejected before transmission',async()=>{
 const before=wireCalls;
 await req('/key-grants','PUT',{...grantBody(),features:['summary'],group_ids:[group]},admin);
 await withBot(botA,async()=>{await assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'chat',groupId:group},{model:'synthetic-model',max_tokens:10},1000,undefined,transport));await assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'summary'},{model:'synthetic-model',max_tokens:10},1000,undefined,transport));});assert.equal(wireCalls,before);
 await controlPool.query("UPDATE managed_model_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[grantId]);await withBot(botA,async()=>assert.rejects(reserveUsage(siteAlias,'synthetic-model',{feature:'summary',groupId:group},1,10)));assert.equal(wireCalls,before);
});
test('usage parsers support Responses, Chat, Gemini thinking, and streamed final usage',()=>{
 assert.deepEqual(parseUsage({usage:{input_tokens:50,output_tokens:12,input_tokens_details:{cached_tokens:10}}}),{input:50,output:12,cached:10});assert.deepEqual(parseUsage({usageMetadata:{promptTokenCount:40,candidatesTokenCount:5,thoughtsTokenCount:7,cachedContentTokenCount:3}}),{input:40,output:12,cached:3});
 assert.deepEqual(parseUsage(responseUsage('data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\ndata: [DONE]\n')),{input:4,output:2,cached:0});assert.equal(parseUsage({usage:{input_tokens:-1,output_tokens:2}}),null);
});
test('daily money and request limits reject before dispatch, with currency units applied correctly',async()=>{
 const before=wireCalls;
 assert.equal((await req('/key-grants','PUT',{...grantBody(),limits:{...limits(),daily_cost:.00001}},admin)).status,200);
 await withBot(botA,()=>assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'chat',groupId:group},{model:'synthetic-model',max_tokens:100},1000,undefined,transport),/额度不足/));assert.equal(wireCalls,before);
 await req('/key-grants','PUT',{...grantBody(),limits:{...limits(),daily_requests:1}},admin);await withBot(botA,()=>assert.rejects(reserveUsage(siteAlias,'synthetic-model',{feature:'chat'},10,100),/额度不足/));assert.equal(wireCalls,before);await req('/key-grants','PUT',grantBody(),admin);
});
test('high concurrency does not exhaust the control connection pool or oversubscribe the limit',async()=>{
 await withBot(botA,async()=>{const results=await Promise.allSettled(Array.from({length:16},()=>reserveUsage(siteAlias,'synthetic-model',{feature:'chat'},2,10)));const successful=results.filter((r):r is PromiseFulfilledResult<any>=>r.status==='fulfilled');assert.equal(successful.length,2);await Promise.all(successful.map(r=>settleUsage(r.value,null,false)));});
});
test('unknown usage requires privileged reconciliation and updates visible quota with an audit trail',async()=>{
 const row=(await req('/key-usage','GET',undefined,a)).data.rows.find((r:any)=>r.status==='unknown');assert(row);
 const body={input:40,output:5,cached:0,cost:.000055,note:'Synthetic provider invoice'};assert.equal((await req('/key-usage/'+row.id+'/reconcile','POST',body,a)).status,403);assert.equal((await req('/key-usage/'+row.id+'/reconcile','POST',body,admin)).status,200);assert.equal((await req('/key-usage/'+row.id+'/reconcile','POST',body,admin)).status,409);
 const report=(await req('/key-usage','GET',undefined,a)).data;assert(report.summary.length);assert(report.quota.length);assert.equal(report.rows.find((r:any)=>r.id===row.id).status,'completed');assert.equal(Number(report.rows.find((r:any)=>r.id===row.id).cost),55);
});
test('provider disconnects reserve unknown charges, while a failure before dispatch releases reservation',async()=>{
 await withBot(botA,async()=>{for(const dispatch of [false,true]){await assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'chat'}, {model:'synthetic-model',max_tokens:10},1000,undefined,async(url,key,p,b,t,s,send)=>{if(dispatch)await send?.();throw Error('synthetic disconnect');}));const r=(await controlPool.query('SELECT * FROM managed_model_usage ORDER BY created_at DESC LIMIT 1')).rows[0];assert.equal(r.status,dispatch?'unknown':'failed');}});
});
test('unsupported paid tools and multimodal inputs cannot bypass site accounting',async()=>{
 const before=wireCalls;await withBot(botA,async()=>{await assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'chat'},{model:'synthetic-model',tools:[{type:'web_search'}]},1000,undefined,transport));await assert.rejects(executeKeyCall(siteAlias,'synthetic-model',{feature:'chat'},{model:'synthetic-model',messages:[{content:[{type:'image_url',image_url:{url:'https://example.com/image.png'}}]}]},1000,undefined,transport));});assert.equal(wireCalls,before);
});
test('key disable and bot ownership transfer invalidate existing selection immediately without exposing a secret',async()=>{
 await controlPool.query('UPDATE managed_model_keys SET enabled=false WHERE id=$1',[siteId]);await withBot(botA,()=>assert.rejects(reserveUsage(siteAlias,'synthetic-model',{feature:'chat'},1,10),/停用/));await controlPool.query('UPDATE managed_model_keys SET enabled=true WHERE id=$1',[siteId]);
 await controlPool.query('UPDATE managed_bots SET owner_user_id=$2 WHERE id=$1',[botA,b.id]);await withBot(botA,()=>assert.rejects(reserveUsage(privateAlias,'synthetic-model',{feature:'chat'},1,10),/属于其他用户/));await controlPool.query('UPDATE managed_bots SET owner_user_id=$2 WHERE id=$1',[botA,a.id]);assert.equal((await req('/keys/'+privateId+'/reveal','POST',{},admin)).status,403);
});

test('unconfigured routes are disabled and never silently fall back to a pre-existing runtime key',async()=>{await withBot(botA,async()=>{const routes=await (await import('../server/models.js')).effectiveModelRoutes({model_routes:{text:{mode:'inherit'},image:{mode:'inherit'}}});assert.equal(routes.text.source,'disabled');assert.equal(routes.text.available,false);assert(Object.values(routes.stages).every((r:any)=>r.source==='disabled'));});});
test('unpriced history is never displayed or budgeted as zero money; owner can reconcile before enabling spending',async()=>{
 await withBot(botA,async()=>{await executeKeyCall(privateAlias,'synthetic-model',{feature:'chat'}, {model:'synthetic-model',max_tokens:10},1000,undefined,async(url,key,p,b,t,s,dispatch)=>{assert.equal(key,secret);await dispatch?.();return {text:JSON.stringify({usage:{prompt_tokens:10,completion_tokens:1}}),contentType:'application/json'};});});
 let report=(await req('/key-usage','GET',undefined,a)).data;const summary=report.summary.find((s:any)=>s.key_id===privateId);assert.equal(summary.cost,null);assert.equal(summary.unknown_requests,1);const row=report.rows.find((r:any)=>r.key_id===privateId);
 const k=(await req('/keys','GET',undefined,a)).data.keys.find((k:any)=>k.id===privateId);assert.equal((await req('/keys/'+privateId,'PUT',{revision:k.revision,name:k.name,enabled:true,archived:false,scope:'private',base_url:k.base_url,client_type:k.client_type,currency:k.currency,prices:{'synthetic-model':{input:1,output:3}},limits:{...limits(),daily_cost:1}},a)).status,200);
 await withBot(botA,()=>assert.rejects(reserveUsage(privateAlias,'synthetic-model',{feature:'chat'},1,10),/历史用量尚未定价或核对/));
 assert.equal((await req('/key-usage/'+row.id+'/reconcile','POST',{input:10,output:1,cached:0,cost:.000013,note:'Synthetic price reconciliation'},a)).status,200);
 await withBot(botA,async()=>{const r=await reserveUsage(privateAlias,'synthetic-model',{feature:'chat'},1,10);await settleUsage(r,null,false);});
});
