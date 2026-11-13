import {readFile} from 'node:fs/promises';
import {route as summaryRoute} from '../server/summaries/core.js';
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
let server:Server,url='',cookie='',csrf='',a:any,b:any,summaryModel:any;
const report="一、整体评价\n本时段讨论了一个技术问题，方案仍需验证。\n二、重点话题总结\n**话题名**：1️⃣ 测试方法 🔥🔥\n**主要参与者**：@Alice、@Bob\n**时间段**：原始发送时间未获取\n**讨论过程**：@Alice 提出方案，@Bob 给出了验证方式，双方保留待测试的条件。\n**简短评价**：方法有待实测，不把建议写成结果。\n------------\n三、其他话题与群像彩蛋\n**其他话题**：没有其他明确结论。\n**今日高光时刻**：两位成员共同细化了验证方法。\n**散场彩蛋**：期待下次带来测试结果。";
async function req(path:string,method='GET',body?:any,bot=false,override?:string){const r=await fetch(url+'/api'+path,{method,headers:{...(bot?{Authorization:'Bearer '+(override||process.env.BOT_API_TOKEN)}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function save(g:any,extra:any={}){const s=await settings(g.id);const r=await req('/summaries/groups/'+g.id,'PUT',{revision:s.revision,config:{...s.config,...extra}});assert.equal(r.status,200,JSON.stringify(r.data));}
async function create(g=a,publish=false){const r=await req('/summaries/jobs','POST',{group_id:g.id,window:{kind:'previous_day'},publish,request_id:randomUUID()});assert.equal(r.status,202,JSON.stringify(r.data));return r.data.id;}
async function claim(kind='source',g=a,override?:string){return req('/runtime/summaries/claim','POST',{external_id:g.external_id,kind},true,override);}
async function job(id:string){return (await pool.query('SELECT * FROM summary_jobs WHERE id=$1',[id])).rows[0];}
async function source(id:string,kind="ui_archive",g=a){const c=(await claim("source",g)).data.job;assert.equal(c.id,id);const at=new Date(new Date(c.start).getTime()+60000).toISOString();const records=[{seq:1,sender:'Alice',text:'A synthetic question about testing.',at,time_kind:'original'},{seq:2,sender:'Bob',text:'A synthetic explanation with a test.',at,time_kind:'capture'}];const r=await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,source_kind:kind,messages:records},true);assert.equal(r.status,200,JSON.stringify(r.data));return {c,records};}
const caller=async(_credential:any,_model:any,system:string,input:string)=>{assert(system.includes('【总结成员昵称格式】'));const data=JSON.parse(input);if(data.senders)assert(data.senders.every((name:string|null)=>name===null||name.startsWith('@')));return {choices:[{message:{content:report}}]};};
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 await importExistingCredential({name:'Synthetic summary key',base_url:'https://summary.example.invalid/v1',api_key:'synthetic-summary-key-only',model_id:'synthetic-text'});
 summaryModel={mode:'custom',...(await pool.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes.text};
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 [a,b]=(await req('/overview')).data.groups;for(const g of [a,b]){Object.assign(g,(await req('/groups/'+g.id,'PUT',{...g,enabled:true,language:'auto',policy:{...g.policy,language:{mode:'follow',allowed:[],fallback:'zh-CN',allow_requested:true}},external_id:'summary-'+g.id})).data);}
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('fresh installs seed five templates and no enabled summary settings or plans',async()=>{const d=(await req('/summaries')).data;assert.equal(d.templates.length,5);assert(d.groups.every((g:any)=>!g.config.enabled));assert.equal(d.schedules.length,0);assert.equal((await fetch(url+'/api/summaries')).status,401);});
test('summary needs its own model before preview and publication stays disabled until enabled',async()=>{assert.equal((await req('/summaries/jobs','POST',{group_id:a.id,window:{kind:'previous_day'},publish:false,request_id:randomUUID()})).status,409);await save(a,{model_route:summaryModel});assert.equal((await req('/summaries/jobs','POST',{group_id:a.id,window:{kind:'previous_day'},publish:true,request_id:randomUUID()})).status,409);const id=await create();await source(id);assert(await processSummary(caller));assert.equal((await job(id)).status,'preview');assert(!(await job(id)).source.messages);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);});
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
 const proof={epoch:'a'.repeat(32),seq:11,server_id:'123456789',confirmed_at:new Date().toISOString()};
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',{...body,action:'sent'},true)).status,400);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',{...body,action:'sent',proof},true)).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/part','POST',{...body,action:'sent',proof:{...proof,server_id:'123456788'}},true)).status,409);
 assert.equal((await pool.query('SELECT wechat_server_id,source_epoch,source_seq FROM summary_parts WHERE job_id=$1 AND ordinal=0',[id])).rows[0].wechat_server_id,proof.server_id);
 assert.equal((await job(id)).status,'sent');assert.equal((await claim('delivery')).data.job,null);
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
test('template edits persist across migrations and queued jobs retain their snapshot',async()=>{const t=(await req('/summaries')).data.templates[0];const id=await create();assert.equal((await req('/summaries/templates/'+t.slug,'PUT',{...t,instructions:'人工修改：只根据本次数据，认真总结主要交流，不编造。'})).status,200);await migrate();const current=(await pool.query('SELECT * FROM summary_templates WHERE slug=$1',[t.slug])).rows[0];assert(current.instructions.includes('人工修改'));assert(current.instructions.includes('[GroupDesk 完整 Skill v2:'));assert.notEqual((await job(id)).template.instructions,current.instructions);await req('/summaries/jobs/'+id+'/cancel','POST',{});});
test('generation failure does not retry, and lost delivery confirmation is never auto requeued',async()=>{const id=await create();await source(id);let n=0;await processSummary(async()=>{n++;throw new Error('synthetic network error');});assert.equal(n,1);assert.equal((await job(id)).status,'failed');await pool.query("UPDATE summary_jobs SET status='delivering',lease_until=now()-interval '1 second' WHERE id=$1",[id]);await tick();assert.equal((await job(id)).status,'uncertain');assert.equal((await claim('delivery')).data.job,null);});
test('model input separates original display times from capture-only rows and rejects invented clocks',async()=>{
 const id=await create();await source(id);let seen:any;
 await processSummary(async(_credential,_model,_system,input)=>{seen=JSON.parse(input);return {choices:[{message:{content:report}}]};});
 assert.equal(seen.timezone,'Asia/Shanghai');assert.match(seen.messages[0][2],/\d{4}-\d{2}-\d{2}/);assert.equal(seen.messages[1][2],null);assert.equal(seen.columns.includes('at'),false);
 const bad=await create(a,true);await source(bad);await processSummary(async()=>({choices:[{message:{content:'15:10 有群友表示愿意私下交流。这是一段合成测试文本。'}}]}));
 assert.equal((await job(bad)).status,'failed');assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[bad])).rowCount,0);
});
test('a group revision change blocks publication even for a prepared report',async()=>{const id=await create();await source(id);await processSummary(caller);await pool.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[a.id]);assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);await req('/summaries/jobs/'+id+'/cancel','POST',{});});

