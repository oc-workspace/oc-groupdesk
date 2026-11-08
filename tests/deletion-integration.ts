import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {deleteBotRegistration,deleteGroupConfiguration} from '../server/deletion.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {createBot,ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {botRecord,withBot,listedWorkspaces} from '../server/bot-workspaces.js';
import {initializeUserOwners} from '../server/user-access.js';
import {botPrincipal,initializeKeyVault} from '../server/key-vault.js';
import {legacyBotId,botStorage} from '../server/bot-context.js';
import {digest,token} from '../server/security.js';
import {sealControlSecret} from '../server/bot-secrets.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',admin:any,user:any,a='',b='',group='',otherGroup='',bound='',ta='',key='',usage='',document='';let groupBefore:any,siteKey='',grantBody:any;const created:string[]=[];
async function req(path:string,method='GET',body?:any,u=admin,botId?:string,runtime?:string){if(method==='DELETE'&&body)body={reason:'test',reason_note:'自动隔离验证',...body};const r=await fetch(base+'/api'+path,{method,headers:{...(runtime?{Authorization:'Bearer '+runtime}:{Cookie:u.cookie,'X-CSRF-Token':u.csrf}),...(botId?{'X-GroupDesk-Bot':botId}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function preview(id:string,kind='bot',scope=a){const r=await req(kind==='bot'?'/bots/'+id+'/deletion':'/groups/'+id+'/deletion','GET',undefined,admin,kind==='bot'?undefined:scope);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function create(name:string,owner:string){const id=await createBot({name,wechat_id:name,host_label:'synthetic-host',notes:''},'admin',owner);created.push(id);return id;}
async function g(name:string,scope=a,external:string|null=null){return withBot(scope,async()=>{const id=randomUUID();await pool.query('INSERT INTO groups(id,name,external_id,created_by_user_id) VALUES($1,$2,$3,$4)',[id,name,external,admin.id]);return id;});}
async function removeBot(id:string,p?:any){p??=await preview(id);return req('/bots/'+id,'DELETE',{revision:p.revision,confirmation:p.confirmation});}
async function removeGroup(id:string,p?:any,scope=a){p??=await preview(id,'group',scope);return req('/groups/'+id,'DELETE',{revision:p.revision,confirmation:p.confirmation},admin,scope);}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();await initializeUserOwners();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD},{cookie:'',csrf:''});admin={...login.data,cookie:login.response.headers.get('set-cookie')!.split(';')[0]};
 const id=randomUUID(),session=token(),csrf=token();await controlPool.query("INSERT INTO admins(id,username,password_hash,role,permissions) VALUES($1,'deletion_user','!github-only','user','{\"bots.create\":true,\"bots.manage\":true,\"groups.manage\":true,\"models.manage\":true}')",[id]);await controlPool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);user={id,cookie:'groupdesk_session='+session,csrf};
 a=await create('deletion_A',user.id);b=await create('deletion_B',admin.id);group=await g('仅删除这个群');otherGroup=await g('保留的群');bound=await g('绑定群',''+a,'synthetic-bound-chat');
 const tr=await req('/bots/'+a+'/connection-token','POST',{revision:(await botRecord(a)).revision});assert.equal(tr.status,200);ta=tr.data.token;
 assert.equal((await req('/bots/'+a+'/connection-groups','PUT',{external_ids:['synthetic-bound-chat']})).status,200);
 key=randomUUID();usage=randomUUID();await controlPool.query("INSERT INTO managed_model_keys(id,owner_user_id,created_by_user_id,name,scope,base_url,client_type,secret_ciphertext,key_digest,key_hint) VALUES($1,$2,$2,'Synthetic retained key','private','https://example.com/v1','openai',$3,$4,'••••••KEEP66')",[key,user.id,sealControlSecret('synthetic-never-sent-KEEP66'),digest('synthetic-never-sent-KEEP66')]);
 await controlPool.query("INSERT INTO managed_model_usage(id,key_id,user_id,actor_user_id,bot_id,group_id,feature,model_id,currency,reserved_tokens,status,dispatched) VALUES($1,$2,$3,$3,$4,$5,'chat','synthetic-text','CNY',100,'unknown',true)",[usage,key,user.id,a,group]);
 siteKey=randomUUID();await controlPool.query("INSERT INTO managed_model_keys(id,owner_user_id,created_by_user_id,name,scope,base_url,client_type,secret_ciphertext,key_digest,key_hint,models) VALUES($1,$2,$2,'Synthetic site key','site','https://example.com/v1','openai',$3,$4,'••••••SITE66',$5)",[siteKey,admin.id,sealControlSecret('synthetic-site-only-SITE66'),digest('synthetic-site-only-SITE66'),JSON.stringify([{model_id:'synthetic-text',capability:'text'}])]);
 grantBody={key_id:siteKey,user_id:user.id,enabled:true,bot_ids:[a],group_ids:[group],model_ids:['synthetic-text'],features:['chat'],expires_at:new Date(Date.now()+86400000).toISOString(),limits:{daily_requests:10,monthly_requests:100,daily_tokens:1000,monthly_tokens:10000,daily_cost:null,monthly_cost:null,concurrency:1,alert_percent:80},review_note:''};assert.equal((await req('/key-grants','PUT',grantBody)).status,200);

});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of created){const row=(await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[id])).rows[0];if(row?.db_name){await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}}const legacy=(await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[legacyBotId])).rows[0];if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}await pool.end();});
test('only the super administrator can inspect or delete, including ordinary owners with all management permissions',async()=>{
 for(const path of ['/bots/'+a,'/groups/'+group]){assert.equal((await req(path+'/deletion','GET',undefined,user,a)).status,403);assert.equal((await req(path,'DELETE',{revision:1,confirmation:'x'},user,a)).status,403);}
 assert.equal((await req('/groups/'+group+'/deletion','GET',undefined,admin,b)).status,404);assert.equal((await req('/groups/'+group,'DELETE',{revision:1,confirmation:'仅删除这个群'},admin,b)).status,404);
 await assert.rejects(deleteBotRegistration(a,(await botRecord(a)).revision,'deletion_A','deletion_user',{reason:'test',reason_note:''}),{status:403});await assert.rejects(withBot(a,()=>deleteGroupConfiguration(a,group,1,'仅删除这个群','deletion_user',{reason:'test',reason_note:''})),{status:403});
 const p=await preview(a);assert(p.can_delete);assert.equal(p.counts.groups,3);assert(!JSON.stringify(p).includes('ciphertext'));assert(!JSON.stringify(p).includes(ta));
});
test('typed confirmation and exact revision are mandatory and wrong input changes nothing',async()=>{
 let p=await preview(group,'group');assert.equal((await req('/groups/'+group,'DELETE',{revision:p.revision,confirmation:'wrong'},admin,a)).status,400);
 assert.equal((await req('/groups/'+group,'DELETE',{revision:p.revision+1,confirmation:p.confirmation},admin,a)).status,409);
 const bp=await preview(a);assert.equal((await req('/bots/'+a,'DELETE',{revision:bp.revision,confirmation:'wrong'})).status,400);assert.equal((await req('/bots/'+a,'DELETE',{revision:bp.revision+1,confirmation:bp.confirmation})).status,409);assert(await botRecord(a));
});
test('active bots, bound groups without a stop, and pending cutovers cannot be deleted',async()=>{
 await controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[a]);assert(!(await preview(a)).can_delete);assert.equal((await removeBot(a)).status,409);assert(!(await preview(bound,'group')).can_delete);assert.equal((await removeGroup(bound)).status,409);
 await controlPool.query("UPDATE managed_bots SET state='paused' WHERE id=$1",[a]);await controlPool.query('INSERT INTO managed_bot_switch(owner_user_id,activation_slot,target_id) VALUES($1,1,$2)',[user.id,a]);assert(!(await preview(a)).can_delete);assert.equal((await removeBot(a)).status,409);await controlPool.query('DELETE FROM managed_bot_switch WHERE target_id=$1',[a]);
});
test('in-flight model accounting and background processing block deletion; unknown settled accounting is retained',async()=>{
 await controlPool.query("UPDATE managed_model_usage SET status='reserved' WHERE id=$1",[usage]);assert(!(await preview(a)).can_delete);assert(!(await preview(group,'group')).can_delete);assert.equal((await removeBot(a)).status,409);await controlPool.query("UPDATE managed_model_usage SET status='unknown' WHERE id=$1",[usage]);
 await withBot(a,async()=>{const kb=randomUUID();document=randomUUID();await pool.query("INSERT INTO knowledge_bases(id,name) VALUES($1,'Retained KB')",[kb]);await pool.query("INSERT INTO documents(id,kb_id,title,kind,status) VALUES($1,$2,'Busy document','text','processing')",[document,kb]);});assert(!(await preview(a)).can_delete);assert.equal((await removeBot(a)).status,409);await withBot(a,()=>pool.query("UPDATE documents SET status='ready' WHERE id=$1",[document]));
});
test('a bound account needs a verifiable drained stop, including stale heartbeat handling',async()=>{
 const row=await botRecord(b);await controlPool.query('UPDATE managed_bots SET runtime_instance_id=$2,account_fingerprint=$3,runtime_seen_at=now(),runtime_status=$4 WHERE id=$1',[b,randomUUID(),digest(b),{revision:row.revision,stopped:true,sender_queue_depth:1,active_turns:0,send_inflight:false}]);assert(!(await preview(b)).can_delete);
 await controlPool.query('UPDATE managed_bots SET runtime_status=$2 WHERE id=$1',[b,{revision:row.revision,stopped:true,sender_queue_depth:0,active_turns:0,send_inflight:false}]);assert((await preview(b)).can_delete);
 await controlPool.query("UPDATE managed_bots SET runtime_seen_at=now()-interval '1 hour' WHERE id=$1",[b]);assert(!(await preview(b)).can_delete);
 await controlPool.query('UPDATE managed_bots SET stopped_revision=revision WHERE id=$1',[b]);assert((await preview(b)).can_delete);
 await controlPool.query("UPDATE managed_bots SET runtime_instance_id=NULL,account_fingerprint=NULL,runtime_status='{}',runtime_seen_at=NULL,stopped_revision=NULL WHERE id=$1",[b]);
});
test('two concurrent deletions affect one target exactly once and keep another group intact',async()=>{
 const id=await g('Concurrent deletion fixture',b);const p=await preview(id,'group',b);const results=await Promise.all([removeGroup(id,p,b),removeGroup(id,p,b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);assert((await req('/overview','GET',undefined,admin,a)).data.groups.some((g:any)=>g.id===otherGroup));
});
test('group removal disables plans, releases bindings and access while retaining independent resources and billing',async()=>{
 groupBefore=(await req('/overview','GET',undefined,admin,a)).data.groups.find((x:any)=>x.id===group);
 await withBot(a,async()=>{const topic=(await pool.query('SELECT id FROM topics LIMIT 1')).rows[0].id;await pool.query('INSERT INTO group_topics VALUES($1,$2)',[group,topic]);const member=randomUUID();await pool.query("INSERT INTO memberships(id,group_id,user_id,display_name,evidence,verified_by) VALUES($1,$2,'synthetic_member','Synthetic','manual',$3)",[member,group,admin.id]);await pool.query("INSERT INTO dm_scenes(user_id,group_id,expires_at) VALUES('synthetic_member',$1,now()+interval '1 hour')",[group]);});
 const oldCounts=(await req('/overview','GET',undefined,admin,a)).data;
 assert.equal((await removeGroup(group)).status,200);const overview=(await req('/overview','GET',undefined,admin,a)).data;assert(!overview.groups.some((g:any)=>g.id===group));assert(overview.groups.some((g:any)=>g.id===otherGroup));assert.equal(overview.topics.length,oldCounts.topics.length);assert.equal(overview.knowledge_bases.length,oldCounts.knowledge_bases.length);
 for(const path of ['/groups/status','/summaries','/persona-studio','/interactions','/reply-frequency','/keys']){const r=await req(path,'GET',undefined,admin,a);assert.equal(r.status,200,JSON.stringify(r.data));assert(!(r.data.groups||r.data.bindings||r.data).some((x:any)=>x.id===group||x.group_id===group));}
 assert.equal((await req('/groups/'+group,'PUT',groupBefore,admin,a)).status,404);assert.equal((await req('/persona-bindings/'+group,'GET',undefined,admin,a)).status,404);assert.equal((await removeGroup(group,{revision:1,confirmation:'仅删除这个群'})).status,404);
 await withBot(a,async()=>{assert.equal((await pool.query('SELECT * FROM group_topics WHERE group_id=$1',[group])).rowCount,0);assert.equal((await pool.query('SELECT * FROM dm_scenes WHERE group_id=$1',[group])).rowCount,0);assert((await pool.query('SELECT revoked_at FROM memberships WHERE group_id=$1',[group])).rows[0].revoked_at);});assert.equal((await controlPool.query('SELECT status FROM managed_model_usage WHERE id=$1',[usage])).rows[0].status,'unknown');
});
test('disabled tombstones let existing adapters continue configuration sync and ACK without reopening the group',async()=>{
 assert.equal((await removeGroup(bound)).status,200);await controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[a]);
 const r=await req('/runtime/config/synthetic-bound-chat','GET',undefined,undefined,undefined,ta);assert.equal(r.status,200,JSON.stringify(r.data));assert(r.data.removed);assert.equal(r.data.enabled,false);assert.deepEqual(r.data.topic_ids,[]);assert.deepEqual(r.data.kb_ids,[]);assert.equal(r.data.model_routing.text.source,'disabled');assert(!('deleted_by' in r.data));assert(!('deletion_reason' in r.data));assert(!('deletion_note' in r.data));
 const c=r.data,ack=await req('/runtime/ack','POST',{group_id:c.id,revision:c.revision,timeout_policy_version:3,reply_limits_version:1,reply_frequency_version:1,reply_frequency_revision:c.reply_frequency.revision,model_routing_version:1,bot_identity_version:1,bot_identity_sha256:c.bot_identity_sha256},undefined,undefined,ta);assert.equal(ack.status,200,JSON.stringify(ack.data));
 await controlPool.query("UPDATE managed_bots SET state='paused' WHERE id=$1",[a]);const replacement=await g('重新接入的绑定群',a,'synthetic-bound-chat');assert.notEqual(replacement,bound);const now=(await req('/overview','GET',undefined,admin,a)).data;assert(now.groups.some((x:any)=>x.id===replacement));assert(!now.groups.some((x:any)=>x.id===bound));
});
test('deleting a bot revokes credentials, hides every management entry, and does not erase paid keys or unknown usage',async()=>{
 const beforeKey=(await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[key])).rows[0];assert.equal((await removeBot(a)).status,200);assert.equal(await botRecord(a),undefined);assert(!(await listedWorkspaces()).some(x=>x.id===a));
 for(const path of ['/bots/'+a+'/onboarding','/bots/'+a+'/connection','/bots/'+a+'/deletion'])assert.equal((await req(path)).status,404);assert.equal((await req('/overview','GET',undefined,admin,a)).status,404);assert((await req('/runtime/bot-state','GET',undefined,undefined,undefined,ta)).status>=400);
 assert(!(await req('/bots')).data.bots.some((x:any)=>x.id===a));const vault=(await req('/keys')).data;assert(!vault.bots.some((x:any)=>x.id===a));assert(vault.keys.some((x:any)=>x.id===key));assert.equal((await controlPool.query('SELECT * FROM managed_bot_adapters WHERE bot_id=$1',[a])).rowCount,0);
 assert.deepEqual((await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[key])).rows[0],beforeKey);assert.equal((await controlPool.query('SELECT status FROM managed_model_usage WHERE id=$1',[usage])).rows[0].status,'unknown');assert(await botRecord(b));
 await assert.rejects(botStorage.run({id:a,pool:controlPool,dataDirectory:'/tmp/synthetic-deleted',modelKey:'1'.repeat(64)},()=>botPrincipal()),{status:404});
 assert.equal((await req('/bots/'+a+'/restore','POST',{revision:99})).status,404);assert.equal((await req('/users/bot-owner/'+a,'PUT',{owner_user_id:admin.id})).status,404);
});
test('deleted grant scopes are never widened automatically and can still be explicitly revoked',async()=>{
 const original=(await controlPool.query('SELECT * FROM managed_model_grants WHERE key_id=$1',[siteKey])).rows[0];assert.deepEqual(original.bot_ids,[a]);assert.deepEqual(original.group_ids,[group]);assert(original.enabled);
 assert.equal((await req('/key-grants','PUT',{...grantBody,enabled:false})).status,200);const revoked=(await controlPool.query('SELECT * FROM managed_model_grants WHERE key_id=$1',[siteKey])).rows[0];assert(!revoked.enabled);assert.deepEqual(revoked.bot_ids,[a]);assert.deepEqual(revoked.group_ids,[group]);assert.equal((await req('/key-grants','PUT',grantBody)).status,400);
});
test('the same WeChat identity and management name may be registered again into a new independent workspace',async()=>{
 const old=(await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[a])).rows[0];const id=await create(old.name,user.id);assert.notEqual(id,a);assert.notEqual((await botRecord(id)).db_name,old.db_name);const overview=(await req('/overview','GET',undefined,admin,id)).data;assert.equal(overview.groups.length,0);assert.equal(overview.knowledge_bases.length,0);assert.equal(overview.model_config.credentials.length,1); // own user Key is independently available, no old alias state or plaintext copy
 assert((await controlPool.query('SELECT deleted_at FROM managed_bots WHERE id=$1',[a])).rows[0].deleted_at);
});
test('removing the legacy registration does not delete control auth or break bootstrap and migration reruns',async()=>{
 await controlPool.query("UPDATE managed_bots SET state='paused' WHERE id=$1",[legacyBotId]);assert.equal((await removeBot(legacyBotId)).status,200);await migrate();await ensureLegacyIsolation();await initializeUserOwners();await initializeKeyVault();assert.equal((await req('/auth/me')).status,200);assert.equal(await botRecord(legacyBotId),undefined);assert.equal((await req('/bots')).data.bots.some((x:any)=>x.id===legacyBotId),false);assert.equal((await req('/overview','GET',undefined,admin,b)).status,200);
});
