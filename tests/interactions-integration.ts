import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {digest} from '../server/security.js';
import {interactionBindingDefaults,interactionSettingsDefaults,interactionCommands,defaultInteractionId} from '../shared/interactions.js';
import {processInteractionTemplate} from '../server/interactions/templates.js';
import {baseTemplate,type Outcome} from '../server/interactions/copy.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw new Error('A dedicated groupdesk_test database is required');
let server:Server,base='',cookie='',csrf='',a:any,b:any,now=Date.now(),source=0;
const runtime={Authorization:'Bearer '+process.env.BOT_API_TOKEN};
async function req(path:string,method='GET',body?:unknown,bot=false,headers:Record<string,string>={}){
 const r=await fetch(base+'/api'+path,{method,headers:{...(bot?runtime:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json(),response:r};
}
async function group(id:string){return (await req('/interactions')).data.groups.find((g:any)=>g.id===id);}
async function configure(g:any,config:any={},settings:any={}){
 const current=await group(g.id);const r=await req('/interactions/groups/'+g.id,'PUT',{revision:current.revision,settings:{...interactionSettingsDefaults,...current.settings,...settings},bindings:[{definition_id:defaultInteractionId,config:{...interactionBindingDefaults,enabled:true,model_route:{mode:'disabled'},...config}}]});
 assert.equal(r.status,200,JSON.stringify(r.data));return group(g.id);
}
async function event(g:any,text='摸鱼',actor='alice',extra:any={}){
 now+=4000;const current=await group(g.id);return req('/runtime/interactions/events','POST',{external_id:g.external_id,revision:current.revision,binding_id:current.bindings[0].id,source_id:'test:'+(++source),actor:{id:actor,name:actor,kind:'group_nickname'},text,source_at:now/1000,mentioned:false,...extra},true);
}
async function stored(id:string){return (await pool.query('SELECT * FROM interaction_events WHERE id=$1',[id])).rows[0];}
async function wallet(g:any,name='alice'){return (await req('/interactions/groups/'+g.id+'/records')).data.wallets.find((w:any)=>w.display_name===name);}
async function prize(g:any,code:string,cost=10,stock:number|null=1){const current=await group(g.id);const r=await req('/interactions/groups/'+g.id+'/prizes','POST',{group_revision:current.revision,code,name:'测试奖品 '+code,description:'',cost,stock,enabled:true});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id;}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 server=createServer(createApp({interactions:{clock:()=>now,random:(min,max)=>Math.min(min+22,max-1)}}));await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 const groups=(await req('/overview')).data.groups;
 a=(await req('/groups/'+groups[0].id,'PUT',{...groups[0],enabled:true,external_id:'interaction-test-A'})).data;
 b=(await req('/groups/'+groups[1].id,'PUT',{...groups[1],enabled:true,external_id:'interaction-test-B'})).data;
 a=await configure(a);b=await configure(b);a.external_id='interaction-test-A';b.external_id='interaction-test-B';
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('interaction administration requires authentication and CSRF; adapter capability is applied explicitly',async()=>{
 assert.equal((await req('/interactions','GET',undefined,false,{Cookie:''})).status,401);
 assert.equal((await req('/interactions/definitions','POST',{},false,{'X-CSRF-Token':'wrong'})).status,403);
 const config=await req('/runtime/config/'+a.external_id,'GET',undefined,true);assert.equal(config.data.interactions_contract_version,1);assert.equal(config.data.interactions.bindings.length,1);
 assert(!JSON.stringify(config.data.interactions).includes('key_ciphertext'));
 assert.equal((await req('/runtime/ack','POST',{group_id:a.id,revision:config.data.revision,timeout_policy_version:2},true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{group_id:a.id,revision:config.data.revision,timeout_policy_version:2,interactions_policy_version:1},true)).status,200);
});
test('each message is idempotent and each member earns only one daily award',async()=>{
 const first=await event(a);assert.equal(first.status,200);assert.equal(first.data.outcome,'checked_in');
 const row=await stored(first.data.event_id);assert.equal(row.data.amount,23);assert.match(row.response,/23 token/);
 const current=await group(a.id),body={external_id:a.external_id,revision:current.revision,binding_id:current.bindings[0].id,source_id:row.source_id,actor:{id:'alice',name:'alice',kind:'group_nickname'},text:'摸鱼',source_at:now/1000,mentioned:false};
 assert.equal((await req('/runtime/interactions/events','POST',body,true)).data.duplicate,true);
 assert.equal((await req('/runtime/interactions/events','POST',{...body,actor:{...body.actor,id:'imposter'}},true)).status,409);
 assert.equal((await event(a)).data.outcome,'already_today');assert.equal((await wallet(a)).balance,23);
 assert.equal((await pool.query("SELECT count(*)::int n FROM interaction_ledger WHERE reason='checkin'")).rows[0].n,1);
 const results=await Promise.all([event(a,'摸鱼','race'),event(a,'摸鱼','race')]);assert.equal(results.filter(r=>r.data.outcome==='checked_in').length,1);assert.equal((await wallet(a,'race')).balance,23);
});
test('group balances and local calendar days are independent',async()=>{
 assert.equal((await event(b)).data.outcome,'checked_in');assert.equal((await wallet(b)).balance,23);assert.equal((await wallet(a)).balance,23);
 now+=86400000;assert.equal((await event(a)).data.outcome,'checked_in');assert.equal((await wallet(a)).balance,46);
 await configure(b,{reward_min:7,reward_max:7});assert.equal((await event(b,'摸鱼','fixed')).data.outcome,'checked_in');assert.equal((await wallet(b,'fixed')).balance,7);
});
test('stale messages, fabricated amounts and scoped adapters cannot mint tokens',async()=>{
 assert.equal((await event(a,'摸鱼','stale',{source_at:(now-100000)/1000})).status,400);
 assert.equal((await event(a,'摸鱼','stale',{revision:1})).status,409);
 assert.equal((await event(a,'摸鱼','stale',{amount:100000})).status,400);
 const token='isolated-interactions-adapter-scoped';await pool.query('INSERT INTO runtime_adapters VALUES($1,$2,$3,now())',[digest(token),'isolated',JSON.stringify([b.external_id])]);
 assert.equal((await event(a,'摸鱼','scoped',{external_id:'no-such-group'})).status,404);
 const current=await group(a.id);assert.equal((await req('/runtime/interactions/events','POST',{external_id:a.external_id,revision:current.revision,binding_id:current.bindings[0].id,source_id:'forbidden',actor:{id:'x',name:'x',kind:'stable'},text:'摸鱼',source_at:now/1000,mentioned:false},true,{Authorization:'Bearer '+token})).status,403);
 assert.equal(await wallet(a,'stale'),undefined);
});
test('empty prize replies use the member command language and explain the owner discussion',async()=>{
 const zh=await stored((await event(a,'可以兑换啥')).data.event_id);assert.equal(zh.outcome,'catalog_empty');assert.match(zh.response,/现在还没定奖品，可以找群主商量/);
 const en=await stored((await event(a,'what can I redeem')).data.event_id);assert.equal(en.locale,'en');assert.match(en.response,/Talk to the group owner/);assert(!/[\u4e00-\u9fff]/.test(en.response));
 const ja=await stored((await event(a,'景品')).data.event_id);assert.equal(ja.locale,'ja');assert.match(ja.response,/景品/);
});
test('prize lists display stable redeem commands, reserve stock and prevent double spending',async()=>{
 await prize(a,'R001',10,1);await prize(a,'R002',15,null);
 const catalog=await stored((await event(a,'兑换列表')).data.event_id);assert.match(catalog.response,/兑换列表\n1\. 测试奖品 R001/);assert.match(catalog.response,/2\. 测试奖品 R002/);assert.match(catalog.response,/兑换 R001/);
 const first=await event(a,'兑换 R001'),again=await event(a,'兑换 R001');assert.equal(first.data.outcome,'redemption_pending');assert.equal(again.data.outcome,'out_of_stock');
 const w=await wallet(a);assert.equal(w.balance,46);assert.equal(w.reserved,10);
 const poor=await event(a,'兑换 R002','poor');assert.equal(poor.data.outcome,'insufficient');
 const orders=(await req('/interactions/groups/'+a.id+'/records')).data.orders;assert.equal(orders.length,1);
 const order=orders[0];assert.equal((await req('/interactions/redemptions/'+order.id+'/review','POST',{action:'approve',note:'已确认'})).status,200);
 assert.equal((await wallet(a)).balance,36);assert.equal((await wallet(a)).reserved,0);
 assert.equal((await req('/interactions/redemptions/'+order.id+'/review','POST',{action:'approve',note:'重试'})).data.unchanged,true);assert.equal((await wallet(a)).balance,36);
 assert.equal((await req('/interactions/redemptions/'+order.id+'/review','POST',{action:'cancel',note:'取消返还'})).status,200);assert.equal((await wallet(a)).balance,46);
 assert.equal((await group(a.id)).prizes.find((p:any)=>p.code==='R001').stock,1);
});
test('concurrent last-stock requests produce one order; rejection releases the hold',async()=>{
 await event(a,'摸鱼','bob');
 const results=await Promise.all([event(a,'兑换 R001','alice'),event(a,'兑换 R001','bob')]);assert.equal(results.filter(r=>r.data.outcome==='redemption_pending').length,1);
 const order=(await req('/interactions/groups/'+a.id+'/records')).data.orders.find((r:any)=>r.status==='pending');
 const name=order.display_name,before=(await wallet(a,name)).balance;
 assert.equal((await req('/interactions/redemptions/'+order.id+'/review','POST',{action:'reject',note:'取消申请'})).status,200);assert.equal((await wallet(a,name)).balance,before);assert.equal((await wallet(a,name)).reserved,0);
 const pending=await event(a,'兑换 R002');assert.equal(pending.data.outcome,'redemption_pending');
 const active=(await req('/interactions/groups/'+a.id+'/records')).data.orders.find((r:any)=>r.event_id===pending.data.event_id);
 assert.equal((await req('/interactions/redemptions/'+active.id+'/review','POST',{action:'fulfill',note:''})).status,409);
 await req('/interactions/redemptions/'+active.id+'/review','POST',{action:'approve',note:''});await req('/interactions/redemptions/'+active.id+'/review','POST',{action:'fulfill',note:'手工交付'});
 assert.equal((await req('/interactions/redemptions/'+active.id+'/review','POST',{action:'cancel',note:''})).status,409);
});
test('administrator adjustments are audited, idempotent and cannot spend held points',async()=>{
 const w=await wallet(a),body={actor_key:w.actor_key,delta:10,reason:'测试补发',request_id:randomUUID()};
 assert.equal((await req('/interactions/groups/'+a.id+'/adjust','POST',body)).status,200);assert.equal((await req('/interactions/groups/'+a.id+'/adjust','POST',body)).status,200);assert.equal((await wallet(a)).balance,w.balance+10);
 assert.equal((await req('/interactions/groups/'+a.id+'/adjust','POST',{...body,delta:11})).status,409);
 assert.equal((await req('/interactions/groups/'+a.id+'/adjust','POST',{...body,request_id:randomUUID(),delta:-100000})).status,400);
});
test('delivery is reserved only once, rejects other adapters and expires without sending',async()=>{
 const result=await event(a,'余额'),current=await group(a.id),path='/runtime/interactions/events/'+result.data.event_id;
 assert.equal((await req(path+'/delivery','POST',{status:'sent'},true)).status,409);
 assert.equal((await req(path+'/reserve','POST',{revision:current.revision},true)).data.send,true);
 assert.equal((await req(path+'/reserve','POST',{revision:current.revision},true)).data.send,false);
 assert.equal((await req(path+'/delivery','POST',{status:'sent'},true)).status,200);assert.equal((await req(path+'/delivery','POST',{status:'uncertain'},true)).status,409);
 const uncertain=await event(a,'余额');assert.equal((await req('/runtime/interactions/events/'+uncertain.data.event_id+'/delivery','POST',{status:'uncertain'},true)).status,200);
 const expired=await event(a,'余额');now+=421000;assert.equal((await req('/runtime/interactions/events/'+expired.data.event_id+'/reserve','POST',{revision:current.revision},true)).status,409);
});
test('per-group quotas and disabling an interaction suppress new awards',async()=>{
 await configure(b,{},{daily_reply_limit:1,minute_reply_limit:60});
 // Start a clean configured day, independent from earlier daily activity.
 now+=86400000;assert.equal((await event(b,'摸鱼','quota1')).data.outcome,'checked_in');assert.equal((await event(b,'摸鱼','quota2')).data.suppressed,'daily_limit');assert.equal(await wallet(b,'quota2'),undefined);
 await configure(b,{enabled:false});assert.equal((await event(b,'摸鱼','disabled')).status,409);assert.equal(await wallet(b,'disabled'),undefined);
});
test('late interaction replies use the configured apology in the same delivery',async()=>{
 const result=await event(a,'余额'),current=await group(a.id);now+=301000;
 const reserved=await req('/runtime/interactions/events/'+result.data.event_id+'/reserve','POST',{revision:current.revision},true);
 assert.equal(reserved.data.send,true);assert.match(reserved.data.text,/^抱歉久等/);assert.match(reserved.data.text,/当前余额/);
});
test('text models render cached templates without seeing member identities or balances',async()=>{
 for(const protocol of ['openai','openai_responses','gemini']){
  const credential=(await req('/model-credentials','POST',{name:'Game '+protocol,base_url:'https://api.example.com/v1',api_key:'isolated-game-secret-'+protocol,client_type:protocol})).data.id;
  await req('/model-credentials/'+credential+'/models','POST',{model_id:'game-text',capability:'text'});
  await req('/model-credentials/'+credential+'/models','POST',{model_id:'game-image',capability:'image'});
  const c=await group(a.id);assert.equal((await req('/interactions/groups/'+a.id,'PUT',{revision:c.revision,settings:c.settings,bindings:[{definition_id:defaultInteractionId,config:{...interactionBindingDefaults,enabled:true,model_route:{mode:'custom',credential_id:credential,model_id:'game-image'}}}]})).status,400);
  await configure(a,{model_route:{mode:'custom',credential_id:credential,model_id:'game-text'}});
  const first=await event(a,'摸鱼','PrivateAlice-'+protocol);assert.equal(first.data.outcome,'checked_in');
  let calls=0;while(await processInteractionTemplate(async(c,model,system,input)=>{
   calls++;assert.equal(c.id,credential);assert.equal(model,'game-text');assert.match(system,/身份|角色/);assert(!input.includes('PrivateAlice'));assert(!input.includes('isolated-game-secret'));assert(!input.includes('"amount":23'));
   const v=JSON.parse(input),text=JSON.stringify({locale:v.locale,template:baseTemplate(v.locale,v.outcome as Outcome)});
   return protocol==='gemini'?{candidates:[{content:{parts:[{text}]}}]}:protocol==='openai_responses'?{output:[{type:'message',content:[{type:'output_text',text}]}]}:{choices:[{message:{content:text}}]};
  })){}assert.equal(calls,1);
  const again=await event(a,'摸鱼','Other-'+protocol);assert.equal(again.data.outcome,'checked_in');assert.equal((await pool.query("SELECT count(*)::int n FROM interaction_templates WHERE status='pending'")).rows[0].n,0);
 }
});
test('custom text interactions share routing controls without awarding points; templates can be archived',async()=>{
 const definition={name:'测试打招呼',kind:'custom_reply',description:'',instructions:'',commands:{'zh-CN':{checkin:['测试互动'],balance:[],catalog:[],redeem:[]}}};
 const id=(await req('/interactions/definitions','POST',definition)).data.id,current=await group(a.id);
 const saved=await req('/interactions/groups/'+a.id,'PUT',{revision:current.revision,settings:current.settings,bindings:[...current.bindings.map((b:any)=>({definition_id:b.definition_id,config:b.config})),{definition_id:id,config:{...interactionBindingDefaults,enabled:true,fixed_reply:'你好，鱼塘营业了。',model_route:{mode:'disabled'}}}]});assert.equal(saved.status,200);
 const latest=await group(a.id),binding=latest.bindings.find((b:any)=>b.definition_id===id);const result=await event(a,'测试互动','custom',{binding_id:binding.id});assert.equal(result.data.outcome,'custom_reply');assert.equal((await wallet(a,'custom')).balance,0);
 const row=await stored(result.data.event_id);assert.equal(row.response,'你好，鱼塘营业了。');
 const defs=(await req('/interactions')).data.definitions,def=defs.find((d:any)=>d.id===id);
 assert.equal((await req('/interactions/definitions/'+id+'/archive','POST',{revision:def.revision,archived:true})).status,200);
 assert.equal((await req('/runtime/config/'+a.external_id,'GET',undefined,true)).data.interactions.bindings.some((b:any)=>b.definition_id===id),false);
});
test('all balances and holds reconcile with the immutable ledger and outstanding orders',async()=>{
 const wallets=(await pool.query('SELECT * FROM interaction_wallets')).rows;
 for(const w of wallets){
  const ledger=(await pool.query('SELECT coalesce(sum(delta),0)::int n FROM interaction_ledger WHERE group_id=$1 AND actor_key=$2',[w.group_id,w.actor_key])).rows[0].n;
  const held=(await pool.query("SELECT coalesce(sum(cost),0)::int n FROM interaction_redemptions WHERE group_id=$1 AND actor_key=$2 AND status='pending'",[w.group_id,w.actor_key])).rows[0].n;
  assert.equal(w.balance,ledger);assert.equal(w.reserved,held);
 }
});