test('database provenance survives generation and is exposed to administrators',async()=>{
 const g=await freshSummaryGroup(),id=await create(g);await source(id,'wechat_database',g);assert.equal((await job(id)).source.origin,'wechat-database-chatlog-keeper');await processSummary(caller);assert.equal((await job(id)).source.origin,'wechat-database-chatlog-keeper');assert(!(await job(id)).source.messages);
 const list=(await req('/summaries')).data.jobs.find((j:any)=>j.id===id);assert.equal(list.source_origin,'wechat-database-chatlog-keeper');await req('/summaries/jobs/'+id+'/cancel','POST',{});
});

async function freshSummaryGroup(){
 const id=randomUUID();const g=(await pool.query("INSERT INTO groups(id,name,enabled,external_id,model_routes) SELECT $1,'Synthetic batching group',true,$2,model_routes FROM groups WHERE id=$3 RETURNING *",[id,'batch-'+id,a.id])).rows[0];await save(g,{model_route:summaryModel});return g;
}
test('complete Reader data is reused for the same window and a child window, then expires after seven days',async()=>{
 const g=await freshSummaryGroup(),first=await create(g),c=(await claim('source',g)).data.job;
 const start=new Date(c.start).getTime(),at=(minutes:number)=>new Date(start+minutes*60000).toISOString();
 const messages=[1,2,12].map((minute,i)=>({seq:i+1,sender:'Synthetic member',text:'Synthetic message '+minute,at:at(minute),time_kind:'original'}));
 const pending=await create(g);assert.equal((await job(pending)).status,'waiting_source');
 const plan={epoch:'a'.repeat(32),through:3,count:messages.length,text_chars:messages.reduce((n,m)=>n+Array.from(m.text).length,0),max_text_chars:Math.max(...messages.map(m=>Array.from(m.text).length)),page_limit:200,planned_batches:1};
 assert.equal((await req('/runtime/summaries/jobs/'+first+'/source-plan','POST',{token:c.token,source_kind:'wechat_database',plan},true)).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+first+'/source-batch','POST',{token:c.token,ordinal:0,read_batches:1,messages},true)).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+first+'/source-complete','POST',{token:c.token,batches:1,read_batches:1},true)).status,200);
 assert.equal((await pool.query('SELECT count(*)::int n FROM summary_source_cache WHERE group_id=$1',[g.id])).rows[0].n,1);
 assert.equal((await claim('source',g)).data.job,null);assert.equal((await job(pending)).progress.cache_hit,true);
 await req('/summaries/jobs/'+first+'/cancel','POST',{});
 const same=await create(g);assert.equal((await job(same)).status,'queued');assert.equal((await job(same)).progress.cache_hit,true);
 assert.deepEqual((await job(same)).source.messages.map((m:any)=>m.seq),[1,2,3]);
 const day=new Date(start+8*3600000).toISOString().slice(0,10);
 const childRequest=await req('/summaries/jobs','POST',{group_id:g.id,window:{kind:'custom',start:day+'T00:00',end:day+'T00:10'},publish:false,request_id:randomUUID()});
 assert.equal(childRequest.status,202,JSON.stringify(childRequest.data));const child=await job(childRequest.data.id);
 assert.equal(child.status,'queued');assert.equal(child.progress.cache_hit,true);assert.deepEqual(child.source.messages.map((m:any)=>m.seq),[1,2]);assert.equal(child.source.stats.count,2);
 const emptyRequest=await req('/summaries/jobs','POST',{group_id:g.id,window:{kind:'custom',start:day+'T00:30',end:day+'T00:40'},publish:false,request_id:randomUUID()});
 assert.equal(emptyRequest.status,202);const empty=await job(emptyRequest.data.id);assert.equal(empty.status,'failed');assert.equal(empty.progress.cache_hit,true);
 const other=await freshSummaryGroup(),otherJob=await create(other);assert.equal((await job(otherJob)).status,'waiting_source');
 await pool.query("UPDATE summary_source_cache SET fetched_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE group_id=$1",[g.id]);
 const afterExpiry=await create(g);assert.equal((await job(afterExpiry)).status,'waiting_source');await tick();
 assert.equal((await pool.query('SELECT count(*)::int n FROM summary_source_cache WHERE group_id=$1',[g.id])).rows[0].n,0);
 for(const id of [pending,same,child.id,otherJob,afterExpiry])await req('/summaries/jobs/'+id+'/cancel','POST',{});
});
test('unfinished Reader batches never become reusable source data',async()=>{
 const g=await freshSummaryGroup(),{id,c,rows}=await preflight(g,syntheticRows(2));
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',{token:c.token,ordinal:0,read_batches:1,messages:rows},true)).status,200);
 const second=await create(g);assert.equal((await job(second)).status,'waiting_source');
 assert.equal((await pool.query('SELECT count(*)::int n FROM summary_source_cache WHERE group_id=$1',[g.id])).rows[0].n,0);
 await req('/summaries/jobs/'+id+'/cancel','POST',{});await req('/summaries/jobs/'+second+'/cancel','POST',{});
});
async function preflight(g:any,messages:any[]){
 const id=await create(g),c=(await claim('source',g)).data.job;
 const rows=messages.map(m=>({...m,at:new Date(new Date(c.start).getTime()+m.seq*1000).toISOString()}));
 const plan={epoch:'a'.repeat(32),through:999999,count:rows.length,text_chars:rows.reduce((n,m)=>n+Array.from(m.text).length,0),max_text_chars:Math.max(...rows.map(m=>Array.from(m.text).length)),page_limit:200,planned_batches:Math.ceil(rows.length/200)};
 const r=await req('/runtime/summaries/jobs/'+id+'/source-plan','POST',{token:c.token,source_kind:'wechat_database',plan},true);assert.equal(r.status,200,JSON.stringify(r.data));return {id,c,rows,plan};
}
const syntheticRows=(n:number,size=40)=>Array.from({length:n},(_,i)=>({seq:i+1,sender:i%2?'A':'B',text:'x'.repeat(size),time_kind:'original'}));
test('preflight, bounded batch upload, duplicates, and completion preserve full-day counts',async()=>{
 const g=await freshSummaryGroup(),{id,c,rows,plan}=await preflight(g,syntheticRows(979,15));
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-plan','POST',{token:c.token,source_kind:'wechat_database',plan},true)).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',{token:randomUUID(),ordinal:0,read_batches:1,messages:rows.slice(0,200)},true)).status,409);
 for(let i=0;i<5;i++){
  const body={token:c.token,ordinal:i,read_batches:i+1,messages:rows.slice(i*200,(i+1)*200)};
  assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',body,true)).status,200);
  assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',body,true)).status,200);
 }
 assert.equal((await job(id)).progress.read_count,979);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:5,read_batches:5},true)).status,200);
 assert.equal((await pool.query('SELECT count(*)::int n FROM summary_source_batches WHERE job_id=$1',[id])).rows[0].n,0);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:5,read_batches:5},true)).status,200);
 let calls=0;await processSummary(async(_c,_m,_s,input)=>{calls++;assert.equal(JSON.parse(input).messages.length,979);return caller(_c,_m,_s,input);});
 assert.equal(calls,1);assert.equal((await job(id)).status,'preview');assert.equal((await job(id)).source.stats.count,979);assert.equal((await job(id)).progress.strategy,'whole');
});
test('missing, overlapping, mutated or out-of-window batches cannot enqueue partial summaries',async()=>{
 const g=await freshSummaryGroup(),{id,c,rows}=await preflight(g,syntheticRows(3));
 const send=(ordinal:number,messages:any[])=>req('/runtime/summaries/jobs/'+id+'/source-batch','POST',{token:c.token,ordinal,read_batches:ordinal+1,messages},true);
 assert.equal((await send(1,rows.slice(1))).status,409);
 assert.equal((await send(0,[{...rows[0],at:c.end}])).status,400);
 assert.equal((await send(0,rows.slice(0,2))).status,200);
 assert.equal((await send(0,[{...rows[0],text:'mutated'},rows[1]])).status,409);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:1,read_batches:1},true)).status,400);
 assert.equal((await send(1,[rows[0]])).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:2,read_batches:2},true)).status,400);
 assert.equal((await job(id)).status,'reading');await req('/runtime/summaries/jobs/'+id+'/source','POST',{token:c.token,error:'source_unavailable'},true);
 assert.equal((await pool.query('SELECT 1 FROM summary_source_batches WHERE job_id=$1',[id])).rowCount,0);
});
test('large materials use complete chronological chunks then one combined report; a partial failure never publishes',async()=>{
 const g=await freshSummaryGroup();await save(g,{input_character_budget:24000});
 async function prepare(){const x=await preflight(g,syntheticRows(250,600));for(let i=0;i<5;i++)assert.equal((await req('/runtime/summaries/jobs/'+x.id+'/source-batch','POST',{token:x.c.token,ordinal:i,read_batches:i+1,messages:x.rows.slice(i*50,(i+1)*50)},true)).status,200);assert.equal((await req('/runtime/summaries/jobs/'+x.id+'/source-complete','POST',{token:x.c.token,batches:5,read_batches:5},true)).status,200);return x;}
 const x=await prepare();let maps=0,finals=0;const observed=new Set<number>();
 await processSummary(async(_c,_m,system,input)=>{const data=JSON.parse(input);assert(input.length<=24000);if(data.messages){maps++;for(const m of data.messages)observed.add(m[0]);return {choices:[{message:{content:'合成中间归纳：相同主题的讨论仍在继续，后续结论需要与其他分段一起核对。'}}]};}finals++;assert.match(system,/跨上午下午/);assert(data.notes.length===maps);return caller(_c,_m,system,input);});
 assert(maps>1);assert.equal(finals,1);assert.equal(observed.size,250);assert.equal((await job(x.id)).status,'preview');
 await pool.query('DELETE FROM summary_source_cache WHERE group_id=$1',[g.id]);
 const y=await prepare();let calls=0;await processSummary(async()=>{if(++calls===2)throw Error('synthetic map failure');return {choices:[{message:{content:'合成中间归纳：讨论仍需综合后续内容判断，不应直接发布本段。'}}]};});
 assert.equal((await job(y.id)).status,'failed');assert.equal((await job(y.id)).report,null);assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[y.id])).rowCount,0);
});
test('cancelled reads purge temporary batches, and new endpoints enforce adapter group scope',async()=>{
 const g=await freshSummaryGroup(),{id,c,rows}=await preflight(g,syntheticRows(2));
 const scoped='synthetic-batching-adapter-token-32-chars';await pool.query('INSERT INTO runtime_adapters(name,token_hash,group_external_ids) VALUES($1,$2,$3)',['batch-scope',digest(scoped),JSON.stringify([a.external_id])]);
 const body={token:c.token,ordinal:0,read_batches:1,messages:rows};assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',body,true,scoped)).status,403);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',body,true)).status,200);await req('/summaries/jobs/'+id+'/cancel','POST',{});await tick();
 assert.equal((await pool.query('SELECT 1 FROM summary_source_batches WHERE job_id=$1',[id])).rowCount,0);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:1,read_batches:1},true)).status,409);
});

