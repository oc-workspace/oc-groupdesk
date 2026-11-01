import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {importExistingCredential} from '../server/models.js';
import {settings,tick} from '../server/summaries/core.js';
import {processSummary} from '../server/summaries/generation.js';
import {digest} from '../server/security.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw new Error('Dedicated test database required');
let server:Server,url='',cookie='',csrf='',a:any,b:any;
const report='一、整体评价\n本时段讨论了一个技术问题。\n二、重点话题\nAlice提出方案，Bob给出了验证方式，双方保留待测试的条件。\n三、其他话题\n没有其他明确结论。';
async function req(path:string,method='GET',body?:any,bot=false,override?:string){const r=await fetch(url+'/api'+path,{method,headers:{...(bot?{Authorization:'Bearer '+(override||process.env.BOT_API_TOKEN)}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function save(g:any,extra:any={}){const s=await settings(g.id);const r=await req('/summaries/groups/'+g.id,'PUT',{revision:s.revision,config:{...s.config,...extra}});assert.equal(r.status,200,JSON.stringify(r.data));}
async function create(g=a,publish=false){const r=await req('/summaries/jobs','POST',{group_id:g.id,window:{kind:'previous_day'},publish,request_id:randomUUID()});assert.equal(r.status,202,JSON.stringify(r.data));return r.data.id;}
async function claim(kind='source',g=a,override?:string){return req('/runtime/summaries/claim','POST',{external_id:g.external_id,kind},true,override);}
async function job(id:string){return (await pool.query('SELECT * FROM summary_jobs WHERE id=$1',[id])).rows[0];}
async function source(id:string){const c=(await claim()).data.job;assert.equal(c.id,id);const at=new Date(new Date(c.start).getTime()+60000).toISOString();const records=[{seq:1,sender:'Alice',text:'A synthetic question about testing.',at,time_kind:'original'},{seq:2,sender:'Bob',text:'A synthetic explanation with a test.',at,time_kind:'capture'}];const r=await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,messages:records},true);assert.equal(r.status,200,JSON.stringify(r.data));return {c,records};}
const caller=async()=>({choices:[{message:{content:report}}]});
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 await importExistingCredential({name:'Synthetic summary key',base_url:'https://summary.example.invalid/v1',api_key:'synthetic-summary-key-only',model_id:'synthetic-text'});
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 [a,b]=(await req('/overview')).data.groups;for(const g of [a,b]){Object.assign(g,(await req('/groups/'+g.id,'PUT',{...g,enabled:true,external_id:'summary-'+g.id})).data);}
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('fresh installs seed five templates and no enabled summary settings or plans',async()=>{const d=(await req('/summaries')).data;assert.equal(d.templates.length,5);assert(d.groups.every((g:any)=>!g.config.enabled));assert.equal(d.schedules.length,0);assert.equal((await fetch(url+'/api/summaries')).status,401);});
test('preview works with publication disabled, while direct publication is refused',async()=>{assert.equal((await req('/summaries/jobs','POST',{group_id:a.id,window:{kind:'previous_day'},publish:true,request_id:randomUUID()})).status,409);const id=await create();await source(id);assert(await processSummary(caller));assert.equal((await job(id)).status,'preview');assert(!(await job(id)).source.messages);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);});
test('saving is group-isolated and uses optimistic revisions without touching group Persona revisions',async()=>{const rev=a.revision;await save(a,{enabled:true});assert.equal((await settings(b.id)).config.enabled,false);assert.equal((await pool.query('SELECT revision FROM groups WHERE id=$1',[a.id])).rows[0].revision,rev);assert.equal((await req('/summaries/groups/'+a.id,'PUT',{revision:0,config:(await settings(a.id)).config})).status,409);});
test('source claim is exclusive and restricted adapter cannot read another group',async()=>{
 const scoped='synthetic-summary-adapter-token-32-chars';await pool.query('INSERT INTO runtime_adapters(name,token_hash,group_external_ids) VALUES($1,$2,$3)',['summary-scope',digest(scoped),JSON.stringify([a.external_id])]);
 assert.equal((await claim('source',b,scoped)).status,403);const id=await create();const [x,y]=await Promise.all([claim(),claim()]);assert.equal([x,y].filter(r=>r.data.job?.id===id).length,1);const c=[x,y].find(r=>r.data.job)?.data.job;
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:randomUUID(),messages:[]},true)).status,409);await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,error:'no_messages'},true);
 assert.equal((await job(id)).status,'failed');
});
test('out-of-window and duplicated source IDs are refused without changing the lease',async()=>{const id=await create(),c=(await claim()).data.job;const m={seq:1,sender:'Alice',text:'synthetic',at:c.end,time_kind:'original'};assert.equal((await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,messages:[m]},true)).status,400);m.at=c.start;assert.equal((await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,messages:[m,m]},true)).status,400);await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,error:'source_unavailable'},true);});
test('preview may be edited and published once; parts are sequential and reserved at most once',async()=>{
 const id=await create();await source(id);await processSummary(caller);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report:report+'\n人工修订。'})).status,200);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);
 const c=(await claim('delivery')).data.job;assert.equal(c.id,id);assert(c.parts[0].body.includes('人工修订'));assert(/按采集时间|capture time/.test(c.parts[0].body));const body={token:c.token,ordinal:0,action:'reserve'};
 const r=await req('/runtime/summaries/jobs/'+id+'/part','POST',body,true);assert.equal(r.data.send,true);assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',body,true)).data.send,false);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',{...body,token:randomUUID()},true)).status,403);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',{...body,action:'sent'},true)).status,200);assert.equal((await job(id)).status,'sent');assert.equal((await claim('delivery')).data.job,null);
});
test('direct generate-and-publish enters delivery queue without exposing private key',async()=>{const id=await create(a,true);await source(id);await processSummary(caller);const j=await job(id);assert.equal(j.status,'delivery_ready');const list=JSON.stringify((await req('/summaries')).data);assert(!list.includes('synthetic-summary-key-only'));assert(!list.includes('key_ciphertext'));await req('/summaries/jobs/'+id+'/cancel','POST',{});});
test('source errors never invoke a model; cancelled generation cannot be resurrected',async()=>{
 const id=await create();await source(id);let calls=0;await processSummary(async()=>{calls++;await req('/summaries/jobs/'+id+'/cancel','POST',{});return {choices:[{message:{content:report}}]};});assert.equal(calls,1);assert.equal((await job(id)).status,'cancelled');assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[id])).rowCount,0);
});
test('configuration changes cancel old previews and changing timezone disables plans',async()=>{
 const id=await create();await source(id);await processSummary(caller);
 const s=await req('/summaries/schedules','POST',{group_id:a.id,name:'Synthetic daily',enabled:true,config:{kind:'daily',at:'00:10',window:{kind:'previous_day'}}});assert.equal(s.status,201);
 await save(a,{timezone:'UTC'});assert.equal((await job(id)).status,'cancelled');assert.equal((await pool.query('SELECT enabled FROM summary_schedules WHERE id=$1',[s.data.id])).rows[0].enabled,false);
 await save(a,{timezone:'Asia/Shanghai'});
});
test('once schedules enqueue exactly once and disable themselves',async()=>{
 const at=new Date(Date.now()+120000);const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(at).replace(' ','T');
 const s=await req('/summaries/schedules','POST',{group_id:a.id,name:'Synthetic once',enabled:true,config:{kind:'once',at:parts,window:{kind:'previous_day'}}});assert.equal(s.status,201,JSON.stringify(s.data));const row=(await pool.query('SELECT * FROM summary_schedules WHERE id=$1',[s.data.id])).rows[0];await tick(new Date(row.next_run).getTime()+1);await tick(new Date(row.next_run).getTime()+2);assert.equal((await pool.query('SELECT count(*)::int n FROM summary_jobs WHERE schedule_id=$1',[row.id])).rows[0].n,1);assert.equal((await pool.query('SELECT enabled FROM summary_schedules WHERE id=$1',[row.id])).rows[0].enabled,false);
 await pool.query("UPDATE summary_jobs SET status='cancelled' WHERE schedule_id=$1",[row.id]);
});
test('future summary windows cannot be scheduled before their end',async()=>{assert.equal((await req('/summaries/schedules','POST',{group_id:a.id,name:'Invalid',enabled:true,config:{kind:'daily',at:'23:00',window:{kind:'day',date:'2099-01-01'}}})).status,400);});
test('template edits persist across migrations and queued jobs retain their snapshot',async()=>{const t=(await req('/summaries')).data.templates[0];const id=await create();assert.equal((await req('/summaries/templates/'+t.slug,'PUT',{...t,instructions:'人工修改：只根据本次数据，认真总结主要交流，不编造。'})).status,200);await migrate();const current=(await pool.query('SELECT * FROM summary_templates WHERE slug=$1',[t.slug])).rows[0];assert(current.instructions.startsWith('人工修改'));assert.notEqual((await job(id)).template.instructions,current.instructions);await req('/summaries/jobs/'+id+'/cancel','POST',{});});
test('generation failure does not retry, and lost delivery confirmation is never auto requeued',async()=>{const id=await create();await source(id);let n=0;await processSummary(async()=>{n++;throw new Error('synthetic network error');});assert.equal(n,1);assert.equal((await job(id)).status,'failed');await pool.query("UPDATE summary_jobs SET status='delivering',lease_until=now()-interval '1 second' WHERE id=$1",[id]);await tick();assert.equal((await job(id)).status,'uncertain');assert.equal((await claim('delivery')).data.job,null);});
test('a group revision change blocks publication even for a prepared report',async()=>{const id=await create();await source(id);await processSummary(caller);await pool.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[a.id]);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);await req('/summaries/jobs/'+id+'/cancel','POST',{});});
