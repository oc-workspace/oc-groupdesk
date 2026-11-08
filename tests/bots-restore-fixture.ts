import assert from 'node:assert/strict';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createBot,ensureLegacyIsolation,sqlIdentifier} from '../server/bot-provisioning.js';
import {withBot,botRecord} from '../server/bot-workspaces.js';
import {legacyBotId,dataDirectory} from '../server/bot-context.js';
import {sealKey,openKey} from '../server/model-security.js';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
if(!process.env.DATABASE_URL?.endsWith('/groupdesk_test'))throw Error('Isolated database required');
try{
 const action=process.argv[2];
 if(action==='setup'){
  await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();
  const id=await createBot({name:'Restore fixture',wechat_id:'synthetic_restore',host_label:'test',notes:''},'admin');
  await withBot(id,async()=>{await pool.query('CREATE TABLE restore_probe(id int primary key,secret text)');await pool.query('INSERT INTO restore_probe VALUES(1,$1)',[sealKey('synthetic-model-secret')]);await mkdir(dataDirectory()+'/uploads',{recursive:true});await writeFile(dataDirectory()+'/uploads/probe.txt','synthetic-file');});
  console.log('Restore fixture created.');
 }else if(action==='destroy'){
  const rows=(await controlPool.query('SELECT * FROM managed_bots')).rows;
  for(const r of rows){if(r.id!==legacyBotId)await controlPool.query('DROP DATABASE '+sqlIdentifier(r.db_name)+' WITH (FORCE)');if(r.db_role){if(r.id===legacyBotId)await controlPool.query('DROP OWNED BY '+sqlIdentifier(r.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(r.db_role));}}
 }else if(action==='verify'){
  await ensureLegacyIsolation();
  const rows=(await controlPool.query('SELECT * FROM managed_bots')).rows;assert.equal(rows.length,2);assert(rows.every(r=>r.state==='paused'&&r.runtime_seen_at===null));
  const bot=rows.find(r=>r.id!==legacyBotId);await withBot(bot.id,async()=>{const r=(await pool.query('SELECT * FROM restore_probe')).rows;assert.equal(r.length,1);assert.equal(openKey(r[0].secret),'synthetic-model-secret');assert.equal(await readFile(dataDirectory()+'/uploads/probe.txt','utf8'),'synthetic-file');assert.equal((await pool.query('SELECT current_user u')).rows[0].u,bot.db_role);});
  await withBot(legacyBotId,async()=>{assert.equal((await pool.query('SELECT count(*) n FROM groups')).rows[0].n,'2');await assert.rejects(pool.query('SELECT * FROM managed_bots'),{code:'42501'});await assert.rejects(pool.query('SELECT password_hash FROM admins'),{code:'42501'});});
  assert.equal((await controlPool.query('SELECT * FROM managed_bot_switch')).rowCount,0);console.log('Multi-bot restore verified: roles, data, encryption, files, isolation and paused state.');
 }else throw Error('Unknown fixture action');
}finally{await closeBusinessPools();await controlPool.end();}