test('many intermediate notes are reduced before final synthesis and remain inside each call budget',async()=>{
 const g=await freshSummaryGroup();await save(g,{input_character_budget:24000});const {id,c,rows}=await preflight(g,syntheticRows(300,1000));
 for(let i=0;i<6;i++)assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-batch','POST',{token:c.token,ordinal:i,read_batches:i+1,messages:rows.slice(i*50,(i+1)*50)},true)).status,200);
 assert.equal((await req('/runtime/summaries/jobs/'+id+'/source-complete','POST',{token:c.token,batches:6,read_batches:6},true)).status,200);
 let reductions=0,finals=0;await processSummary(async(_c,_m,_s,input)=>{const data=JSON.parse(input);assert(input.length<=24000);if(data.stage==='final'){finals++;return caller(_c,_m,_s,input);}if(data.stage==='reduce')reductions++;return {choices:[{message:{content:'合成中间归纳，保留待核对的后续进展。'.repeat(200)}}]};});
 assert(reductions>0);assert.equal(finals,1);assert.equal((await job(id)).status,'preview');
});

test('migration freezes former precedence without changing settings revisions, jobs or schedules',async()=>{
 const sql=await readFile(new URL('../migrations/036_summary_model_single_entry.sql',import.meta.url),'utf8');
 const result=await req('/model-credentials','POST',{name:'Migration alternate',base_url:'https://migration.example.invalid/v1',api_key:'synthetic-migration-key-only'});assert.equal(result.status,201);const key=result.data.id;
 assert.equal((await req('/model-credentials/'+key+'/models','POST',{model_id:'alternate',capability:'text'})).status,201);
 const A={credential_id:summaryModel.credential_id,model_id:summaryModel.model_id},B={credential_id:key,model_id:'alternate'};
 const cases=[
  {base:{mode:'inherit'},global:B,stage:{mode:'custom',...A},expected:A},
  {base:{mode:'custom',...A},global:B,expected:B},
  {base:{mode:'custom',...A},global:null,expected:A},
  {base:{mode:'inherit'},global:null,expected:A},
  {base:{mode:'disabled'},global:B,stage:{mode:'custom',...A},expected:null},
  {base:{mode:'disabled'},global:B,explicit:{mode:'custom',...A},expected:A},
 ];
 for(const [index,c] of cases.entries()){
  await pool.query('UPDATE model_settings SET routes=$1 WHERE singleton=true',[{text:A,image:null,stages:{summary:c.global}}]);
  const id=randomUUID(),model_routes={text:c.base,image:{mode:'disabled'},stages:c.stage?{summary:c.stage}:{}};
  const g=(await pool.query('INSERT INTO groups(id,name,enabled,external_id,model_routes) VALUES($1,$2,true,$3,$4) RETURNING *',[id,'Synthetic migration '+index,'migration-'+id,model_routes])).rows[0];
  const config={...(await settings(id)).config,model_route:c.explicit||{mode:'inherit'},instructions:'保留自定义总结要求'};
  const revision=index===0?0:7;
  if(index!==0)await pool.query('INSERT INTO summary_settings(group_id,revision,config) VALUES($1,$2,$3)',[id,revision,config]);
  const schedule=randomUUID();await pool.query("INSERT INTO summary_schedules(id,group_id,name,enabled,config,next_run) VALUES($1,$2,$3,true,$4,now()+interval '1 day')",[schedule,id,'Synthetic plan',{kind:'daily',at:'00:10',window:{kind:'previous_day'}}]);
  const task=randomUUID();await pool.query("INSERT INTO summary_jobs(id,group_id,external_id,group_revision,settings_revision,request_id,wants_publish,window_start,window_end,config,template,status) VALUES($1,$2,$3,$4,$5,$6,false,now()-interval '1 day',now(),$7,'{}','preview')",[task,id,g.external_id,g.revision,revision,randomUUID(),{model_route:{mode:'inherit'}}]);
  const before=(await pool.query('SELECT to_jsonb(t) value FROM summary_jobs t WHERE id=$1',[task])).rows[0].value;
  await pool.query(sql);await pool.query(sql);
  const saved=await settings(id);assert.equal(saved.revision,revision);
  assert.deepEqual(saved.config.model_route,c.expected?{mode:'custom',...c.expected}:{mode:'unconfigured'});
  if(index!==0)assert.equal(saved.config.instructions,config.instructions);
  assert.deepEqual((await pool.query('SELECT to_jsonb(t) value FROM summary_jobs t WHERE id=$1',[task])).rows[0].value,before);
  assert.equal((await pool.query('SELECT enabled FROM summary_schedules WHERE id=$1',[schedule])).rows[0].enabled,true);
  assert.deepEqual((await pool.query('SELECT model_routes FROM groups WHERE id=$1',[id])).rows[0].model_routes,model_routes);
  const legacy=await summaryRoute(g,{model_route:{mode:'inherit'}});assert.equal(legacy.available,!!c.expected);if(c.expected)assert.equal(legacy.credential_id,c.expected.credential_id);
 }
});

