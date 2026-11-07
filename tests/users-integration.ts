import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {createBot,sqlIdentifier,ensureLegacyIsolation} from '../server/bot-provisioning.js';
import {botRecord,withBot} from '../server/bot-workspaces.js';
import {initializeUserOwners} from '../server/user-access.js';
import {makeSkill} from '../server/persona-generation.js';
import {digest,token} from '../server/security.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',admin:any,a:any,b:any,botA='',botB='',privateTopic='',sharedTopic='',selectedTopic='',privatePersona='',version='',group='';const bots:string[]=[];
let githubId=777,githubLogin='admin',calls:any[]=[];
const cookie=(r:Response)=>r.headers.get('set-cookie')!.split(';')[0];
async function req(path:string,method='GET',body?:any,user=admin,botId?:string){const response=await fetch(base+'/api'+path,{method,redirect:'manual',headers:{...(user?{Cookie:user.cookie,'X-CSRF-Token':user.csrf}:{}),...(botId?{'X-GroupDesk-Bot':botId}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json().catch(()=>null),response};}
async function user(name:string){const id=randomUUID(),session=token(),csrf=token();await controlPool.query("INSERT INTO admins(id,username,password_hash,role,github_id,github_login) VALUES($1,$2,'!github-only','user',$3,$2)",[id,name,name]);await controlPool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);return {id,cookie:'groupdesk_session='+session,csrf};}
async function grant(u:any,p:object){await controlPool.query('UPDATE admins SET permissions=$2 WHERE id=$1',[u.id,p]);}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();await initializeUserOwners();
 server=createServer(createApp({githubRequest:async(url,body,access)=>{calls.push({url,body,access});return url.endsWith('access_token')?{access_token:'synthetic-ephemeral-github-token'}:{id:githubId,login:githubLogin,name:'Synthetic GitHub User'};}}));await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD},null);admin={...login.data,cookie:cookie(login.response)};assert.equal(admin.role,'super_admin');a=await user('synthetic_A');b=await user('synthetic_B');
 for(const [name,u] of [['owned_A',a],['owned_B',b]] as const){const id=await createBot({name,wechat_id:name,host_label:'synthetic',notes:''},'admin');bots.push(id);await controlPool.query('UPDATE managed_bots SET owner_user_id=$2,created_by_user_id=$3 WHERE id=$1',[id,u.id,admin.id]);}
 [botA,botB]=bots;
 await withBot(botB,async()=>{
  privateTopic=randomUUID();sharedTopic=randomUUID();selectedTopic=randomUUID();
  for(const [id,name,visibility,audience] of [[privateTopic,'Hidden B topic','private',[]],[sharedTopic,'Common topic','common',[]],[selectedTopic,'Selected A topic','selected',[a.id]]])await pool.query('INSERT INTO topics(id,name,description,instructions,policy,created_by_user_id,visibility,audience_user_ids) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[id,name,'Public synthetic template',{schema_version:1,lexicons:{en:['synthetic']}},b.id,visibility,audience]);
  privatePersona=randomUUID();version=randomUUID();const skill=makeSkill('hidden-persona','Synthetic private persona','This is a complete private synthetic persona. Its text must not be accessible by a different owner.');
  await pool.query("INSERT INTO personas(id,name,skill_name,draft_skill,created_by_user_id) VALUES($1,'Private B Persona','hidden-persona',$2,$3)",[privatePersona,skill,b.id]);await pool.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,1,$3,$4,'base')",[version,privatePersona,skill,digest(skill)]);
 });
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of bots){const r=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(r.db_name)+' WITH(FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(r.db_role));}await pool.end();});
test('ordinary users only list owned accounts and cannot forge bot headers or direct bot paths',async()=>{
 assert.deepEqual((await req('/bots','GET',undefined,a)).data.bots.map((x:any)=>x.id),[botA]);
 assert.equal((await req('/overview','GET',undefined,a,botB)).status,404);assert.equal((await req('/bots/'+botB+'/connection','GET',undefined,a)).status,404);
 assert.equal((await req('/bots/'+botB,'PUT',{revision:1},a)).status,404);assert.equal((await req('/users','GET',undefined,a)).status,403);
 assert.equal((await req('/users/github-settings','GET',undefined,a)).status,403);assert.equal((await req('/overview','GET',undefined,a)).status,200);
});
test('sharing includes common and selected users, never private resources or another account metadata',async()=>{
 const r=(await req('/shared-resources','GET',undefined,a)).data.resources;
 assert(r.some((x:any)=>x.id===sharedTopic));assert(r.some((x:any)=>x.id===selectedTopic));assert(!r.some((x:any)=>x.id===privateTopic||x.id===privatePersona));assert(r.every((x:any)=>!x.bot_name&&!x.wechat_id));
 assert.equal((await req('/shared-resources/visibility','PUT',{bot_id:botB,id:privateTopic,kind:'topic',visibility:'common',audience_user_ids:[]},a)).status,403);
});
test('create permissions are enforced by backend and creator attribution stays with original user',async()=>{
 const draft={name:'User A topic',description:'Synthetic topic',instructions:'Synthetic rules'};
 assert.equal((await req('/topics','POST',{...draft,color:'blue'},a,botA)).status,403);
 await grant(a,{'topics.create':true,'personas.create':true,'groups.manage':true});
 const created=await req('/topics','POST',{...draft,color:'blue'},a,botA);assert.equal(created.status,201);assert.equal(created.data.created_by_user_id,a.id);
 const p=await req('/personas','POST',{name:'Owned persona',skill_name:'owned-persona',description:'Synthetic',goal:'',dataset_ids:[],kind:'base'},a,botA);assert.equal(p.status,201);
 const loaded=await req('/personas/'+p.data.id,'GET',undefined,a,botA);assert.equal(loaded.data.created_by_user_id,a.id);assert(loaded.data.can_edit);
 const overview=await req('/overview','GET',undefined,a,botA);assert(overview.data.topics.some((t:any)=>t.id===created.data.id&&t.creator.id===a.id));
});
test('foreign private IDs and hidden local records cannot bypass lists, previews, bindings, or copy endpoints',async()=>{
 assert.equal((await req('/topics/'+privateTopic+'/test','POST',{messages:['synthetic']},a,botB)).status,404);
 assert.equal((await req('/shared-resources/copy','POST',{source_bot_id:botB,source_id:privateTopic,kind:'topic',target_bot_id:botA,name:'Forbidden copy'},a)).status,404);
 assert.equal((await req('/persona-versions/'+version+'/export','GET',undefined,a,botA)).status,404);
 let local='';await withBot(botA,async()=>{local=randomUUID();group=randomUUID();const v=randomUUID(),skill=makeSkill('admin-private','Admin only','Complete hidden synthetic persona content which ordinary bot owner cannot preview or edit.');
  await pool.query("INSERT INTO personas(id,name,skill_name,draft_skill,created_by_user_id) VALUES($1,'Admin private','admin-private',$2,$3)",[local,skill,admin.id]);await pool.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,1,$3,$4,'base')",[v,local,skill,digest(skill)]);await pool.query('INSERT INTO groups(id,name,persona_version_id) VALUES($1,$2,$3)',[group,'Owned group with admin binding',v]);});
 assert.equal((await req('/personas/'+local,'GET',undefined,a,botA)).status,404);assert.equal((await req('/persona-bindings/'+group,'GET',undefined,a,botA)).status,403);
 const studio=await req('/persona-studio','GET',undefined,a,botA);assert(!studio.data.personas.some((p:any)=>p.id===local));
 assert.equal((await req('/catalog/import','POST',{keys:[],replace:true,expected:{}},a,botA)).status,403);
});
test('concurrent creators retain independent user and bot contexts',async()=>{
 await grant(b,{'topics.create':true});const results=await Promise.all([[a,botA],[b,botB]].map(async([u,botId])=>req('/topics','POST',{name:'Concurrent synthetic topic',description:'Synthetic',instructions:'Rules',color:'blue'},u as any,botId as string)));
 assert(results.every(r=>r.status===201));assert.equal(results[0].data.created_by_user_id,a.id);assert.equal(results[1].data.created_by_user_id,b.id);
 assert.equal((await req('/topics/'+results[1].data.id+'/test','POST',{messages:['test']},a,botA)).status,404);
});
test('copies only include whitelisted topic or published persona text and become independent private drafts',async()=>{
 let r=await req('/shared-resources/copy','POST',{source_bot_id:botB,source_id:sharedTopic,kind:'topic',target_bot_id:botA,name:'Copied common topic'},a);assert.equal(r.status,201);
 const copiedId=r.data.id;await withBot(botA,async()=>{const t=(await pool.query('SELECT * FROM topics WHERE id=$1',[copiedId])).rows[0];assert.equal(t.created_by_user_id,a.id);assert.equal(t.visibility,'private');assert.equal(t.source_resource.source_id,sharedTopic);});
 await req('/shared-resources/visibility','PUT',{bot_id:botB,id:privatePersona,kind:'persona',visibility:'selected',audience_user_ids:[a.id]},admin);
 r=await req('/shared-resources/copy','POST',{source_bot_id:botB,source_id:privatePersona,kind:'persona',target_bot_id:botA,name:'Copied persona'},a);assert.equal(r.status,201);assert(r.data.unpublished);
 const p=(await req('/personas/'+r.data.id,'GET',undefined,a,botA)).data;assert.equal(p.versions.length,0);assert.deepEqual(p.dataset_ids,[]);assert.equal(p.created_by_user_id,a.id);assert.equal(p.visibility,'private');assert(!JSON.stringify(p).includes('key_ciphertext'));
 // Even within an owned bot, common personas expose published text, never another author's draft or source archive.
 const ownCopy=r.data.id;await withBot(botA,async()=>{const v=randomUUID(),skill=makeSkill(p.skill_name,'Published synthetic','Published voice text with useful boundaries and respectful concise interaction.');await pool.query("UPDATE personas SET created_by_user_id=$2,visibility='common',draft_skill='PRIVATE_DRAFT_MUST_NOT_LEAK',draft_provenance='{\"private_archive\":\"SECRET_SOURCE\"}' WHERE id=$1",[ownCopy,admin.id]);await pool.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind,provenance) VALUES($1,$2,1,$3,$4,'base','{\"private_archive\":\"SECRET_SOURCE\"}')",[v,ownCopy,skill,digest(skill)]);});
 const sharedView=(await req('/personas/'+ownCopy,'GET',undefined,a,botA)).data;assert(!JSON.stringify(sharedView).includes('PRIVATE_DRAFT_MUST_NOT_LEAK'));assert(!JSON.stringify(sharedView).includes('SECRET_SOURCE'));assert.equal(sharedView.jobs.length,0);
 assert.equal((await req('/persona-versions/'+sharedView.versions[0].id+'/export','GET',undefined,a,botA)).status,403);
 assert.equal((await req('/shared-resources/copy','POST',{source_bot_id:botB,source_id:sharedTopic,kind:'topic',target_bot_id:botB,name:'Wrong target'},a)).status,404);
});
test('sharing revocation and disabling users take effect immediately; the last super-admin is protected',async()=>{
 await req('/shared-resources/visibility','PUT',{bot_id:botB,id:selectedTopic,kind:'topic',visibility:'private',audience_user_ids:[]},admin);assert(!(await req('/shared-resources','GET',undefined,a)).data.resources.some((x:any)=>x.id===selectedTopic));
 const info=(await req('/users','GET',undefined,admin)).data.users,au=info.find((u:any)=>u.id===admin.id),bu=info.find((u:any)=>u.id===b.id);
 assert.equal((await req('/users/'+admin.id+'/access','PUT',{role:'user',status:'active',permissions:{},revision:au.revision},admin)).status,409);
 assert.equal((await req('/users/'+b.id+'/access','PUT',{role:'user',status:'disabled',permissions:{},revision:bu.revision},admin)).status,200);
 assert.equal((await req('/bots','GET',undefined,b)).status,401);
});
async function settings(mode='auto'){
 const c=(await req('/users/github-settings','GET',undefined,admin)).data;
 assert(!JSON.stringify(c).includes('ciphertext'));const r=await req('/users/github-settings','PUT',{client_id:'synthetic-client',client_secret:'synthetic-client-secret',enabled:true,registration_mode:mode,revision:c.revision},admin);assert.equal(r.status,200);
 const saved=(await controlPool.query('SELECT secret_ciphertext FROM managed_github_settings')).rows[0].secret_ciphertext;assert(!saved.includes('synthetic-client-secret'));
}
async function start(){const r=await fetch(base+'/api/auth/github/start',{redirect:'manual'});assert.equal(r.status,302);return {url:new URL(r.headers.get('location')!),cookie:cookie(r)};}
async function callback(s:any,cookieOverride?:string){return fetch(base+'/api/auth/github/callback?code=synthetic-code&state='+s.url.searchParams.get('state'),{redirect:'manual',headers:{Cookie:cookieOverride||s.cookie}});}
test('GitHub OAuth binds state to browser and PKCE, rejects replay, and cannot collide with local admin',async()=>{
 await settings();calls=[];const s=await start();assert.equal(s.url.hostname,'github.com');assert.equal(s.url.searchParams.get('code_challenge_method'),'S256');assert.equal(s.url.searchParams.get('scope'),'');
 const wrong=await callback(s,'groupdesk_oauth=other-browser-token-long-enough');assert(wrong.headers.get('location')!.includes('login_error'));assert.equal(calls.length,0);
 const good=await callback(s);assert.equal(good.status,302);assert(!good.headers.get('location')!.includes('login_error'));assert.equal(calls.length,2);assert(calls[0].body.code_verifier.length>=43);
 const session=good.headers.getSetCookie().find(c=>c.startsWith('groupdesk_session='))!.split(';')[0];const profile=(await req('/auth/me','GET',undefined,{cookie:session,csrf:''})).data;
 assert.equal(profile.role,'user');assert.notEqual(profile.id,admin.id);assert.deepEqual(profile.permissions,{});assert.equal(profile.github_login,'admin');
 await callback(s);assert.equal(calls.length,2);assert.equal((await req('/bots','GET',undefined,{cookie:session,csrf:profile.csrf})).data.bots.length,0);
 assert.equal((await controlPool.query('SELECT role FROM admins WHERE id=$1',[admin.id])).rows[0].role,'super_admin');
});
test('review mode persists a pending identity without creating a session; approval requires the administrator',async()=>{
 await settings('review');githubId=778;githubLogin='pending-demo';const s=await start(),r=await callback(s);assert(r.headers.get('location')!.includes('login_error=pending'));assert(!r.headers.getSetCookie().some(c=>c.startsWith('groupdesk_session=')));
 const u=(await controlPool.query("SELECT id,status FROM admins WHERE github_id='778'")).rows[0];assert.equal(u.status,'pending');
 assert.equal((await req('/users/'+u.id+'/access','PUT',{role:'super_admin',status:'active',permissions:{},revision:1},a)).status,403);
 assert.equal((await req('/users/'+u.id+'/access','PUT',{role:'user',status:'active',permissions:{},revision:1},admin)).status,200);
 const next=await callback(await start());assert(!next.headers.get('location')!.includes('login_error'));
});
