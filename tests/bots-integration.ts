import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import pg from 'pg';
import {readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pool,controlPool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord,botScope} from '../server/bot-workspaces.js';
import {legacyBotId,dataDirectory} from '../server/bot-context.js';
import {sealKey,openKey} from '../server/model-security.js';
import {openControlSecret} from '../server/bot-secrets.js';
import {materialRoot} from '../server/persona-materials.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,url='',cookie='',csrf='',a:any,b:any,ta='',tb='';const created:string[]=[];
const legacyInstance=randomUUID(),ai=randomUUID(),bi=randomUUID();
async function req(path:string,method='GET',body?:any,botId?:string,botToken?:string){const response=await fetch(url+'/api'+path,{method,headers:{...(botToken?{Authorization:'Bearer '+botToken}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(botId?{'X-GroupDesk-Bot':botId}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),response};}
async function directory(){return (await req('/bots')).data;}
async function record(id:string){return (await directory()).bots.find((x:any)=>x.id===id);}
async function create(name:string){const r=await req('/bots','POST',{name,wechat_id:'wx_'+name,host_label:'synthetic-host',notes:''});assert.equal(r.status,201,JSON.stringify(r.data));created.push(r.data.id);return record(r.data.id);}
async function tokenFor(bot:any){const r=await req('/bots/'+bot.id+'/connection-token','POST',{revision:(await record(bot.id)).revision});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.token;}
async function heartbeat(id:string,token:string,extra:any={}){const row=await record(id);return req('/runtime/bot-heartbeat','POST',{contract:1,bot_id:id,instance_id:id===legacyBotId?legacyInstance:id===a.id?ai:bi,account_fingerprint:(id===legacyBotId?'a':id===a.id?'b':'c').repeat(64),revision:row.revision,wechat_connected:true,reader_connected:true,maibot_connected:true,sender_queue_depth:0,active_turns:0,send_inflight:false,stopped:row.state!=='active',cutover_generation:row.activation_generation,local_ready:true,...extra},undefined,token);}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
});
after(async()=>{
 if(server)await new Promise<void>(r=>server.close(()=>r()));
 await closeBusinessPools();
 for(const id of created){const r=await botRecord(id);if(r?.db_name){await controlPool.query('DROP DATABASE '+sqlIdentifier(r.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(r.db_role));}}
 const legacy=await botRecord(legacyBotId);if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}
 await pool.end();
});
test('legacy migration registers RyuBuddy once without altering existing groups or enabling another bot',async()=>{
 await migrate();await ensureLegacyIsolation();const d=await directory();assert.equal(d.bots.length,1);assert.equal(d.bots[0].wechat_id,'RyuBuddy');assert.equal(d.bots[0].state,'active');
 const legacy=(await req('/overview')).data;assert.equal(legacy.groups.length,2);assert(legacy.groups.every((g:any)=>g.enabled===false));
 const secret=JSON.stringify(d);for(const field of ['db_password','model_key','token_hash','connectionString'])assert(!secret.includes(field));
 assert.equal((await fetch(url+'/api/bots')).status,401);
});
test('business role cannot read control secrets, sessions or password hashes',async()=>{
 await withBot(legacyBotId,async()=>{await assert.rejects(pool.query('SELECT * FROM managed_bots'),{code:'42501'});await assert.rejects(pool.query('SELECT * FROM sessions'),{code:'42501'});await assert.rejects(pool.query('SELECT password_hash FROM admins'),{code:'42501'});assert((await pool.query('SELECT id,username FROM admins')).rowCount);});
});
test('new bots get empty, independent databases, roots and model master keys',async()=>{
 a=await create('Synthetic_A');b=await create('Synthetic_B');assert.equal(a.state,'paused');assert.equal(b.state,'paused');
 for(const bot of [a,b]){const d=(await req('/overview','GET',undefined,bot.id)).data;assert.equal(d.groups.length,0);assert.equal(d.knowledge_bases.length,0);assert.equal(d.model_config.credentials.length,0);assert.equal((await req('/persona-studio','GET',undefined,bot.id)).data.personas.length,0);}
 const [sa,sb]=await Promise.all([botScope(a.id),botScope(b.id)]);assert.notEqual(sa.dataDirectory,sb.dataDirectory);assert.notEqual(sa.modelKey,sb.modelKey);
 const encoded=await withBot(a.id,async()=>sealKey('synthetic-key-plaintext'));await withBot(b.id,async()=>assert.throws(()=>openKey(encoded)));
 assert.notEqual(await withBot(a.id,async()=>materialRoot()),await withBot(b.id,async()=>materialRoot()));
 const r=await botRecord(a.id),u=new URL(process.env.DATABASE_URL!);u.username=r.db_role;u.password=openControlSecret(r.db_password_ciphertext);
 const client=new pg.Client({connectionString:u.href});await assert.rejects(client.connect(),{code:'42501'});await client.end();
});
test('same external chat identifiers and concurrent requests stay in the selected robot',async()=>{
 for(const [bot,name] of [[a,'Alpha only'],[b,'Beta only']] as const){const c=await req('/groups','POST',{name},bot.id);assert.equal(c.status,201);const o=(await req('/overview','GET',undefined,bot.id)).data;const g=o.groups[0];const r=await req('/groups/'+g.id,'PUT',{...g,external_id:'same-local-chat',enabled:true,topic_ids:[o.topics[0].id]},bot.id);assert.equal(r.status,200,JSON.stringify(r.data));}
 const many=await Promise.all(Array.from({length:24},(_,i)=>req('/overview','GET',undefined,i%2?a.id:b.id)));
 many.forEach((r,i)=>{assert.equal(r.status,200);assert.deepEqual(r.data.groups.map((g:any)=>g.name),[i%2?'Alpha only':'Beta only']);});
 const ga=(await req('/overview','GET',undefined,a.id)).data.groups[0];assert.equal((await req('/groups/'+ga.id,'PUT',ga,b.id)).status,404);
 assert.equal((await req('/overview','GET',undefined,randomUUID())).status,404);
});
test('knowledge object IDs and uploaded files cannot cross business roots',async()=>{
 const r=await req('/knowledge','POST',{name:'A private knowledge',description:''},a.id);assert.equal(r.status,201);const id=r.data.id;
 assert.equal((await req('/knowledge/'+id+'/text','POST',{title:'Synthetic A',content:'This belongs only to A.'},a.id)).status,201);
 assert.equal((await req('/knowledge/'+id+'/text','POST',{title:'Wrong',content:'Must not reach A'},b.id)).status,400);
 const k=(await req('/overview','GET',undefined,b.id)).data.knowledge_bases;assert.equal(k.length,0);
 const dirs=await Promise.all([withBot(a.id,async()=>dataDirectory()),withBot(b.id,async()=>dataDirectory())]);await mkdir(join(dirs[0],'uploads'),{recursive:true});await mkdir(join(dirs[1],'uploads'),{recursive:true});
 assert.notEqual(dirs[0],dirs[1]);
});
test('adapter tokens are robot-scoped, paused robots cannot obtain runtime data, headers cannot redirect them',async()=>{
 ta=await tokenFor(a);tb=await tokenFor(b);
 for(const bot of [a,b])assert.equal((await req('/bots/'+bot.id+'/connection-groups','PUT',{external_ids:['same-local-chat']})).status,200);
 assert.equal((await req('/runtime/bot-state','GET',undefined,undefined,ta)).data.bot_id,a.id);
 assert.equal((await req('/runtime/config/same-local-chat','GET',undefined,undefined,ta)).status,403);
 assert.equal((await req('/runtime/bot-state','GET',undefined,b.id,ta)).status,403);
 assert.equal((await heartbeat(a.id,ta,{bot_id:b.id})).status,403);
 assert.equal((await heartbeat(a.id,ta)).status,200);assert.equal((await heartbeat(b.id,tb)).status,200);assert.equal((await heartbeat(legacyBotId,process.env.BOT_API_TOKEN!)).status,200);
 assert.equal((await heartbeat(a.id,ta,{instance_id:randomUUID()})).status,409);assert.equal((await heartbeat(a.id,ta,{account_fingerprint:'d'.repeat(64)})).status,409);
});
test('activation waits for the prior runtime acknowledgment, including queue, active work and exact revision',async()=>{
 const r=await req('/bots/'+a.id+'/activate','POST',{revision:(await record(a.id)).revision});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal((await record(legacyBotId)).state,'pausing');assert.equal((await record(a.id)).state,'paused');
 for(const extra of [{sender_queue_depth:1},{active_turns:1},{send_inflight:true},{revision:1}]){await heartbeat(legacyBotId,process.env.BOT_API_TOKEN!,{stopped:true,...extra});assert.equal((await record(legacyBotId)).state,'pausing');assert.equal((await record(a.id)).state,'paused');}
 assert.equal((await heartbeat(legacyBotId,process.env.BOT_API_TOKEN!,{stopped:true})).status,200);assert.equal((await record(legacyBotId)).state,'paused');assert.equal((await record(a.id)).state,'active');assert.equal((await record(a.id)).activation_generation,1);
 assert.equal((await req('/runtime/config/same-local-chat','GET',undefined,undefined,ta)).status,200);assert.equal((await req('/runtime/config/same-local-chat','GET',undefined,undefined,tb)).status,403);
 const d=(await directory()).bots;assert.equal(d.filter((x:any)=>x.state==='active').length,1);
});
test('pausing and archiving preserve data, refuse premature activation and invalidate runtime access',async()=>{
 const current=await record(a.id);assert.equal((await req('/bots/'+a.id+'/archive','POST',{revision:current.revision})).status,409);
 assert.equal((await req('/bots/'+a.id+'/pause','POST',{revision:current.revision})).status,200);assert.equal((await req('/runtime/config/same-local-chat','GET',undefined,undefined,ta)).status,403);
 assert.equal((await heartbeat(a.id,ta,{stopped:true})).status,200);assert.equal((await record(a.id)).state,'paused');
 const before=(await req('/overview','GET',undefined,a.id)).data;assert.equal(before.groups[0].name,'Alpha only');
 assert.equal((await req('/bots/'+a.id+'/archive','POST',{revision:(await record(a.id)).revision})).status,200);assert.equal((await req('/overview','GET',undefined,a.id)).status,409);
 assert.equal((await req('/bots/'+a.id+'/restore','POST',{revision:(await record(a.id)).revision})).status,200);assert.equal((await req('/overview','GET',undefined,a.id)).data.groups[0].name,'Alpha only');
 await heartbeat(b.id,tb,{revision:1});assert.equal((await req('/bots/'+b.id+'/activate','POST',{revision:(await record(b.id)).revision})).status,409);
 await heartbeat(b.id,tb,{wechat_connected:false});assert.equal((await req('/bots/'+b.id+'/activate','POST',{revision:(await record(b.id)).revision})).status,409);
});
test('a bound account cannot be renamed into a different WeChat account and stale revisions cannot change state',async()=>{
 const row=await record(a.id);const input={name:row.name,wechat_id:'another_account',host_label:row.host_label,notes:row.notes,revision:row.revision};assert.equal((await req('/bots/'+a.id,'PUT',input)).status,409);
 await tokenFor(a);const rotated=await record(a.id);assert.equal((await req('/bots/'+a.id,'PUT',{...input,revision:rotated.revision})).status,409);
 assert.equal((await req('/bots/'+a.id+'/pause','POST',{revision:1})).status,409);
 const leaked=JSON.stringify(await directory());assert(!leaked.includes(ta));assert(!leaked.includes(tb));assert(!leaked.includes('key_ciphertext'));
});
