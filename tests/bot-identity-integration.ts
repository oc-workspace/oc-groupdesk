import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {pool,controlPool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {legacyBotId} from '../server/bot-context.js';
import {identityMaintenancePlan,maintainBotIdentity} from '../server/bot-identity-maintenance.js';
import {makeSkill} from '../server/persona-generation.js';
import {digest} from '../server/security.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,url='',cookie='',csrf='',a:any,b:any,ga:any,gb:any,ga2:any;const created:string[]=[];
async function req(path:string,method='GET',body?:any,botId?:string,token?:string){const r=await fetch(url+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(botId?{'X-GroupDesk-Bot':botId}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),response:r};}
async function bot(name:string){const r=await req('/bots','POST',{name,wechat_id:'wx_'+name,host_label:'synthetic',notes:''});assert.equal(r.status,201);const id=r.data.id;created.push(id);const row=await botRecord(id);const token=(await req('/bots/'+id+'/connection-token','POST',{revision:row.revision})).data.token;return {id,token};}
async function createGroup(bot:any,external:string){const c=await req('/groups','POST',{name:external},bot.id);assert.equal(c.status,201);let g=(await req('/overview','GET',undefined,bot.id)).data.groups.find((x:any)=>x.id===c.data.id);const saved=await req('/groups/'+g.id,'PUT',{...g,external_id:external,enabled:true,topic_ids:[(await req('/overview','GET',undefined,bot.id)).data.topics[0].id]},bot.id);assert.equal(saved.status,200,JSON.stringify(saved.data));return saved.data;}
async function config(bot:any,g:any){const c=await req('/runtime/config/'+g.external_id,'GET',undefined,undefined,bot.token);assert.equal(c.status,200,JSON.stringify(c.data));return c.data;}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;a=await bot('Name_A');b=await bot('Name_B');await controlPool.query("UPDATE managed_bots SET state='paused'");await controlPool.query("UPDATE managed_bots SET state='active' WHERE id=$1",[a.id]);ga=await createGroup(a,'name-a');ga2=await createGroup(a,'name-a2');gb=await createGroup(b,'name-b');await controlPool.query('UPDATE managed_bot_adapters SET group_external_ids=$2 WHERE bot_id=$1',[a.id,JSON.stringify(['name-a','name-a2'])]);
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await closeBusinessPools();for(const id of created){const b=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(b.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(b.db_role));}const legacy=await botRecord(legacyBotId);if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}await pool.end();});
test('trusted robot defaults and group overrides do not leak between robots or groups',async()=>{
 let c=await config(a,ga);assert.equal(c.bot_identity.display_name,'Name_A');assert.deepEqual(c.bot_identity.mention_names,['Name_A','wx_Name_A']);assert(!JSON.stringify(c.bot_identity).includes('GT'));
 const saved=await req('/groups/'+ga.id,'PUT',{...ga,policy:{...ga.policy,identity:{...ga.policy.identity,bot_name:'小白',self_reference:'本喵',mention_names:['小白','White T'],name_policy_version:1}}},a.id);assert.equal(saved.status,200);ga=saved.data;
 c=await config(a,ga);assert.equal(c.bot_identity.display_name,'小白');assert.equal(c.bot_identity.bot_id,a.id);assert.deepEqual(c.interactions.settings.bot_aliases,['小白','White T']);assert(c.bot_name_instructions.join('\n').includes('本喵'));
 const other=await config(a,ga2);assert.equal(other.bot_identity.display_name,'Name_A');assert(!JSON.stringify(other.bot_identity).includes('White T'));
 assert.equal((await req('/runtime/config/'+ga.external_id,'GET',undefined,undefined,b.token)).status,403);
 assert.equal((await req('/groups/'+ga.id,'PUT',ga,b.id)).status,404);
 const preview=await req('/persona-bindings/'+ga.id,'GET',undefined,a.id);assert.equal(preview.data.bot_identity.self_reference,'本喵');assert.equal(preview.data.characters,preview.data.text.length);
 const empty=await req('/groups/'+ga2.id,'PUT',{...ga2,policy:{...ga2.policy,identity:{...ga2.policy.identity,mention_names:[]}}},a.id);assert.equal(empty.status,200);ga2=empty.data;assert.deepEqual((await config(a,ga2)).interactions.settings.bot_aliases,[]);
});
test('configuration cannot be acknowledged with stale identity or an old runtime',async()=>{
 const c=await config(a,ga);const body={group_id:c.id,revision:c.revision,timeout_policy_version:3,persona_skill_version:1,reply_limits_version:1,reply_frequency_version:1,reply_frequency_revision:c.reply_frequency.revision};
 assert.equal((await req('/runtime/ack','POST',body,undefined,a.token)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...body,bot_identity_version:1,bot_identity_sha256:(await config(a,ga2)).bot_identity_sha256},undefined,a.token)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...body,bot_identity_version:1,bot_identity_sha256:c.bot_identity_sha256},undefined,a.token)).status,200);
});
test('identity maintenance preserves pinned history, unpublished drafts and pending manual edits',async()=>{
 await withBot(a.id,async()=>{
 const p=randomUUID(),v=randomUUID(),unpublished=randomUUID(),old=makeSkill('synthetic-old','test','GT小跟班 speaks concisely. Ground all facts; use style without claiming to be the real author.'),draft=makeSkill('synthetic-old','test','PENDING MANUAL CHANGES: this draft must never be published by identity maintenance.');
 await pool.query("INSERT INTO personas(id,name,skill_name,description,goal,draft_skill) VALUES($1,'Synthetic','synthetic-old','test','',$2)",[p,draft]);await pool.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,1,$3,$4,'base')",[v,p,old,digest(old)]);
 await pool.query("INSERT INTO personas(id,name,skill_name,description,goal,draft_skill) VALUES($1,'Unpublished','synthetic-unpublished','test','',$2)",[unpublished,makeSkill('synthetic-unpublished','test','An unpublished draft with private editorial changes, not ready to publish.')]);
 await pool.query('UPDATE groups SET persona_version_id=$1,persona_follow_latest=(id=$2) WHERE id IN ($2,$3)',[v,ga.id,ga2.id]);
 const plan=await identityMaintenancePlan();await assert.rejects(maintainBotIdentity('0'.repeat(64),['Name_A']));const result=await maintainBotIdentity(plan.fingerprint,['Name_A']);assert.equal(result.new_versions,1);
 const vs=(await pool.query('SELECT * FROM persona_versions WHERE persona_id=$1 ORDER BY version',[p])).rows;assert.equal(vs.length,2);assert.equal(vs[0].skill_md,old);assert(!vs[1].skill_md.includes('PENDING MANUAL'));assert(!vs[1].skill_md.includes('GT小跟班'));
 assert((await pool.query('SELECT draft_skill FROM personas WHERE id=$1',[p])).rows[0].draft_skill.includes('PENDING MANUAL'));
 assert.equal((await pool.query('SELECT 1 FROM persona_versions WHERE persona_id=$1',[unpublished])).rowCount,0);
 const groups=(await pool.query('SELECT id,persona_version_id,policy FROM groups WHERE id IN ($1,$2)',[ga.id,ga2.id])).rows;assert.equal(groups.find(g=>g.id===ga.id).persona_version_id,vs[1].id);assert.equal(groups.find(g=>g.id===ga2.id).persona_version_id,v);assert.deepEqual(groups.find(g=>g.id===ga2.id).policy.identity.mention_names,[]);
 const next=await identityMaintenancePlan();assert.equal((await maintainBotIdentity(next.fingerprint,['Name_A'])).new_versions,0);
 });
});
