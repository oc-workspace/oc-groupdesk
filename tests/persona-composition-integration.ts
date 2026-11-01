import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {migrate} from '../server/migrate.js';
import {pool} from '../server/db.js';
import {createApp} from '../server/app.js';
import {makeSkill} from '../server/persona-generation.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw new Error('Dedicated test database required');
let server:Server,url='',cookie='',csrf='',a:any,b:any,base:any,f1:any,f2:any;
async function req(path:string,method='GET',body?:any,runtime=false){
 const r=await fetch(url+'/api'+path,{method,headers:{...(runtime?{Authorization:'Bearer '+process.env.BOT_API_TOKEN}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json()};
}
async function create(name:string,kind:'base'|'feature'){
 const c=await req('/personas','POST',{name,skill_name:name,description:'Synthetic '+name,goal:'',dataset_ids:[],kind});assert.equal(c.status,201);
 const p=(await req('/personas/'+c.data.id)).data;
 const v=await req('/personas/'+p.id+'/publish','POST',{revision:p.revision});assert.equal(v.status,201);
 return {...p,version_id:v.data.id};
}
async function group(id:string){return (await req('/overview')).data.groups.find((g:any)=>g.id===id);}
async function config(g:any){return (await req('/runtime/config/'+g.external_id,'GET',undefined,true)).data;}
async function bind(g:any,body:any){const current=await group(g.id);return req('/persona-bindings/'+g.id,'PUT',{revision:current.revision,...body});}
async function publish(p:any,text:string){
 const current=(await req('/personas/'+p.id)).data;
 assert.equal((await req('/personas/'+p.id,'PUT',{...current,draft_skill:makeSkill(p.skill_name,p.description,text)})).status,200);
 return req('/personas/'+p.id+'/publish','POST',{revision:current.revision+1});
}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate();await migrate();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD})});cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=(await login.json()).csrf;
 [a,b]=(await req('/overview')).data.groups;
 for(const g of [a,b]){const saved=await req('/groups/'+g.id,'PUT',{...g,enabled:true,external_id:'compose-'+g.id});assert.equal(saved.status,200);Object.assign(g,saved.data);}
 base=await create('synthetic-base','base');f1=await create('synthetic-banter','feature');f2=await create('synthetic-teaching','feature');
});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('a group combines one base and two distinct features; another remains independent',async()=>{
 assert.equal((await bind(a,{version_id:base.version_id,follow_latest:true,features:[{version_id:f1.version_id,follow_latest:true},{version_id:f2.version_id,follow_latest:false}]})).status,200);
 assert.equal((await bind(b,{version_id:base.version_id,features:[{version_id:f1.version_id,follow_latest:false}]})).status,200);
 const ca=await config(a),cb=await config(b);
 assert.equal(ca.persona_skill.kind,'base');assert.equal(ca.persona_feature_skills.length,2);assert.equal(cb.persona_feature_skills.length,1);
 assert.equal(ca.persona_composition_contract_version,1);assert.notEqual(ca.persona_composition_sha256,cb.persona_composition_sha256);
 const preview=await req('/persona-bindings/'+a.id);assert(preview.data.text.includes('synthetic-banter'));assert(preview.data.text.includes('synthetic-teaching'));
});
test('legacy ACK cannot acknowledge features, and an incorrect combination digest is refused',async()=>{
 const c=await config(a);const body={group_id:c.id,revision:c.revision,timeout_policy_version:2,persona_skill_version:1,persona_skill_sha256:c.persona_skill.sha256};
 assert.equal((await req('/runtime/ack','POST',body,true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...body,persona_composition_version:1,persona_composition_sha256:'0'.repeat(64)},true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...body,persona_composition_version:1,persona_composition_sha256:c.persona_composition_sha256},true)).status,200);
});
test('invalid combinations roll back the entire edit and cannot change published skill kinds',async()=>{
 const before=await config(a);
 for(const body of [{version_id:f1.version_id,features:[]},{version_id:base.version_id,features:[{version_id:base.version_id}]},{version_id:base.version_id,features:[{version_id:f1.version_id},{version_id:f1.version_id}]}])assert.equal((await bind(a,body)).status,400);
 const after=await config(a);assert.equal(after.revision,before.revision);assert.equal(after.persona_composition_sha256,before.persona_composition_sha256);
 const p=(await req('/personas/'+f1.id)).data;assert.equal((await req('/personas/'+f1.id,'PUT',{...p,kind:'base'})).status,409);
 assert.equal((await req('/personas/'+f1.id+'/archive','POST',{revision:p.revision,archived:true})).status,409);
});
test('saving a draft changes no groups; publishing updates followers but preserves pinned versions',async()=>{
 const beforeA=await config(a),beforeB=await config(b),p=(await req('/personas/'+f1.id)).data;
 assert.equal((await req('/personas/'+p.id,'PUT',{...p,draft_skill:makeSkill(p.skill_name,p.description,'Updated synthetic banter, only in relevant context; serious questions retain their substantive answers.')})).status,200);
 assert.equal((await config(a)).revision,beforeA.revision);
 const published=await req('/personas/'+p.id+'/publish','POST',{revision:p.revision+1});assert.equal(published.status,201);assert.deepEqual(published.data.updated_groups,[a.id]);
 const ca=await config(a),cb=await config(b);assert.equal(ca.revision,beforeA.revision+1);assert.equal(ca.persona_feature_skills[0].version,2);assert.equal(cb.persona_feature_skills[0].version,1);assert.equal(cb.revision,beforeB.revision);
 assert.equal(ca.persona_feature_skills[1].version,1);
});
test('base publications propagate only to followers and selecting follow resolves the latest version',async()=>{
 const before=await config(b);const v=await publish(base,'Updated base style; keep replies concise and practical, preserving language and factual boundaries.');assert.equal(v.status,201);
 assert.equal((await config(a)).persona_skill.version,2);assert.equal((await config(b)).persona_skill.version,1);assert.equal((await config(b)).revision,before.revision);
 assert.equal((await bind(b,{version_id:base.version_id,follow_latest:true})).status,200);
 const cb=await config(b);assert.equal(cb.persona_skill.version,2);assert.equal(cb.persona_feature_skills.length,1); // Legacy edits preserve feature selections.
});
test('removing features restores base-only compatibility and unbinding one group preserves the other',async()=>{
 assert.equal((await bind(a,{version_id:base.version_id,features:[]})).status,200);
 const ca=await config(a);assert.equal(ca.persona_feature_skills.length,0);assert.equal(ca.persona_composition_contract_version,undefined);
 assert.equal((await req('/runtime/ack','POST',{group_id:ca.id,revision:ca.revision,timeout_policy_version:2,persona_skill_version:1,persona_skill_sha256:ca.persona_skill.sha256},true)).status,200);
 assert.equal((await config(b)).persona_feature_skills.length,1);
});

