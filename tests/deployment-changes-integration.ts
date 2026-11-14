import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {controlPool,pool,closeBusinessPools} from '../server/db.js';
import {initializeUserOwners} from '../server/user-access.js';
import {migrate} from '../server/migrate.js';
import {ensureLegacyIsolation} from '../server/bot-provisioning.js';
import {createApp} from '../server/app.js';
import {legacyBotId} from '../server/bot-context.js';
import {botRecord,withBot} from '../server/bot-workspaces.js';
import {sqlIdentifier} from '../server/bot-provisioning.js';

if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated disposable test database required');
let server:Server,url='',cookie='',csrf='';
async function req(path:string,method='GET',body?:unknown){const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),response};}
before(async()=>{
 await controlPool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await ensureLegacyIsolation();await initializeUserOwners();
 server=createServer(createApp());await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));url='http://127.0.0.1:'+(server.address() as any).port;
 const login=await req('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=(login.data as any).csrf;
});
after(async()=>{
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await closeBusinessPools();
 const legacy=await botRecord(legacyBotId);if(legacy?.db_role){await controlPool.query('DROP OWNED BY '+sqlIdentifier(legacy.db_role));await controlPool.query('DROP ROLE '+sqlIdentifier(legacy.db_role));}
 await pool.end();
});
test('host move keeps bot identity and onboarding while requiring pause and fresh target evidence',async()=>{
 const beforeBot=await botRecord(legacyBotId);assert.equal(beforeBot.runtime_host_id,'rococo-root2');
 await controlPool.query("UPDATE managed_bots SET state='paused' WHERE id=$1",[legacyBotId]);
 const bot=await botRecord(legacyBotId);
 const opened=await req('/bots/'+legacyBotId+'/deployment-changes','POST',{kind:'host_move',target_host_id:'rpi-groupdesk-01',reason:'Move existing WeChat runtime to the Raspberry Pi',revision:bot.revision});
 assert.equal(opened.status,201,JSON.stringify(opened.data));const change=(opened.data as any).id;
 assert.equal((await req('/bots/'+legacyBotId+'/deployment-changes/'+change+'/approve','POST',{})).status,200);
 const activation=await req('/bots/'+legacyBotId+'/activate','POST',{revision:bot.revision});assert.equal(activation.status,409);assert.match(JSON.stringify(activation.data),/运行环境变更尚未完成/);
 const checks={source_stopped:true,data_verified:true,target_ready:true,identity_verified:true,reader_verified:true,reply_still_paused:true};
 assert.equal((await req('/bots/'+legacyBotId+'/deployment-changes/'+change+'/verify','POST',checks)).status,409);
 await controlPool.query("UPDATE managed_runtime_hosts SET enabled=true,last_seen_at=now() WHERE id='rpi-groupdesk-01'");
 await controlPool.query('INSERT INTO managed_runtime_snapshots(id,host_id,report) VALUES($1,$2,$3)',[randomUUID(),'rpi-groupdesk-01',{bots:[{bot_id:legacyBotId,blocked:[]}]}]);
 assert.equal((await req('/bots/'+legacyBotId+'/deployment-changes/'+change+'/verify','POST',checks)).status,200);
 await controlPool.query("UPDATE managed_bots SET account_fingerprint='synthetic',runtime_seen_at=now(),runtime_status='{}'::jsonb WHERE id=$1",[legacyBotId]);
 assert.equal((await req('/bots/'+legacyBotId+'/deployment-changes/'+change+'/complete','POST',{})).status,409);
 await controlPool.query('UPDATE managed_bots SET runtime_status=$2,runtime_seen_at=now() WHERE id=$1',[legacyBotId,{wechat_connected:true,reader_connected:true,maibot_connected:true,local_ready:true}]);
 assert.equal((await req('/bots/'+legacyBotId+'/deployment-changes/'+change+'/complete','POST',{})).status,200);
 const afterBot=await botRecord(legacyBotId);assert.equal(afterBot.runtime_host_id,'rpi-groupdesk-01');assert.equal(afterBot.host_label,'rpi-groupdesk-01');assert.equal(afterBot.wechat_id,beforeBot.wechat_id);assert.equal(afterBot.revision,bot.revision+1);
 const launchOptions=await req('/bots/'+legacyBotId+'/activation-options');assert.equal(launchOptions.status,200);assert.equal((launchOptions.data as any).migration_launch,true);
 const editing=await req('/bots/'+legacyBotId,'PUT',{name:afterBot.name,wechat_id:afterBot.wechat_id,host_label:'rococo-root2',notes:afterBot.notes,revision:afterBot.revision});assert.equal(editing.status,409);
 const groupId=randomUUID();await withBot(legacyBotId,async()=>{await pool.query("INSERT INTO groups(id,name,external_id,enabled) VALUES($1,'Migration fixture','migration_fixture@chatroom',true)",[groupId]);});
 await controlPool.query("INSERT INTO managed_bot_adapters(token_hash,bot_id,name,group_external_ids) VALUES($1,$2,'migration-fixture',$3)",['f'.repeat(64),legacyBotId,JSON.stringify(['migration_fixture@chatroom'])]);
 const options=await req('/bots/'+legacyBotId+'/activation-options');assert.deepEqual((options.data as any).groups,[{id:groupId,name:'Migration fixture'}]);
 await controlPool.query('UPDATE managed_bots SET runtime_instance_id=$2,account_fingerprint=$3,runtime_status=$4,runtime_seen_at=now() WHERE id=$1',
  [legacyBotId,randomUUID(),'a'.repeat(64),{contract:1,revision:afterBot.revision,cutover_generation:afterBot.activation_generation,wechat_connected:true,reader_connected:true,maibot_connected:true,local_ready:true,stopped:true,sender_queue_depth:0,active_turns:0,send_inflight:false}]);
 assert.equal((await req('/bots/'+legacyBotId+'/activate','POST',{revision:afterBot.revision})).status,400);
 const selected=await req('/bots/'+legacyBotId+'/activate','POST',{revision:afterBot.revision,greeting_group_ids:[groupId]});assert.equal(selected.status,200,JSON.stringify(selected.data));
 const launch=(await controlPool.query('SELECT state,greeting_groups,activation_generation,catchup_from,catchup_through FROM managed_bot_migration_launches WHERE bot_id=$1',[legacyBotId])).rows[0];
 assert.equal(launch.state,'running');assert.deepEqual(launch.greeting_groups,['migration_fixture@chatroom']);assert.equal(launch.activation_generation,afterBot.activation_generation+1);assert.ok(launch.catchup_from<=launch.catchup_through);
});