async function assertPayloadCleared(id:string){
 const j=await job(id);assert.equal(j.status,'cancelled');
 for(const key of ['report','source','source_token','delivery_token','lease_until'])assert.equal(j[key],null,key);
 for(const key of ['config','template','progress'])assert.deepEqual(j[key],{},key);
 for(const table of ['summary_parts','summary_source_batches'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table+' WHERE job_id=$1',[id])).rows[0].n,0);
 assert(j.finished_at);
}
test('cancelling a preview destroys stored payload and publishing it is refused',async()=>{
 const g=await freshSummaryGroup(),id=await create(g);await source(id,'ui_archive',g);await processSummary(caller);const before=await job(id);assert.equal(before.status,'preview');assert(before.report);
 assert.equal((await req('/summaries/jobs/'+id+'/cancel','POST',{})).status,200);await assertPayloadCleared(id);
 assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report})).status,409);assert.equal((await job(id)).request_id,before.request_id);
 const list=(await req('/summaries')).data.jobs.find((j:any)=>j.id===id);assert.equal(list.report,null);
});
test('cancelling prepared delivery purges all parts and other previews remain unchanged',async()=>{
 const g=await freshSummaryGroup();await save(g,{enabled:true});const keep=await create(g);await source(keep,'ui_archive',g);await processSummary(caller);const kept=await job(keep);
 const id=await create(g,true);await source(id,'ui_archive',g);await processSummary(caller);assert((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[id])).rowCount);
 await req('/summaries/jobs/'+id+'/cancel','POST',{});await assertPayloadCleared(id);assert.deepEqual(await job(keep),kept);
});
test('configuration cancellation cleans immediately without waiting for a worker tick',async()=>{
 const g=await freshSummaryGroup(),id=await create(g);await source(id,'ui_archive',g);await processSummary(caller);await save(g,{instructions:'新的合成配置要求'});await assertPayloadCleared(id);
});
test('037 retroactively purges cancelled payloads and retired JSON entries idempotently',async()=>{
 const g=await freshSummaryGroup();await save(g,{enabled:true});const id=await create(g,true);await source(id,'ui_archive',g);await processSummary(caller);
 await pool.query('ALTER TABLE summary_jobs DISABLE TRIGGER summary_jobs_cancelled_payload_cleanup');
 try{await pool.query("UPDATE summary_jobs SET status='cancelled',source_token=$2,delivery_token=$3 WHERE id=$1",[id,randomUUID(),randomUUID()]);}finally{await pool.query('ALTER TABLE summary_jobs ENABLE TRIGGER summary_jobs_cancelled_payload_cleanup');}
 const keep=await create(g);await source(keep,'ui_archive',g);await processSummary(caller);const kept=await job(keep);
 const old=await pool.query('SELECT model_routes,revision FROM groups WHERE id=$1',[g.id]);const cfg=await settings(g.id);
 await pool.query("UPDATE groups SET model_routes=jsonb_set(model_routes,'{stages}',COALESCE(model_routes->'stages','{}'::jsonb)||$2::jsonb) WHERE id=$1",[g.id,JSON.stringify({summary:summaryModel,replyer:summaryModel})]);
 const defaults=(await pool.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes;
 await pool.query('UPDATE model_settings SET routes=$1 WHERE singleton=true',[{...defaults,stages:{...defaults.stages,summary:{credential_id:summaryModel.credential_id,model_id:summaryModel.model_id}}}]);
 const sql=await readFile(new URL('../migrations/037_summary_payload_cleanup.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
 await assertPayloadCleared(id);assert.deepEqual(await job(keep),kept);assert.deepEqual(await settings(g.id),cfg);
 const cleaned=(await pool.query('SELECT model_routes,revision FROM groups WHERE id=$1',[g.id])).rows[0];assert.equal(cleaned.revision,old.rows[0].revision);assert(!('summary' in cleaned.model_routes.stages));assert.deepEqual(cleaned.model_routes.stages.replyer,summaryModel);assert.deepEqual(cleaned.model_routes.text,old.rows[0].model_routes.text);
 assert.equal((await pool.query("SELECT count(*)::int n FROM groups WHERE (model_routes->'stages') ? 'summary'")).rows[0].n,0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM model_settings WHERE (routes->'stages') ? 'summary'")).rows[0].n,0);
});

test('all five versions use full writing rules and generate complete previews with exact full statistics',async()=>{
 const g=await freshSummaryGroup();
 for(const slug of ['comprehensive','technical','ranking','entertainment','news']){
  await save(g,{template:slug});const id=await create(g);await source(id,'ui_archive',g);
  let calls=0;await processSummary(async(c,m,system,input)=>{calls++;assert(system.includes('[GroupDesk 完整 Skill v2:'+slug+']'));assert(system.includes('【最终报告格式契约】'));assert(system.includes('讨论过程'));return caller(c,m,system,input);});
  const j=await job(id);assert.equal(j.status,'preview',j.error);assert.equal(calls,1);assert.equal(j.source.stats.stats_version,2);assert.equal(j.source.stats.leastRankings.length,2);assert(j.source.stats.characterRankings.length);assert(!j.source.messages);
  await req('/summaries/jobs/'+id+'/cancel','POST',{});
 }
});
test('invalid format fails preview and direct publishing without parts or paid retries',async()=>{
 await new Promise<void>(r=>server.close(()=>r()));server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const g=await freshSummaryGroup();await save(g,{enabled:true,template:'news'});
 for(const publish of [false,true]){const id=await create(g,publish);await source(id,'ui_archive',g);let calls=0;await processSummary(async()=>{calls++;return {choices:[{message:{content:'一、整体评价\n只有简短概括，没有必需的话题和高光模块。'}}]};});const j=await job(id);assert.equal(j.status,'failed');assert.match(j.error,/格式不完整/);assert.equal(j.report,null);assert.equal(calls,1);assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[id])).rowCount,0);}
});
test('group command records its member, deduplicates the window, and returns a native quote anchor',async()=>{
 const g=await freshSummaryGroup(),at=new Date().toISOString();await save(g,{enabled:true});
 const command={external_id:g.external_id,epoch:'b'.repeat(32),seq:100,server_id:'900100',sender_id:'wxid_synthetic_member',sender_name:'Synthetic member',source_at:at,text:'/generate-summary'};
 assert.equal((await req('/runtime/summaries/command','POST',command,true)).status,409);
 await save(g,{group_command_enabled:true});
 const first=await req('/runtime/summaries/command','POST',command,true);
 assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.state,'in_progress');
 const id=first.data.job_id,j=await job(id);
 assert.equal(j.trigger_kind,'group_command');assert.equal(j.trigger_actor_id,command.sender_id);assert.equal(j.trigger_mode,'previous_day');
 assert.equal((await req('/runtime/summaries/command','POST',command,true)).data.state,'already_processed');
 assert.equal((await req('/runtime/summaries/command','POST',{...command,seq:101,server_id:'900101'},true)).data.job_id,id);
 await source(id,'wechat_database',g);await processSummary(caller);
 const claimed=(await claim('delivery',g)).data.job;
 for(const part of claimed.parts){
  const path='/runtime/summaries/jobs/'+id+'/part';
  const body={token:claimed.token,ordinal:part.ordinal};
  assert.equal((await req(path,'POST',{...body,action:'reserve'},true)).status,200);
  assert.equal((await req(path,'POST',{...body,action:'sent',proof:{epoch:'c'.repeat(32),seq:part.ordinal+1,server_id:String(900200+part.ordinal),confirmed_at:new Date().toISOString()}},true)).status,200);
 }
 const again=await req('/runtime/summaries/command','POST',{...command,seq:102,server_id:'900102'},true);
 assert.equal(again.data.state,'already_sent');assert.equal(again.data.server_id,'900200');assert.equal(again.data.anchor_text,claimed.parts[0].body);
 const listed=(await req('/summaries')).data.jobs.find((row:any)=>row.id===id);
 assert.equal(listed.trigger_actor_name,'Synthetic member');assert.equal(listed.trigger_kind,'group_command');
});

