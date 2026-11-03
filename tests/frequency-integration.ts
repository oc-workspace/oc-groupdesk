import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',cookie='',csrf='';
async function req(path:string,method='GET',body?:unknown,bot=false,headers:Record<string,string>={}){
 const r=await fetch(base+'/api'+path,{method,headers:{...(bot?{Authorization:'Bearer '+process.env.BOT_API_TOKEN}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD})});cookie=r.headers.get('set-cookie')!.split(';')[0];csrf=(await r.json()).csrf;
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('global defaults are durable and configuration needs administrator session and CSRF',async()=>{
 assert.equal((await req('/reply-frequency','GET',undefined,false,{Cookie:''})).status,401);
 const v=(await req('/reply-frequency')).data;assert.equal(v.revision,1);assert.equal(v.policy.catch_up.within_minutes,10);assert(v.policy.catch_up.enabled);assert.equal(v.groups.length,2);
 assert.equal((await req('/reply-frequency','PUT',{revision:1,policy:v.policy},false,{'X-CSRF-Token':'wrong'})).status,403);
});
test('save is versioned, no-op is stable, and invalid windows do not change stored settings',async()=>{
 const v=(await req('/reply-frequency')).data;assert.equal((await req('/reply-frequency','PUT',{revision:v.revision,policy:v.policy})).status,200);assert.equal((await req('/reply-frequency')).data.revision,1);
 assert.equal((await req('/reply-frequency','PUT',{revision:1,policy:{...v.policy,windows:[{minutes:0,max_replies:6}]}})).status,400);
 const changed={...v.policy,windows:[{minutes:3,max_replies:8},{minutes:60,max_replies:36}]};assert.equal((await req('/reply-frequency','PUT',{revision:1,policy:changed})).status,200);
 const next=(await req('/reply-frequency')).data;assert.equal(next.revision,2);assert.deepEqual(next.policy,changed);assert.equal((await req('/reply-frequency','PUT',{revision:1,policy:v.policy})).status,409);
});
test('runtime receives shared contract and only matching applied revision can confirm',async()=>{
 const g=(await req('/overview')).data.groups[0];await pool.query('UPDATE groups SET external_id=$1 WHERE id=$2',['frequency-A',g.id]);
 const runtime=(await req('/runtime/config/frequency-A','GET',undefined,true)).data;assert.equal(runtime.reply_frequency_contract_version,1);assert.equal(runtime.reply_frequency.revision,2);
 const ack={group_id:g.id,revision:g.revision,timeout_policy_version:3,reply_limits_version:1};
 assert.equal((await req('/runtime/ack','POST',ack,true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...ack,reply_frequency_version:1,reply_frequency_revision:1},true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...ack,reply_frequency_version:1,reply_frequency_revision:2},true)).status,200);
 const next=(await req('/reply-frequency')).data;assert.equal(next.groups.find((v:any)=>v.id===g.id).applied_revision,2);assert.equal(next.groups.find((v:any)=>v.id!==g.id).applied_revision,0);
});
test('disabling catch-up invalidates frequency confirmation without changing group policy or persona',async()=>{
 const before=(await req('/overview')).data.groups;const v=(await req('/reply-frequency')).data;
 assert.equal((await req('/reply-frequency','PUT',{revision:v.revision,policy:{...v.policy,catch_up:{enabled:false,within_minutes:15}}})).status,200);
 const after=(await req('/overview')).data.groups;assert.deepEqual(after.map((g:any)=>[g.id,g.revision,g.policy,g.model_routes,g.persona_version_id]),before.map((g:any)=>[g.id,g.revision,g.policy,g.model_routes,g.persona_version_id]));
 const current=(await req('/reply-frequency')).data;assert.equal(current.revision,3);assert.equal(current.policy.catch_up.enabled,false);assert(current.groups.every((g:any)=>g.applied_revision===0));await migrate();assert.equal((await req('/reply-frequency')).data.revision,3);
});
