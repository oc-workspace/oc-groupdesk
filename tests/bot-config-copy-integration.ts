import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createBot,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {copyBotConfiguration} from '../server/bot-config-copy.js';
import {sealKey,openKey} from '../server/model-security.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let source='',target='',occupied='',group='',credential='',version='',persona='',feature='',featureVersion='',sourceCipher='';
const created:string[]=[];
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();
 for(const name of ['copy_source','copy_target','copy_occupied'])created.push(await createBot({name,wechat_id:name,host_label:'synthetic',notes:''},'admin'));
 [source,target,occupied]=created;
 await withBot(source,async()=>{
  credential=randomUUID();group=randomUUID();persona=randomUUID();version=randomUUID();feature=randomUUID();featureVersion=randomUUID();
  sourceCipher=sealKey('synthetic-provider-key-only');
  await pool.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[credential,'Synthetic credential','https://example.com/v1',sourceCipher,'••••only','synthetic-digest','openai_responses']);
  await pool.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,'synthetic-text','Synthetic','text','configured',true)",[credential]);
  const route={credential_id:credential,model_id:'synthetic-text'};
  await pool.query('UPDATE model_settings SET routes=$1 WHERE singleton=true',[{text:route,image:null,stages:{planner:route}}]);
  for(const [p,v,kind] of [[persona,version,'base'],[feature,featureVersion,'feature']]){
   const content='Published synthetic '+kind;
   await pool.query('INSERT INTO personas(id,name,skill_name,dataset_ids,draft_skill,kind) VALUES($1,$2,$3,$4,$5,$6)',[p,'Synthetic '+kind,'synthetic-'+kind,[randomUUID()],'UNPUBLISHED MUST NOT COPY',kind]);
   await pool.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,kind) VALUES($1,$2,1,$3,$4,$5)',[v,p,content,createHash('sha256').update(content).digest('hex'),kind]);
  }
  await pool.query('INSERT INTO groups(id,name,external_id,enabled,model_routes,persona_version_id,policy) VALUES($1,$2,$3,true,$4,$5,$6)',[group,'Synthetic SSH','old-account-chat-42',{text:{mode:'custom',...route},image:{mode:'inherit'},stages:{planner:{mode:'custom',...route}}},version,{synthetic:true}]);
  await pool.query('INSERT INTO group_topics(group_id,topic_id) SELECT $1,id FROM topics LIMIT 1',[group]);
  await pool.query('INSERT INTO group_persona_features(group_id,persona_id,version_id,position) VALUES($1,$2,$3,0)',[group,feature,featureVersion]);
 });
 await withBot(occupied,()=>pool.query('INSERT INTO groups(id,name) VALUES($1,$2)',[randomUUID(),'Keep existing group']));
});
after(async()=>{
 await closeBusinessPools();
 for(const id of created){const bot=await botRecord(id);await controlPool.query('DROP DATABASE '+sqlIdentifier(bot.db_name)+' WITH (FORCE)');await controlPool.query('DROP ROLE '+sqlIdentifier(bot.db_role));}
 await pool.end();
});
test('configuration copy creates independent IDs and retains a reference without duplicating the paid key',async()=>{
 const result=await copyBotConfiguration(source,target,group,'synthetic-test');
 assert.equal(result.credentials,1);assert.equal(result.personas,2);assert.equal(result.external_id_bound,false);
 await withBot(target,async()=>{
  const c=(await pool.query('SELECT * FROM model_credentials')).rows[0];
  assert.notEqual(c.id,credential);assert.notEqual(c.key_ciphertext,sourceCipher);assert.equal(c.key_ciphertext,'vault:v1');assert(c.vault_key_id);const central=await (await import('../server/key-vault.js')).keyForAlias(c.id);assert.equal((await import('../server/bot-secrets.js')).openControlSecret(central.secret_ciphertext),'synthetic-provider-key-only');
  const g=(await pool.query('SELECT * FROM groups')).rows[0];assert.notEqual(g.id,group);assert.equal(g.external_id,null);assert.equal(g.enabled,false);assert.equal(g.applied_revision,0);assert.equal(g.bot_seen_at,null);
  assert.equal(g.model_routes.text.credential_id,c.id);assert.equal(g.model_routes.stages.planner.credential_id,c.id);
  const defaults=(await pool.query('SELECT routes FROM model_settings')).rows[0].routes;assert.equal(defaults.text.credential_id,c.id);assert.equal(defaults.stages.planner.credential_id,c.id);
  assert.notEqual(g.persona_version_id,version);
  const p=(await pool.query('SELECT * FROM personas ORDER BY name')).rows;assert.equal(p.length,2);assert(p.every(x=>x.dataset_ids.length===0&&!x.draft_skill.includes('UNPUBLISHED')));
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_persona_features')).rows[0].n,1);
  for(const table of ['persona_materials','persona_datasets','persona_imports','interaction_wallets','interaction_ledger','summary_schedules','summary_jobs','runtime_adapters'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0,table);
  assert.throws(()=>openKey(sourceCipher));
 });
 await withBot(source,async()=>{const g=(await pool.query('SELECT * FROM groups WHERE id=$1',[group])).rows[0];assert.equal(g.external_id,'old-account-chat-42');assert.equal(g.enabled,true);assert.equal((await pool.query('SELECT key_ciphertext FROM model_credentials')).rows[0].key_ciphertext,'vault:v1');});
});
test('repeat is idempotent and does not overwrite later target edits',async()=>{
 await withBot(target,()=>pool.query("UPDATE model_credentials SET name='Target edit'"));
 const a=await copyBotConfiguration(source,target,group,'synthetic-test'),b=await copyBotConfiguration(source,target,group,'synthetic-test');assert.equal(a.group_id,b.group_id);
 await withBot(target,async()=>{assert.equal((await pool.query('SELECT name FROM model_credentials')).rows[0].name,'Target edit');assert.equal((await pool.query('SELECT count(*)::int n FROM groups')).rows[0].n,1);});
});
test('existing target configuration and source-equals-target are rejected without mutations',async()=>{
 await assert.rejects(copyBotConfiguration(source,occupied,group,'synthetic-test'));
 await assert.rejects(copyBotConfiguration(source,source,group,'synthetic-test'));
 await withBot(occupied,async()=>assert.deepEqual((await pool.query('SELECT name FROM groups')).rows.map(r=>r.name),['Keep existing group']));
});