test('today command freezes its first cutoff and later commands reuse it',async()=>{
 const g=await freshSummaryGroup();await save(g,{enabled:true,group_command_enabled:true});
 const command={external_id:g.external_id,epoch:'d'.repeat(32),seq:201,server_id:'901201',sender_id:'wxid_today',sender_name:'Today member',source_at:new Date(Date.now()-120000).toISOString(),text:'/generate-summary today'};
 const first=await req('/runtime/summaries/command','POST',command,true);
 assert.equal(first.status,200);const cutoff=first.data.window_end;
 const next=await req('/runtime/summaries/command','POST',{...command,seq:202,server_id:'901202',source_at:new Date().toISOString()},true);
 assert.equal(next.data.job_id,first.data.job_id);assert.equal(next.data.window_end,cutoff);
 assert.equal((await job(first.data.job_id)).trigger_mode,'today');
 await req('/summaries/jobs/'+first.data.job_id+'/cancel','POST',{});
});

test('focus commands keep their own cutoff, prompt, and published version',async()=>{
 const g=await freshSummaryGroup();await save(g,{enabled:true,group_command_enabled:true,template:'news'});
 const base={external_id:g.external_id,epoch:'e'.repeat(32),seq:301,server_id:'902301',sender_id:'wxid_focus',sender_name:'Focus member',source_at:new Date(Date.now()-120000).toISOString()};
 const focus=await req('/runtime/summaries/command','POST',{...base,text:'/generate-summary today focus'},true);
 assert.equal(focus.status,200,JSON.stringify(focus.data));
 const later=await req('/runtime/summaries/command','POST',{...base,seq:302,server_id:'902302',source_at:new Date().toISOString(),text:'/generate-summary today focus'},true);
 assert.equal(later.data.job_id,focus.data.job_id);assert.equal(later.data.window_end,focus.data.window_end);
 const normal=await req('/runtime/summaries/command','POST',{...base,seq:303,server_id:'902303',text:'/generate-summary today'},true);
 assert.notEqual(normal.data.job_id,focus.data.job_id);
 assert.equal((await job(focus.data.job_id)).trigger_mode,'today_focus');
 assert.equal((await job(normal.data.job_id)).trigger_mode,'today');
 await source(focus.data.job_id,'ui_archive',g);
 await processSummary(async(c,m,system,input)=>{assert(system.includes('【群命令重点版选题】'));assert(system.includes('图形学'));return caller(c,m,system,input);});
 const parts=(await pool.query('SELECT body FROM summary_parts WHERE job_id=$1 ORDER BY ordinal',[focus.data.job_id])).rows.map(x=>x.body).join('\n');
 assert(parts.includes('重点信息'));assert(!parts.includes('发言排行'));
 const previous=await req('/runtime/summaries/command','POST',{...base,seq:304,server_id:'902304',text:'/generate-summary focus'},true);
 const previousNormal=await req('/runtime/summaries/command','POST',{...base,seq:305,server_id:'902305',text:'/generate-summary'},true);
 assert.equal((await job(previous.data.job_id)).trigger_mode,'previous_day_focus');
 assert.notEqual(previous.data.job_id,previousNormal.data.job_id);
 assert.equal((await req('/runtime/summaries/command','POST',{...base,seq:306,server_id:'902306',text:'/generate-summary 截止目前'},true)).status,400);
 for(const id of [focus.data.job_id,normal.data.job_id,previous.data.job_id,previousNormal.data.job_id])await req('/summaries/jobs/'+id+'/cancel','POST',{});
});

