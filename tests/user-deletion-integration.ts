import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {createBot,ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {deleteBotRegistration} from '../server/deletion.js';
import {deleteUserAccount} from '../server/user-deletion.js';
import {initializeUserOwners} from '../server/user-access.js';
import {sealControlSecret} from '../server/bot-secrets.js';
import {digest,token} from '../server/security.js';
import {createUserSession} from '../server/users.js';
import {legacyBotId} from '../server/bot-context.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',admin:any,other:any,target:any,owned='',retainedKey='',siteKey='',usage='',grant='',requestId='';const bots:string[]=[];let ghId=8811,ghLogin='delete-site-user';
async function req(path:string,method='GET',body?:any,u=admin){if(method==='DELETE'&&body)body={reason:'test',reason_note:'自动隔离验证',...body};const response=await fetch(base+'/api'+path,{method,headers:{Cookie:u?.cookie||'','X-CSRF-Token':u?.csrf||'',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json().catch(()=>null),response};}
async function makeUser(name:string,github?:string){const id=randomUUID(),session=token(),csrf=token();await controlPool.query("INSERT INTO admins(id,username,password_hash,github_id,github_login,display_name,permissions) VALUES($1,$2,'!github-only',$3,$2,$2,'{\"bots.create\":true,\"bots.manage\":true,\"models.manage\":true}')",[id,name,github||name]);await controlPool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);return {id,username:name,cookie:'groupdesk_session='+session,csrf};}
async function preview(u:any){const r=await req('/users/'+u.id+'/deletion');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function remove(u:any,p?:any){p??=await preview(u);return req('/users/'+u.id,'DELETE',{revision:p.revision,confirmation:p.confirmation});}
async function key(owner:string,name:string,scope='private'){const id=randomUUID(),secret='synthetic-not-real-'+id;await controlPool.query("INSERT INTO managed_model_keys(id,owner_user_id,created_by_user_id,name,scope,base_url,client_type,secret_ciphertext,key_digest,key_hint,models) VALUES($1,$2,$3,$4,$5,'https://example.com/v1','openai',$6,$7,$8,'[{\"model_id\":\"synthetic-text\",\"capability\":\"text\"}]')",[id,owner,admin.id,name,scope,sealControlSecret(secret),digest(secret),'••••••'+secret.slice(-6)]);return id;}
async function bot(name:string,owner:string){const id=await createBot({name,wechat_id:name,host_label:'synthetic',notes:''},'admin',owner);bots.push(id);return id;}
const limits={daily_requests:10,monthly_requests:100,daily_tokens:1000,monthly_tokens:10000,daily_cost:null,monthly_cost:null,concurrency:1,alert_percent:80};
function grantBody(user_id:string,enabled=true){return {key_id:siteKey,user_id,enabled,bot_ids:[],group_ids:[],model_ids:['synthetic-text'],features:['chat'],expires_at:new Date(Date.now()+86400000).toISOString(),limits,review_note:''};}
before(async()=>{await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();await initializeUserOwners();server=createServer(createApp({githubRequest:async url=>url.endsWith('access_token')?{access_token:'synthetic-ephemeral-token'}:{id:ghId,login:ghLogin,name:'Synthetic renewed account'}}));await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD},null);admin={...login.data,cookie:login.response.headers.get('set-cookie')!.split(';')[0]};other=await makeUser('other-retained');target=await makeUser('delete-site-user','8811');siteKey=await key(admin.id,'Unchanged site key','site');});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of bots){const row=(await controlPool.query('SELECT db_name,db_role FROM managed_bots WHERE id=$1',[id])).rows[0];if(row){await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH(FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}}const legacy=(await controlPool.query('SELECT db_role FROM managed_bots WHERE id=$1',[legacyBotId])).rows[0];if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}await pool.end();});
test('only active super admins may delete; typed confirmation, revision, current login and last-admin guards are enforced',async()=>{
 for(const method of ['GET','DELETE'])assert.equal((await req('/users/'+target.id+(method==='GET'?'/deletion':''),method,method==='DELETE'?{revision:1,confirmation:target.username}:undefined,other)).status,403);
 await assert.rejects(deleteUserAccount(target.id,1,target.username,other.id,{reason:'test',reason_note:''}),{status:403});const p=await preview(target);assert(p.can_delete);assert(!JSON.stringify(p).includes('password_hash'));
 assert.equal((await req('/users/'+target.id,'DELETE',{revision:p.revision,confirmation:'wrong'})).status,400);assert.equal((await req('/users/'+target.id,'DELETE',{revision:p.revision+1,confirmation:p.confirmation})).status,409);const own=await preview(admin);assert(!own.can_delete);assert(own.reasons.some((s:string)=>s.includes('至少一名')));assert.equal((await remove(admin,own)).status,409);
});
test('live or archived bot ownership blocks deletion until explicitly deleted or transferred',async()=>{
 owned=await bot('synthetic_owned_before_user_delete',target.id);let p=await preview(target);assert.equal(p.counts.owned_bots,1);assert(!p.can_delete);assert.equal((await remove(target,p)).status,409);
 await controlPool.query("UPDATE managed_bots SET state='archived' WHERE id=$1",[owned]);assert(!(await preview(target)).can_delete);
 const b=(await controlPool.query('SELECT revision FROM managed_bots WHERE id=$1',[owned])).rows[0];await deleteBotRegistration(owned,b.revision,'synthetic_owned_before_user_delete','admin',{reason:'test',reason_note:''});assert((await preview(target)).can_delete);
});
test('owned unarchived keys and reserved usage block deletion; historical unknown amounts are retained',async()=>{
 retainedKey=await key(target.id,'Archived private test key');let p=await preview(target);assert.equal(p.counts.active_keys,1);assert(!p.can_delete);assert.equal((await remove(target,p)).status,409);
 await controlPool.query('UPDATE managed_model_keys SET archived=true,enabled=false WHERE id=$1',[retainedKey]);usage=randomUUID();await controlPool.query("INSERT INTO managed_model_usage(id,key_id,user_id,actor_user_id,bot_id,feature,model_id,currency,reserved_tokens,status) VALUES($1,$2,$3,$3,$4,'chat','synthetic-text','CNY',100,'reserved')",[usage,retainedKey,target.id,owned]);assert(!(await preview(target)).can_delete);await controlPool.query("UPDATE managed_model_usage SET status='unknown',dispatched=true WHERE id=$1",[usage]);assert((await preview(target)).can_delete);
});
test('deletion revokes sessions, grants and pending requests while preserving others and masked key ownership',async()=>{
 assert.equal((await req('/key-grants','PUT',grantBody(target.id))).status,200);assert.equal((await req('/key-grants','PUT',grantBody(other.id))).status,200);grant=(await controlPool.query('SELECT id FROM managed_model_grants WHERE key_id=$1 AND user_id=$2',[siteKey,target.id])).rows[0].id;
 requestId=randomUUID();await controlPool.query("INSERT INTO managed_model_requests(id,key_id,user_id,bot_id,reason,requested) VALUES($1,$2,$3,$4,'Synthetic request','{}')",[requestId,siteKey,target.id,owned]);
 const keyBefore=(await controlPool.query('SELECT owner_user_id,secret_ciphertext FROM managed_model_keys WHERE id=$1',[retainedKey])).rows[0],siteBefore=(await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[siteKey])).rows[0];
 assert.equal((await remove(target)).status,200);assert.equal((await req('/auth/me','GET',undefined,target)).status,401);assert.equal((await controlPool.query('SELECT count(*)::int n FROM sessions WHERE admin_id=$1',[target.id])).rows[0].n,0);await assert.rejects(createUserSession(target.id,{} as any),{status:403});
 assert.equal((await controlPool.query('SELECT enabled FROM managed_model_grants WHERE id=$1',[grant])).rows[0].enabled,false);assert.equal((await controlPool.query('SELECT status FROM managed_model_requests WHERE id=$1',[requestId])).rows[0].status,'cancelled');assert.equal((await controlPool.query('SELECT enabled FROM managed_model_grants WHERE user_id=$1',[other.id])).rows[0].enabled,true);
 assert.deepEqual((await controlPool.query('SELECT owner_user_id,secret_ciphertext FROM managed_model_keys WHERE id=$1',[retainedKey])).rows[0],keyBefore);assert.deepEqual((await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[siteKey])).rows[0],siteBefore);
 const listed=(await req('/keys')).data;assert(!listed.users.some((u:any)=>u.id===target.id));const k=listed.keys.find((k:any)=>k.id===retainedKey);assert(k.owner_name.includes('已删除账号'));assert(!k.can_reveal);assert(!JSON.stringify(k).includes(keyBefore.secret_ciphertext));assert.equal((await req('/keys/'+retainedKey+'/reveal','POST',{})).status,403);const usageRows=(await req('/key-usage')).data.rows;assert(usageRows.find((v:any)=>v.id===usage).display_name.includes('已删除账号'));assert.equal((await controlPool.query('SELECT status,cost FROM managed_model_usage WHERE id=$1',[usage])).rows[0].status,'unknown');assert((await controlPool.query("SELECT 1 FROM audit_logs WHERE action='user.account_deleted' AND target=$1",[target.id])).rowCount);
});
test('deleted IDs cannot be restored, assigned new keys, granted access, or used to provision new bots',async()=>{
 assert(!(await req('/users')).data.users.some((u:any)=>u.id===target.id));assert.equal((await req('/users/'+target.id+'/deletion')).status,404);assert.equal((await remove(target,{revision:1,confirmation:target.username})).status,404);
 assert.equal((await req('/users/'+target.id+'/access','PUT',{role:'user',status:'active',permissions:{},revision:2})).status,409);assert.equal((await req('/key-grants','PUT',grantBody(target.id))).status,400);
 assert.equal((await req('/keys','POST',{name:'Must not add',owner_user_id:target.id,scope:'private',base_url:'https://example.com/v1',client_type:'openai',api_key:'synthetic-key-only'})).status,400);
 await assert.rejects(bot('must_not_provision_deleted_user',target.id));assert.equal((await controlPool.query("SELECT 1 FROM managed_bots WHERE name='must_not_provision_deleted_user'")).rowCount,0);
 const k=(await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[retainedKey])).rows[0];assert.equal((await req('/keys/'+retainedKey,'PUT',{revision:k.revision,name:k.name,enabled:true,archived:false,scope:k.scope,base_url:k.base_url,client_type:k.client_type,currency:'CNY',prices:{},limits})).status,409);
});
async function githubLogin(){const start=await fetch(base+'/api/auth/github/start',{redirect:'manual'}),location=new URL(start.headers.get('location')!);return fetch(base+'/api/auth/github/callback?code=synthetic&state='+location.searchParams.get('state'),{redirect:'manual',headers:{Cookie:start.headers.get('set-cookie')!.split(';')[0]}});}
test('same GitHub identity may register repeatedly as a new pending UUID without inheriting permissions, keys or old grants',async()=>{
 const c=(await req('/users/github-settings')).data;assert.equal((await req('/users/github-settings','PUT',{client_id:'synthetic-client',client_secret:'synthetic-secret',enabled:true,registration_mode:'review',revision:c.revision})).status,200);
 const oldKey=(await controlPool.query('SELECT owner_user_id FROM managed_model_keys WHERE id=$1',[retainedKey])).rows[0];
 for(let i=0;i<2;i++){const login=await githubLogin();assert(login.headers.get('location')!.includes('login_error=pending'));assert(!login.headers.getSetCookie().some(c=>c.startsWith('groupdesk_session=')));const next=(await controlPool.query("SELECT * FROM admins WHERE github_id='8811' AND deleted_at IS NULL")).rows[0];assert.notEqual(next.id,target.id);assert.equal(next.status,'pending');assert.deepEqual(next.permissions,{});assert.equal((await controlPool.query('SELECT 1 FROM managed_bots WHERE owner_user_id=$1',[next.id])).rowCount,0);assert.equal((await controlPool.query('SELECT 1 FROM managed_model_keys WHERE owner_user_id=$1',[next.id])).rowCount,0);assert.equal((await controlPool.query('SELECT 1 FROM managed_model_grants WHERE user_id=$1',[next.id])).rowCount,0);assert.equal((await remove(next)).status,200);}
 assert.deepEqual((await controlPool.query('SELECT owner_user_id FROM managed_model_keys WHERE id=$1',[retainedKey])).rows[0],oldKey);await migrate();assert.equal((await req('/auth/me')).status,200);
});
test('concurrent grant and account deletion never leave active authorization on a deleted user',async()=>{
 const u=await makeUser('concurrent-delete-grant'),p=await preview(u);const results=await Promise.all([remove(u,p),req('/key-grants','PUT',grantBody(u.id))]);assert.equal(results[0].status,200);assert([200,400].includes(results[1].status));assert.equal((await controlPool.query('SELECT 1 FROM managed_model_grants WHERE user_id=$1 AND enabled',[u.id])).rowCount,0);
});
test('concurrent bot provisioning and deletion cannot create a live bot owned by a deleted user',async()=>{
 const u=await makeUser('concurrent-delete-bot'),p=await preview(u);const [deleted,created]=await Promise.all([remove(u,p),bot('concurrent_provision_delete',u.id).then(id=>({id})).catch(()=>({id:null}))]);
 assert([200,409].includes(deleted.status));if(created.id){assert.equal(deleted.status,409);assert.equal((await controlPool.query('SELECT deleted_at FROM admins WHERE id=$1',[u.id])).rows[0].deleted_at,null);}else assert.equal(deleted.status,200);
});