test('an oversized following publication rolls back both the new version and all group updates',async()=>{
 const before=await config(b),p=(await req('/personas/'+base.id)).data;
 const saved=await req('/personas/'+base.id,'PUT',{...p,draft_skill:makeSkill(base.skill_name,base.description,'x'.repeat(29800))});assert.equal(saved.status,200);
 const latest=p.versions[0].version;
 assert.equal((await req('/personas/'+base.id+'/publish','POST',{revision:p.revision+1})).status,400);
 assert.equal((await req('/personas/'+base.id)).data.versions[0].version,latest);
 const after=await config(b);assert.equal(after.revision,before.revision);assert.equal(after.persona_composition_sha256,before.persona_composition_sha256);
});
test('explicit specialist split preserves old versions, scopes the group and is repeatable',async()=>{
 const {migrateSpecialist}=await import('../server/persona-composition-migration.js');
 const old=await create('old-complete-specialist','base');
 assert.equal((await bind(a,{version_id:old.version_id,features:[]})).status,200);
 const g=await group(a.id),other=await config(b);
 const input={group_id:g.id,expected_group_revision:g.revision,source_version_id:old.version_id,base_version_id:base.version_id,feature_name:'Extracted feature',feature_skill_name:'extracted-feature',feature_skill:makeSkill('extracted-feature','Incremental feature','Only incremental contextual expression techniques; retain the current base voice and answer serious requests.')};
 await assert.rejects(migrateSpecialist({...input,expected_group_revision:g.revision-1}));
 const result=await migrateSpecialist(input);assert.equal(result.reused,false);
 const again=await migrateSpecialist(input);assert.equal(again.reused,true);assert.equal(again.revision,result.revision);
 const c=await config(a);assert.equal(c.persona_skill.persona_id,base.id);assert.equal(c.persona_feature_skills.length,1);assert.equal(c.persona_feature_skills[0].persona_id,result.feature_id);
 assert.equal((await req('/persona-versions/'+old.version_id)).data.persona_id,old.id);
 assert.equal((await config(b)).revision,other.revision);
});

test('welcome is published-feature opt-in and requires a capable adapter ACK',async()=>{
 const other=await config(b),welcome=await create('newcomer-welcome','feature');
 assert.equal((await config(a)).newcomer_welcome_contract_version,undefined);
 assert.equal((await bind(a,{version_id:base.version_id,features:[{version_id:welcome.version_id}]})).status,200);
 const c=await config(a);assert.equal(c.persona_feature_skills[0].skill_name,'newcomer-welcome');
 assert.deepEqual(c.newcomer_welcome,{min_delay_seconds:15,max_delay_seconds:40,ttl_seconds:90,coalesce_seconds:120});
 const ack={group_id:c.id,revision:c.revision,timeout_policy_version:2,persona_skill_version:1,persona_skill_sha256:c.persona_skill.sha256,persona_composition_version:1,persona_composition_sha256:c.persona_composition_sha256};
 assert.equal((await req('/runtime/ack','POST',ack,true)).status,409);
 assert.equal((await req('/runtime/ack','POST',{...ack,newcomer_welcome_policy_version:1},true)).status,200);
 assert.equal((await config(b)).revision,other.revision);assert.equal((await config(b)).newcomer_welcome_contract_version,undefined);
 assert.equal((await bind(a,{version_id:base.version_id,features:[]})).status,200);
 assert.equal((await config(a)).newcomer_welcome_contract_version,undefined);
});