test('edited previews are revalidated; missing fields preserve the draft and model-made fourth chapter is discarded',async()=>{
 const g=await freshSummaryGroup();await save(g,{enabled:true,template:'entertainment'});const id=await create(g);await source(id,'ui_archive',g);await processSummary(caller);const before=await job(id);
 const bad=await req('/summaries/jobs/'+id+'/publish','POST',{report:report.replace('**今日高光时刻**：两位成员共同细化了验证方法。','')});assert.equal(bad.status,400);assert.deepEqual(await job(id),before);assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[id])).rowCount,0);
 const good=await req('/summaries/jobs/'+id+'/publish','POST',{report:report+'\n四、发言最多排行\n虚构999条'});assert.equal(good.status,200,JSON.stringify(good.data));const parts=(await pool.query('SELECT body FROM summary_parts WHERE job_id=$1 ORDER BY ordinal',[id])).rows.map(r=>r.body).join('\n');assert(!parts.includes('虚构999'));assert(parts.includes('文字输出榜'));assert(parts.includes('综合存在感榜'));assert(!((await job(id)).report.includes('虚构999')));await req('/summaries/jobs/'+id+'/cancel','POST',{});
});
test('038 upgrades old builtins and custom templates once, preserves names and old job snapshots',async()=>{
 const sql=await readFile(new URL('../migrations/038_summary_full_hermes_skills.sql',import.meta.url),'utf8'),legacy=JSON.parse(await readFile(new URL('../server/summaries/legacy-templates.json',import.meta.url),'utf8'));
 const g=await freshSummaryGroup(),id=await create(g),snapshot=(await job(id)).template;
 for(const [slug,instructions] of [['news',legacy.news],['ranking',legacy.ranking.split('【总结成员昵称格式】')[0]],['technical','后台定制：保留测试建议，不编造结论。']])await pool.query('UPDATE summary_templates SET name=$2,instructions=$3,revision=11 WHERE slug=$1',[slug,'自定义名称 '+slug,instructions]);
 await pool.query(sql);const first=(await pool.query("SELECT * FROM summary_templates WHERE slug IN ('news','ranking','technical') ORDER BY slug")).rows;await pool.query(sql);assert.deepEqual((await pool.query("SELECT * FROM summary_templates WHERE slug IN ('news','ranking','technical') ORDER BY slug")).rows,first);
 for(const row of first){assert(row.instructions.includes('[GroupDesk 完整 Skill v2:'+row.slug+']'));assert.equal(row.revision,12);assert.equal(row.name,'自定义名称 '+row.slug);if(row.slug==='technical')assert(row.instructions.includes('后台定制：保留测试建议'));else assert(!row.instructions.includes('## 保留的后台自定义要求'));}
 assert.deepEqual((await job(id)).template,snapshot);await req('/summaries/jobs/'+id+'/cancel','POST',{});
});

