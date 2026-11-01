import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {importMaterial,datasetRecords} from '../server/persona-materials.js';
import {processConversationJob} from '../server/conversation-insights.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',cookie='',csrf='',a:any,b:any,collection='',dataset='',credential='';
async function req(path:string,method='GET',body?:unknown,bot=false,headers:Record<string,string>={}){
 const r=await fetch(base+'/api'+path,{method,headers:{...(bot?{Authorization:'Bearer '+process.env.BOT_API_TOKEN}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};
}
const material=(id:string,text:string,sender='author')=>({id,group_id:'archive-A',sender_id:sender,sender_display_name:sender,timestamp:1700000000+Number(id),authored_text:text,quoted_context:{text:'quoted third-party claim'},message_type:'text'});
const rows=[material('1','Alex left a funny message'),material('2','Ask Alex-Z how to debug this'),material('3','Alexander has a different name'),material('4','Alex left a funny message','other')];
async function load(){return (await req('/conversation-insights/'+dataset)).data;}
async function enqueue(){return req('/conversation-insights/'+dataset+'/analyze','POST',{credential_id:credential,model_id:'mock-text',limit:40});}
async function caller(_c:any,_m:any,_s:string,input:string,options?:any){
 if(options){assert.equal(options.jsonOutput,true);assert.equal(options.timeoutMs,90000);}
 const v=JSON.parse(input);assert(!input.includes('quoted third-party'));assert(!input.includes('sender_id'));
 return {choices:[{message:{content:JSON.stringify({items:v.items.map((r:any)=>({id:r.id,tone:r.id===0?'playful':'mixed',substantive:r.id!==0,confidence:.9,reason:'Synthetic context cue'}))})}}]};
}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 const groups=(await req('/overview')).data.groups;
 a=(await req('/groups/'+groups[0].id,'PUT',{...groups[0],enabled:true,external_id:'conversation-A'})).data;
 b=(await req('/groups/'+groups[1].id,'PUT',{...groups[1],enabled:true,external_id:'conversation-B'})).data;
 collection=(await req('/persona-collections','POST',{name:'Synthetic conversation archive',group_id:a.id})).data.id;
 await importMaterial(collection,Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')),'archive.jsonl','jsonl');
 dataset=(await req('/persona-datasets','POST',{name:'One author mentioning one target',collection_id:collection,sender_ids:['author'],contains_any:['Alex','Alex-Z']})).data.id;
 const c=await req('/model-credentials','POST',{name:'Synthetic test model',base_url:'https://example.com/v1',api_key:'test-key-for-isolated-conversation-fixtures'});assert.equal(c.status,201,JSON.stringify(c.data));credential=c.data.id;
 assert.equal((await req('/model-credentials/'+credential+'/models','POST',{model_id:'mock-text',capability:'text'})).status,201);
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('archive target extraction preserves sender identity, excludes quoted context, and applies Unicode aliases',async()=>{
 const d=await datasetRecords(dataset);assert.deepEqual(d.rows.map(r=>r.source_id),['1','2']);assert.equal(d.dataset.contains_any.length,2);
 const v=await load();assert.equal(v.stats.total,2);assert.equal(v.stats.analyzed,0);
});
test('analysis administration needs session, CSRF and valid model; queueing is not automatic or duplicated',async()=>{
 assert.equal((await req('/conversation-insights/'+dataset,'GET',undefined,false,{Cookie:''})).status,401);
 assert.equal((await req('/conversation-insights/'+dataset+'/analyze','POST',{},false,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await req('/conversation-insights/'+dataset+'/analyze','POST',{credential_id:credential,model_id:'absent',limit:40})).status,400);
 assert.equal((await enqueue()).status,202);assert.equal((await enqueue()).status,409);
 assert.equal((await load()).stats.analyzed,0);
});
test('worker writes complete validated judgements, uses explicit denominator and does not send messages',async()=>{
 assert(await processConversationJob(caller));const v=await load();assert.equal(v.stats.analyzed,2);assert.equal(v.stats.substantive_ratio,.5);assert.equal(v.jobs[0].status,'ready');
 assert.equal((await pool.query('SELECT jsonb_array_length(input) n FROM conversation_jobs')).rows[0].n,0);
 assert.equal((await enqueue()).status,400);assert(!await processConversationJob(caller));
});
test('manual correction is versioned and immediately changes aggregate without changing source',async()=>{
 const v=await load(),r=v.items[0],body={collection_id:collection,source_id:r.source_id,content_hash:r.content_hash,revision:r.label.revision,tone:'mixed',substantive:true,reason:'Contains a real question inside the joke'};
 assert.equal((await req('/conversation-insights/'+dataset+'/label','PUT',body)).status,200);assert.equal((await req('/conversation-insights/'+dataset+'/label','PUT',body)).status,409);
 const next=await load();assert.equal(next.stats.substantive_ratio,1);assert(next.items[0].label.manual);assert.equal(next.items[0].text,rows[0].authored_text);
});
test('incremental source updates invalidate only changed labels; excluded or foreign records cannot be edited',async()=>{
 await importMaterial(collection,Buffer.from(rows.map((r,i)=>JSON.stringify(i===1?{...r,authored_text:'Alex changed this question'}:r)).join('\n')),'updated.jsonl','jsonl');
 let v=await load();assert.equal(v.stats.remaining,1);assert(v.items[0].label.manual);assert.equal(v.items[1].label,null);
 assert.equal((await req('/conversation-insights/'+dataset+'/label','PUT',{collection_id:collection,source_id:'4',content_hash:'x',revision:null,tone:'playful',substantive:false,reason:'foreign sender'})).status,409);
 assert.equal((await enqueue()).status,202);await processConversationJob(caller);v=await load();assert(v.items[0].label.manual);assert.equal(v.stats.analyzed,2);
});
test('key change during analysis fails without applying results or exposing credentials',async()=>{
 await importMaterial(collection,Buffer.from(JSON.stringify(material('5','Alex tells a new joke'))),'new.jsonl','jsonl');assert.equal((await enqueue()).status,202);
 await processConversationJob(async(c,m,s,input)=>{await pool.query('UPDATE model_credentials SET revision=revision+1 WHERE id=$1',[credential]);return caller(c,m,s,input);});
 const v=await load();assert.equal(v.jobs[0].status,'failed');assert.equal(v.stats.remaining,1);assert(!JSON.stringify(v).includes('key_ciphertext'));assert(!JSON.stringify(v).includes('test-key-for-isolated'));
});
test('per-group recognition stays opt in and requires an adapter that applied it',async()=>{
 a=(await req('/groups/'+a.id,'PUT',{...a,policy:{...a.policy,conversation:{enabled:true,banter_replies:true,frequency:'low',instructions:'Synthetic rule'}}})).data;
 assert.equal((await req('/runtime/config/'+a.external_id,'GET',undefined,true)).data.conversation_policy_contract_version,1);
 const other=(await req('/runtime/config/'+b.external_id,'GET',undefined,true)).data;assert.equal(other.policy.conversation.enabled,false);assert.equal(other.conversation_policy_contract_version,undefined);
 const ack={group_id:a.id,revision:a.revision,timeout_policy_version:2};assert.equal((await req('/runtime/ack','POST',ack,true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...ack,conversation_policy_version:1},true)).status,200);
});
