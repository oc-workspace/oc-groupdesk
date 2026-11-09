import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {createBot,ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {botRecord,withBot} from '../server/bot-workspaces.js';
import {initializeUserOwners} from '../server/user-access.js';
import {requestActivation} from '../server/bot-lifecycle.js';
import {legacyBotId} from '../server/bot-context.js';
import {digest,token} from '../server/security.js';
import {createCredential} from '../server/models.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',admin:any,a:any,b:any,a1='',a2='',b1='',b2='';const created:string[]=[],tokens=new Map<string,string>(),instances=new Map<string,string>();
async function req(path:string,method='GET',body?:any,user=admin,runtime?:string){const r=await fetch(base+'/api'+path,{method,headers:{...(runtime?{Authorization:'Bearer '+runtime}:{Cookie:user.cookie,'X-CSRF-Token':user.csrf}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function user(name:string){const id=randomUUID(),session=token(),csrf=token();await controlPool.query("INSERT INTO admins(id,username,password_hash,role,github_id,github_login,permissions) VALUES($1,$2,'!github-only','user',$2,$2,'{\"bots.create\":true,\"bots.manage\":true,\"models.manage\":true}')",[id,name]);await controlPool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);return {id,cookie:'groupdesk_session='+session,csrf};}
async function create(name:string,u:any){const r=await req('/bots','POST',{name,wechat_id:name,notes:''},u);assert.equal(r.status,201,JSON.stringify(r.data));created.push(r.data.id);return r.data.id;}
async function flow(id:string,u:any=admin){const r=await req('/bots/'+id+'/onboarding','GET',undefined,u);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function heartbeat(id:string,extra:any={}){const row=await botRecord(id);if(!instances.has(id))instances.set(id,randomUUID());return req('/runtime/bot-heartbeat','POST',{contract:1,bot_id:id,instance_id:instances.get(id),account_fingerprint:digest(id),revision:row.revision,wechat_connected:true,reader_connected:true,maibot_connected:true,sender_queue_depth:0,active_turns:0,send_inflight:false,stopped:row.state!=='active',cutover_generation:row.activation_generation,local_ready:true,...extra},undefined,tokens.get(id));}
async function provision(id:string,u:any){
 let f=await flow(id,u);if(!f.environment_prepared){
 // Synthetic fixture of an already deployed environment, not a new hosted application.
 await controlPool.query("UPDATE managed_bot_onboarding SET environment_prepared_at=now(),environment_prepared_by=$2,desktop_url='https://desktop.example.com/' WHERE bot_id=$1",[id,admin.id]);
 }
 f=await flow(id,u);if(!f.account_confirmed)assert.equal((await req('/bots/'+id+'/onboarding/confirm-account','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},u)).status,200);
 f=await flow(id,u);if(!f.reader_authorized)assert.equal((await req('/bots/'+id+'/onboarding/authorize-reader','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},u)).status,200);
 await withBot(id,async()=>{const c=await createCredential({name:'Synthetic owned Key',base_url:'https://example.com/v1',api_key:'synthetic-key-'+id},u.id);await pool.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,'synthetic-text','synthetic-text','text','manual',false)",[c]);const key=(await pool.query('SELECT vault_key_id FROM model_credentials WHERE id=$1',[c])).rows[0].vault_key_id;await controlPool.query('UPDATE managed_model_keys SET models=$2 WHERE id=$1',[key,JSON.stringify([{model_id:'synthetic-text',display_name:'synthetic-text',capability:'text',source:'manual',listed:false}])]);await pool.query('UPDATE model_settings SET routes=$1',[{text:{credential_id:c,model_id:'synthetic-text'},image:null}]);});
 const tr=await req('/bots/'+id+'/connection-token','POST',{revision:(await botRecord(id)).revision},u);assert.equal(tr.status,200);tokens.set(id,tr.data.token);assert.equal((await heartbeat(id)).status,200);
}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');
 // Upgrade a real old-format pending switch rather than silently losing it.
 await controlPool.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());INSERT INTO schema_migrations(name) VALUES('026_bot_onboarding_bot_control.sql'),('034_device_onboarding_bot_control.sql')");
 await migrate();await ensureLegacyIsolation();await initializeUserOwners();
 const fixture=await createBot({name:'Pending upgrade fixture',wechat_id:'pending_upgrade_fixture',host_label:'synthetic',notes:''},'admin');created.push(fixture);
 await controlPool.query('INSERT INTO managed_bot_switch(singleton,target_id) VALUES(true,$1)',[fixture]);
 await controlPool.query("DELETE FROM schema_migrations WHERE name IN ('026_bot_onboarding_bot_control.sql','034_device_onboarding_bot_control.sql')");await migrate();
 const pending=(await controlPool.query('SELECT * FROM managed_bot_switch')).rows[0];assert.equal(pending.target_id,fixture);assert.equal(pending.owner_user_id,(await botRecord(fixture)).owner_user_id);assert.equal(pending.activation_slot,1);await controlPool.query('DELETE FROM managed_bot_switch');
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD},{cookie:'',csrf:''});admin={...login.data,cookie:login.response.headers.get('set-cookie')!.split(';')[0]};
 a=await user('onboarding_A');b=await user('onboarding_B');a1=await create('onboarding_A1',a);a2=await create('onboarding_A2',a);b1=await create('onboarding_B1',b);b2=await create('onboarding_B2',b);
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of created){const row=await botRecord(id);if(row?.db_name){await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}}const legacy=await botRecord(legacyBotId);await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));await pool.end();});
test('ordinary users cannot set or receive host labels, but can edit their own profile',async()=>{
 assert.equal((await req('/bots','POST',{name:'Forbidden host',wechat_id:'forbidden_host',host_label:'other-host'},a)).status,403);
 const list=await req('/bots','GET',undefined,a);assert.equal(list.data.active_limit_per_user,1);assert.equal(list.data.bots.length,2);assert(list.data.bots.every((x:any)=>!('host_label' in x)&&x.onboarding));
 const row=await botRecord(a1);assert.equal(row.host_label,'自部署设备（待接入）');assert.equal((await req('/bots/'+a1,'PUT',{name:row.name,wechat_id:row.wechat_id,notes:'edited',revision:row.revision},a)).status,200);assert.equal((await botRecord(a1)).host_label,'自部署设备（待接入）');
 assert.equal((await req('/bots/'+a1,'PUT',{name:row.name,wechat_id:row.wechat_id,notes:'',host_label:'other',revision:row.revision},a)).status,403);
});
test('tasks persist, start is idempotent, and all task and admin mutations enforce ownership',async()=>{
 const f=await flow(a1,a);assert.equal(f.steps.length,8);assert.equal(f.steps.filter((s:any)=>s.required).length,7);assert.equal(f.steps[1].status,'current');
 assert.equal((await req('/bots/'+a1+'/onboarding','POST',{},a)).status,200);assert.equal((await flow(a1,a)).revision,f.revision);
 assert.equal((await req('/bots/'+a1+'/onboarding','GET',undefined,b)).status,404);assert.equal((await req('/bots/'+a1+'/onboarding','POST',{},b)).status,404);
 assert.equal((await req('/bots/'+a1+'/onboarding/environment','PUT',{revision:f.revision,desktop_url:'https://desktop.example.com/',prepared:true},a)).status,403);
 assert.equal((await req('/bots/'+a1+'/onboarding/confirm-account','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},a)).status,409);
 assert.equal((await req('/bots/'+a1+'/onboarding/confirm-account','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true})).status,403);
});
test('login links reject secrets or unsafe schemes; environment marking cannot fake connected state',async()=>{
 const f=await flow(a1,a);for(const url of ['not a URL','javascript:alert(1)','https://name:secret@example.com/','https://example.com/?token=hidden','http://10.0.0.1:8080/'])assert.equal((await req('/bots/'+a1+'/onboarding/environment','PUT',{revision:f.revision,desktop_url:url,prepared:true})).status,400);
 assert.equal((await req('/bots/'+a1+'/onboarding/environment','PUT',{revision:f.revision,desktop_url:'http://127.0.0.1:18180/',prepared:true})).status,409);
 // Existing environment maintenance stays available; no new server is deployed.
 await controlPool.query('UPDATE managed_bot_onboarding SET environment_prepared_at=now(),environment_prepared_by=$2 WHERE bot_id=$1',[a1,admin.id]);
 const p=await req('/bots/'+a1+'/onboarding/environment','PUT',{revision:f.revision,desktop_url:'http://127.0.0.1:18180/',prepared:true});assert.equal(p.status,200);assert(p.data.desktop_is_local);assert(!p.data.runtime_ready);assert(!p.data.can_activate);
 assert.equal((await req('/bots/'+a1+'/onboarding/environment','PUT',{revision:f.revision,desktop_url:'',prepared:true})).status,409);
});
test('account declaration and reader consent are ordered, account-specific and signed only by current owner',async()=>{
 let f=await flow(a1,a);assert.equal((await req('/bots/'+a1+'/onboarding/authorize-reader','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},a)).status,409);
 assert.equal((await req('/bots/'+a1+'/onboarding/confirm-account','POST',{revision:f.revision,wechat_id:'wrong_account',confirmed:true},a)).status,409);
 assert.equal((await req('/bots/'+a1+'/onboarding/confirm-account','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},a)).status,200);
 f=await flow(a1,a);assert.equal((await req('/bots/'+a1+'/onboarding/authorize-reader','POST',{revision:f.revision,wechat_id:f.wechat_id,confirmed:true},a)).status,200);
 f=await flow(a1,a);assert(f.account_confirmed&&f.reader_authorized);assert(!f.runtime_ready);assert(!f.models_ready);assert(!f.can_activate);
 assert.equal((await req('/bots/'+a1+'/activate','POST',{revision:(await botRecord(a1)).revision},a)).status,409);
 assert(!JSON.stringify(f).includes('ciphertext'));assert(!JSON.stringify(f).includes('account_fingerprint'));
});
test('separate owners can activate independently while missing runtime or model settings still block new tasks',async()=>{
 await provision(a1,a);await provision(a2,a);await provision(b1,b);await provision(b2,b);
 let f=await flow(a1,a);assert(f.can_activate);await heartbeat(a1,{reader_connected:false});assert(!(await flow(a1,a)).can_activate);await heartbeat(a1);
 assert.equal((await req('/bots/'+a1+'/activate','POST',{revision:(await botRecord(a1)).revision},a)).status,200);
 assert.equal((await req('/bots/'+b1+'/activate','POST',{revision:(await botRecord(b1)).revision},b)).status,200);
 assert.equal((await botRecord(a1)).state,'active');assert.equal((await botRecord(b1)).state,'active');assert.equal((await botRecord(legacyBotId)).state,'active');
 assert((await flow(a1,a)).completed_at);assert((await flow(b1,b)).completed_at);
 await assert.rejects(controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[a2]),{code:'23505'});
 assert.equal((await req('/bots/'+b2+'/activate','POST',{revision:(await botRecord(b2)).revision},a)).status,404);await assert.rejects(requestActivation(b2,(await botRecord(b2)).revision,'onboarding_A',{id:a.id,role:'user'}),{status:404});
});
test('concurrent requests keep one switch per user and never pause another user',async()=>{
 const revision=(await botRecord(a2)).revision;const [x,y]=await Promise.all([1,2].map(()=>req('/bots/'+a2+'/activate','POST',{revision},a)));assert.deepEqual([x.status,y.status].sort(),[200,409]);
 assert.equal((await botRecord(a1)).state,'pausing');assert.equal((await botRecord(a2)).state,'paused');assert.equal((await botRecord(b1)).state,'active');
 assert.equal((await req('/bots/'+b2+'/activate','POST',{revision:(await botRecord(b2)).revision},b)).status,200);
 assert.equal((await controlPool.query('SELECT * FROM managed_bot_switch')).rowCount,2);
 const own=(await req('/bots','GET',undefined,a)).data;assert.equal(own.switches.length,1);assert.equal(own.switches[0].target_id,a2);assert.equal((await req('/bots','GET',undefined,b)).data.switches[0].target_id,b2);
});
test('each owner waits for their own exact drain acknowledgment and can finish without waiting for other owners',async()=>{
 await heartbeat(b1,{stopped:true,sender_queue_depth:1});assert.equal((await botRecord(b1)).state,'pausing');assert.equal((await botRecord(b2)).state,'paused');
 await heartbeat(a1,{stopped:true});assert.equal((await botRecord(a1)).state,'paused');assert.equal((await botRecord(a2)).state,'active');assert.equal((await botRecord(b2)).state,'paused');
 await heartbeat(b1,{stopped:true});assert.equal((await botRecord(b1)).state,'paused');assert.equal((await botRecord(b2)).state,'active');assert.equal((await botRecord(legacyBotId)).state,'active');
});
test('cancel only removes the target switch and owner transfer cannot bypass active or pending constraints',async()=>{
 await heartbeat(a1);assert.equal((await req('/bots/'+a1+'/activate','POST',{revision:(await botRecord(a1)).revision},a)).status,200);
 assert.equal((await req('/users/bot-owner/'+a1,'PUT',{owner_user_id:b.id})).status,409);
 assert.equal((await req('/bots/'+a1+'/cancel-activation','POST',{},b)).status,404);assert.equal((await req('/bots/'+a1+'/cancel-activation','POST',{},a)).status,200);
 assert.equal((await botRecord(a2)).state,'pausing');assert.equal((await botRecord(a1)).state,'paused');
 assert.equal((await req('/users/bot-owner/'+b2,'PUT',{owner_user_id:a.id})).status,409);
 assert.equal((await req('/users/bot-owner/'+a1,'PUT',{owner_user_id:b.id})).status,200);
 const f=await flow(a1,b);assert(!f.account_confirmed&&!f.reader_authorized);assert(!f.completed_at);assert.equal((await req('/bots/'+a1+'/onboarding','GET',undefined,a)).status,404);
});
test('new control tables are inaccessible to business roles and migration reruns preserve bot state',async()=>{
 await withBot(legacyBotId,async()=>{await assert.rejects(pool.query('SELECT * FROM managed_bot_onboarding'),{code:'42501'});});
 await withBot(b2,async()=>{await assert.rejects(pool.query('SELECT * FROM managed_bot_onboarding'),{code:'42P01'});});
 const before=(await controlPool.query('SELECT id,state,revision FROM managed_bots ORDER BY id')).rows;await migrate();assert.deepEqual((await controlPool.query('SELECT id,state,revision FROM managed_bots ORDER BY id')).rows,before);
});
