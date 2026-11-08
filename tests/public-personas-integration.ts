import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {pool,controlPool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createBot,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {makeSkill} from '../server/persona-generation.js';
import {digest} from '../server/security.js';
import {seedPublicBasePersonas} from '../server/public-personas.js';
import {runtimePersonaBundle,renderPersonaComposition} from '../server/persona-composition.js';
import {skillArchive} from '../server/personas-api.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let a='',b='',original='';const created:string[]=[];
const g1=randomUUID(),g2=randomUUID(),gt=randomUUID(),gtv=randomUUID(),feature=randomUUID(),fv=randomUUID();
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();
 for(const name of ['public_persona_A','public_persona_B'])created.push(await createBot({name,wechat_id:name,host_label:'synthetic',notes:''},'admin'));
 [a,b]=created;
 await withBot(a,async()=>{
  for(const [id,version,name,kind] of [[gt,gtv,'synthetic-gt','base'],[feature,fv,'synthetic-feature','feature']]){
   const skill=makeSkill(name,'Synthetic existing persona for isolation testing.','This is an existing synthetic persona whose content and group bindings must remain independent.');
   await pool.query('INSERT INTO personas(id,name,skill_name,kind,draft_skill) VALUES($1,$2,$2,$3,$4)',[id,name,kind,skill]);
   await pool.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,1,$3,$4,$5)',[version,id,skill,digest(skill),kind]);
  }
  for(const [id,name] of [[g1,'Synthetic group one'],[g2,'Synthetic group two']])await pool.query('INSERT INTO groups(id,name,persona_version_id) VALUES($1,$2,$3)',[id,name,gtv]);
  await pool.query('INSERT INTO group_persona_features(group_id,persona_id,version_id,position) VALUES($1,$2,$3,0)',[g1,feature,fv]);
  original=JSON.stringify({groups:(await pool.query('SELECT * FROM groups ORDER BY id')).rows,features:(await pool.query('SELECT * FROM group_persona_features')).rows,old:(await pool.query('SELECT * FROM personas ORDER BY id')).rows});
 });
});
after(async()=>{
 await closeBusinessPools();
 for(const id of created){const row=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}
 await pool.end();
});
test('two published base options are imported without touching existing personas or group selections',async()=>{
 await withBot(a,async()=>{
  const result=await seedPublicBasePersonas('synthetic-test');assert.equal(result.personas.length,2);assert(result.personas.every(p=>p.created&&p.published_version===1));
  const existing=JSON.stringify({groups:(await pool.query('SELECT * FROM groups ORDER BY id')).rows,features:(await pool.query('SELECT * FROM group_persona_features')).rows,old:(await pool.query('SELECT * FROM personas WHERE id=ANY($1::uuid[]) ORDER BY id',[[gt,feature]])).rows});assert.equal(existing,original);
  const rows=(await pool.query('SELECT v.kind,v.version,v.sha256,v.skill_md,p.dataset_ids FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE p.id<>ALL($1::uuid[])',[[gt,feature]])).rows;
  assert.equal(rows.length,2);assert(rows.every(r=>r.kind==='base'&&r.version===1&&r.sha256===digest(r.skill_md)&&r.dataset_ids.length===0));
 });
});
test('different groups select different bases while existing optional features stay composed',async()=>{
 await withBot(a,async()=>{
  const row=async(slug:string)=>(await pool.query('SELECT v.id FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE p.skill_name=$1',[slug])).rows[0].id;
  await pool.query('UPDATE groups SET persona_version_id=$2,revision=revision+1 WHERE id=$1',[g1,await row('buffett-value-persona')]);
  await pool.query('UPDATE groups SET persona_version_id=$2,revision=revision+1 WHERE id=$1',[g2,await row('elon-first-principles-persona')]);
  const group=async(id:string)=>(await pool.query('SELECT * FROM groups WHERE id=$1',[id])).rows[0];
  const one=await runtimePersonaBundle(await group(g1)),two=await runtimePersonaBundle(await group(g2));
  assert(one.persona_skill&&two.persona_skill);
  assert.equal(one.persona_skill.skill_name,'buffett-value-persona');assert.equal(two.persona_skill.skill_name,'elon-first-principles-persona');
  assert.equal(one.persona_feature_skills.length,1);assert.equal(two.persona_feature_skills.length,0);
  assert(!renderPersonaComposition(one.persona_skill,one.persona_feature_skills,'old-global-GT-fallback').includes('old-global-GT-fallback'));
  assert(!renderPersonaComposition(two.persona_skill,two.persona_feature_skills,'old-global-GT-fallback').includes('old-global-GT-fallback'));
 });
});
test('imports remain independent per robot and reruns preserve human edits and published revisions',async()=>{
 await withBot(b,()=>seedPublicBasePersonas('synthetic-test'));
 const id=await withBot(a,async()=>(await pool.query("SELECT id FROM personas WHERE skill_name='buffett-value-persona'")).rows[0].id);
 const other=await withBot(b,async()=>(await pool.query("SELECT id FROM personas WHERE skill_name='buffett-value-persona'")).rows[0].id);assert.notEqual(id,other);
 await withBot(a,async()=>{
  const edited=makeSkill('buffett-value-persona','Synthetic human edit for preservation testing.','This manually revised synthetic persona must remain intact after the operator imports the package again.');
  await pool.query("UPDATE personas SET name='Human maintained Buffett',draft_skill=$2,revision=revision+1 WHERE id=$1",[id,edited]);
  await pool.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,2,$3,$4,'base')",[randomUUID(),id,edited,digest(edited)]);
  const before=JSON.stringify((await pool.query('SELECT * FROM groups ORDER BY id')).rows);
  const result=await seedPublicBasePersonas('synthetic-test');assert(result.personas.every(p=>!p.created&&p.existing_preserved));
  const current=(await pool.query('SELECT name,draft_skill FROM personas WHERE id=$1',[id])).rows[0];assert.equal(current.name,'Human maintained Buffett');assert.equal(current.draft_skill,edited);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM groups ORDER BY id')).rows),before);
  assert.equal((await pool.query('SELECT max(version)::int n FROM persona_versions WHERE persona_id=$1',[id])).rows[0].n,2);
 });
 await withBot(b,async()=>assert.notEqual((await pool.query('SELECT name FROM personas WHERE id=$1',[other])).rows[0].name,'Human maintained Buffett'));
});
test('portable exports retain the upstream MIT notice and pinned provenance without external runtime dependencies',async()=>{
 await withBot(b,async()=>{
  const rows=(await pool.query('SELECT p.skill_name,v.* FROM personas p JOIN persona_versions v ON v.persona_id=p.id')).rows;
  const musk=rows.find(r=>r.skill_name==='elon-first-principles-persona')!,buffett=rows.find(r=>r.skill_name==='buffett-value-persona')!;
  const tar=gunzipSync(skillArchive(musk.skill_name,musk.skill_md,musk.provenance));let position=0;const files:Record<string,string>={};
  while(position+512<=tar.length){const header=tar.subarray(position,position+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,'');if(!name)break;const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,''),8);files[name]=tar.subarray(position+512,position+512+size).toString();position+=512+Math.ceil(size/512)*512;}
  const exported=JSON.parse(files[musk.skill_name+'/references/provenance.json']);assert(exported.license_text.includes('Copyright (c) 2026 OpenDemon'));assert(exported.license_text.includes('Permission is hereby granted'));assert.equal(exported.source.commit,'24e76e8ecf3e31873529f1f00424b65a3369fb60');
  assert.equal(buffett.provenance.source.license,'not_declared');assert.equal(buffett.provenance.source.adaptation,'independently_authored_framework_reference');
  for(const row of rows){assert.equal(row.provenance.external_runtime_files_required,false);assert.equal(row.provenance.source.upstream_files_copied,false);}
 });
});
