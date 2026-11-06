import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pool,controlPool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createBot,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {previewResource,importResource,resourceOverview} from '../server/persona-resources.js';
import {personaResourceCatalog} from '../server/persona-resource-source.js';
import {materialRoot} from '../server/persona-materials.js';
import {isInitialPersonaDraft} from '../shared/persona-editor.js';
import {resourceReader} from './persona-resources.test.js';
import {seedPublicBasePersonas} from '../server/public-personas.js';
import {queuePersonaJob,processPersonaJob} from '../server/persona-generation.js';
import {sealKey} from '../server/model-security.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
const ids:string[]=[];let a='',b='',preview:any,imported:any;
const entry=personaResourceCatalog.entries.find(e=>e.repository==='ByteRax/guodegang-skills')!;
const body=(p:any,extra:object={})=>({preview_id:p.id,name:'Synthetic style',skill_name:'synthetic-library-style',kind:'base' as const,goal:'Synthetic adaptation goal',allow_variant:false,allow_partial:false,...extra});
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();
 for(const name of ['resource_workspace_A','resource_workspace_B'])ids.push(await createBot({name,wechat_id:name,host_label:'synthetic',notes:''},'synthetic-test'));
 [a,b]=ids;
});
after(async()=>{await closeBusinessPools();for(const id of ids){const row=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(row.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(row.db_role));}await pool.end();});
test('preview cache is isolated per robot; foreign preview cannot be imported',async()=>{
 preview=await withBot(a,()=>previewResource(entry.id,undefined,resourceReader()));
 await withBot(b,async()=>{await assert.rejects(importResource(entry.id,body(preview),'test'),/不属于当前机器人/);assert.equal((await resourceOverview()).entries.find(e=>e.id===entry.id)?.imports.length,0);});
});
test('concurrent imports create one editable draft and reference archive; do not publish, bind, or overwrite',async()=>{
 await withBot(a,async()=>{
  const group=randomUUID();await pool.query('INSERT INTO groups(id,name) VALUES($1,$2)',[group,'Synthetic preservation group']);
  const before=JSON.stringify((await pool.query('SELECT * FROM groups')).rows);
  const results=await Promise.all([importResource(entry.id,body(preview),'test'),importResource(entry.id,body(preview),'test')]);
  assert.equal(results.filter(r=>!r.reused).length,1);assert.equal(results[0].persona_id,results[1].persona_id);imported=results[0];
  const p=(await pool.query('SELECT * FROM personas WHERE id=$1',[imported.persona_id])).rows[0];assert(isInitialPersonaDraft(p.draft_skill));assert.deepEqual(p.dataset_ids,[imported.dataset_id]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM persona_versions')).rows[0].n,0);assert.equal(JSON.stringify((await pool.query('SELECT * FROM groups')).rows),before);
  const archive=(await pool.query('SELECT * FROM persona_imports WHERE collection_id=$1',[imported.collection_id])).rows[0];const raw=JSON.parse(await readFile(resolve(materialRoot(),archive.filename),'utf8'));assert.equal(raw.commit,preview.commit);assert(raw.files.some((f:any)=>f.path==='LICENSE'));
  await pool.query("UPDATE personas SET name='Hand edited',revision=revision+1 WHERE id=$1",[imported.persona_id]);assert((await importResource(entry.id,body(preview),'test')).reused);assert.equal((await pool.query('SELECT name FROM personas WHERE id=$1',[imported.persona_id])).rows[0].name,'Hand edited');
 });
 await withBot(b,async()=>{const p=await previewResource(entry.id,undefined,resourceReader());const r=await importResource(entry.id,body(p),'test');assert.notEqual(r.persona_id,imported.persona_id);});
});
test('production-equivalent worker makes self-contained draft and preserves full provenance/notice',async()=>{
 await withBot(a,async()=>{
  const credential=randomUUID();await pool.query("INSERT INTO model_credentials(id,name,base_url,client_type,key_ciphertext,key_hint,key_digest) VALUES($1,'synthetic-public-source','https://example.com/v1','openai',$2,'synthetic','synthetic-digest')",[credential,sealKey('synthetic-model-key')]);
  await pool.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,'synthetic-text','Synthetic Text','text','manual',true)",[credential]);
  await queuePersonaJob(imported.persona_id,2,{credential_id:credential,model_id:'synthetic-text'},'test');
  await processPersonaJob(async(_c,_m,system,input)=>{assert(system.includes('不要写死机器人的姓名'));const data=JSON.parse(input);assert(data.samples.length>3);assert(data.samples.every((s:any)=>s.kind==='document'));return {choices:[{message:{content:'This synthetic persona uses concise, thoughtful language, asks grounded questions, and gives clear examples. Group identity and language rules always take precedence.'}}]};});
  const p=(await pool.query('SELECT * FROM personas WHERE id=$1',[imported.persona_id])).rows[0];assert(!isInitialPersonaDraft(p.draft_skill));assert.equal(p.draft_provenance.resource_source.commit,preview.commit);assert(p.draft_provenance.resource_source.files.find((f:any)=>f.path==='LICENSE').content.includes('Synthetic license'));assert.equal((await pool.query('SELECT status FROM persona_jobs WHERE persona_id=$1',[p.id])).rows[0].status,'ready');assert.equal((await pool.query('SELECT count(*)::int n FROM persona_versions')).rows[0].n,0);
 });
});
test('tools and incomplete sources stay references; existing Buffett requires explicit separate variant',async()=>{
 await withBot(a,async()=>{
  const tool=personaResourceCatalog.entries.find(e=>e.repository==='alchaincyf/nuwa-skill')!;const p=await previewResource(tool.id,undefined,resourceReader());
  await assert.rejects(importResource(tool.id,body(p),'test'),/制作工具/);const ref=await importResource(tool.id,body(p,{kind:'reference'}),'test');assert.equal(ref.persona_id,null);assert(ref.dataset_id);
  await seedPublicBasePersonas('test');const buffett=personaResourceCatalog.entries.find(e=>e.family==='buffett')!;const bp=await previewResource(buffett.id,undefined,resourceReader());
  await assert.rejects(importResource(buffett.id,body(bp,{skill_name:'separate-buffett'}),'test'),/已有同类人设/);
  assert((await importResource(buffett.id,body(bp,{skill_name:'separate-buffett',allow_variant:true}),'test')).persona_id);
  const bad=await previewResource(entry.id,undefined,resourceReader({omit:true}));await assert.rejects(importResource(entry.id,body(bad,{skill_name:'incomplete-style'}),'test'),/超过上限/);
 });
});
test('failed queue leaves a recoverable draft; expired previews require fresh reads',async()=>{
 await withBot(b,async()=>{
  const e=personaResourceCatalog.entries.find(e=>e.family==='musk')!;const p=await previewResource(e.id,undefined,resourceReader());
  const r=await importResource(e.id,body(p,{skill_name:'synthetic-retry',generation:{credential_id:randomUUID(),model_id:'unknown'}}),'test');assert('generation_error' in r);assert(r.persona_id);assert((await pool.query('SELECT 1 FROM personas WHERE id=$1',[r.persona_id])).rowCount);
  await pool.query("UPDATE persona_resource_previews SET created_at=now()-interval '2 days' WHERE id=$1",[p.id]);await assert.rejects(importResource(e.id,body(p),'test'),/已过期/);
 });
});