test('English and Japanese full report contracts run through generation and edited-preview publication',async()=>{
 for(const [language,heads,fields,extra] of [
  ['en',['I. Overall assessment','II. Main topics','III. Other topics'],['Topic','Participants','Time range','Discussion','Brief assessment'],['Highlights','Closing note']],
  ['ja',['一、全体評価','二、主な話題','三、その他の話題'],['話題名','主な参加者','時間帯','議論の経緯','短評'],['今日のハイライト','締めのひとこと']]
 ] as const){
  const g=await freshSummaryGroup();await save(g,{enabled:true,language,template:'news'});const id=await create(g);await source(id,'ui_archive',g);
  const text=heads[0]+'\nSynthetic assessment.\n'+heads[1]+'\n'+fields.map(f=>'**'+f+'**: Synthetic evidence.').join('\n')+'\n'+heads[2]+'\n'+extra.map(f=>'**'+f+'**: Synthetic evidence.').join('\n');
  await processSummary(async(_c,_m,system)=>{assert(system.includes(extra[0]));return {choices:[{message:{content:text}}]};});assert.equal((await job(id)).status,'preview',(await job(id)).error);
  assert.equal((await req('/summaries/jobs/'+id+'/publish','POST',{report:text})).status,200);const parts=(await pool.query('SELECT body FROM summary_parts WHERE job_id=$1',[id])).rows.map(r=>r.body).join('\n');assert(parts.includes(language==='en'?'IV. Activity rankings':'四、活動ランキング'));await req('/summaries/jobs/'+id+'/cancel','POST',{});
 }
});

test('legacy queued snapshots get full rules and fresh statistics; old previews without required statistics cannot publish',async()=>{
 // A fresh HTTP fixture isolates this final scenario from the 240/minute API limit.
 await new Promise<void>(r=>server.close(()=>r()));server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const g=await freshSummaryGroup();await save(g,{enabled:true,template:'entertainment'});const id=await create(g);await source(id,'ui_archive',g);
 const legacy=JSON.parse(await readFile(new URL('../server/summaries/legacy-templates.json',import.meta.url),'utf8'));
 await pool.query("UPDATE summary_jobs SET template=jsonb_set(template,'{instructions}',$2::jsonb),source=jsonb_set(source,'{stats}','{\"count\":2,\"capture_time_count\":1,\"unknown_sender_count\":0,\"rankings\":[]}'::jsonb) WHERE id=$1",[id,JSON.stringify(legacy.entertainment)]);
 await processSummary(async(c,m,system,input)=>{assert(system.includes('[GroupDesk 完整 Skill v2:entertainment]'));assert(system.includes('本次原始记录数为 2 条'));return caller(c,m,system,input);});
 const j=await job(id);assert.equal(j.status,'preview',j.error);assert.equal(j.template.instructions,legacy.entertainment);assert.equal(j.source.stats.stats_version,2);assert.equal(j.source.stats.characterRankings.length,2);
 await pool.query("UPDATE summary_jobs SET source=source#-'{stats,characterRankings}' WHERE id=$1",[id]);const before=await job(id);const r=await req('/summaries/jobs/'+id+'/publish','POST',{report});assert.equal(r.status,400);assert.match(r.data.error,/统计/);assert.deepEqual(await job(id),before);assert.equal((await pool.query('SELECT 1 FROM summary_parts WHERE job_id=$1',[id])).rowCount,0);await req('/summaries/jobs/'+id+'/cancel','POST',{});
});
