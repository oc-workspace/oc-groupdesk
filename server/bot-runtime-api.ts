import type express from 'express';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {botRecord} from './bot-workspaces.js';
import {finishPendingActivation} from './bot-lifecycle.js';
import {requireCondition} from './security.js';
export function registerBotRuntime(app:express.Express){
 app.get('/api/runtime/bot-migration-launch',async(req,res)=>{
  const bot=await botRecord(req.botId!);requireCondition(bot,404,'机器人不存在');
  const launch=(await controlPool.query(`SELECT id,greeting_groups,catchup_from,catchup_through,
   activation_generation,state,greeting_done,catchup_scanned,catchup_sent,catchup_attention
   FROM managed_bot_migration_launches WHERE bot_id=$1 AND state IN ('running','attention')
   ORDER BY created_at DESC LIMIT 1`,[req.botId])).rows[0];
  if(!launch||bot.state!=='active'||launch.activation_generation!==bot.activation_generation){res.json({launch:null});return;}
  res.json({launch});
 });
 app.post('/api/runtime/bot-migration-launch-progress',async(req,res)=>{
  const body=z.object({launch_id:z.uuid(),activation_generation:z.number().int().min(0),
   greeting_done:z.array(z.string().min(1).max(200)).max(20),catchup_scanned:z.number().int().min(0),
   catchup_sent:z.number().int().min(0),catchup_attention:z.number().int().min(0),
   state:z.enum(['running','completed','attention'])}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const row=(await db.query(`SELECT l.*,b.state bot_state,b.activation_generation bot_generation
    FROM managed_bot_migration_launches l JOIN managed_bots b ON b.id=l.bot_id
    WHERE l.id=$1 AND l.bot_id=$2 FOR UPDATE OF l,b`,[body.launch_id,req.botId])).rows[0];
   requireCondition(row&&row.bot_state==='active'&&row.bot_generation===body.activation_generation&&
    row.activation_generation===body.activation_generation&&['running','attention'].includes(row.state),409,'迁移上线状态已变化');
   const planned=new Set(row.greeting_groups as string[]),done=new Set(body.greeting_done);
   requireCondition([...done].every(v=>planned.has(v))&&body.catchup_sent+body.catchup_attention<=body.catchup_scanned,400,'进度数据无效');
   requireCondition(body.catchup_scanned>=row.catchup_scanned&&body.catchup_sent>=row.catchup_sent&&
    body.catchup_sent+body.catchup_attention>=row.catchup_sent+row.catchup_attention,409,'进度不能倒退');
   requireCondition(body.state!=='completed'||done.size===planned.size&&body.catchup_attention===0,409,'仍有待处理消息');
   await db.query(`UPDATE managed_bot_migration_launches SET greeting_done=$2,catchup_scanned=$3,
    catchup_sent=$4,catchup_attention=$5,state=$6,updated_at=now() WHERE id=$1`,
    [row.id,JSON.stringify(body.greeting_done),body.catchup_scanned,body.catchup_sent,body.catchup_attention,body.state]);
   if(body.state==='completed')await audit('runtime','bot.migration_launch_completed',req.botId!,{launch_id:row.id,greeting_groups:done.size,catchup_sent:body.catchup_sent},db);
  });res.json({ok:true});
 });
 app.get('/api/runtime/bot-state',async(req,res)=>{
  const b=await botRecord(req.botId!);requireCondition(b,404,'机器人不存在');
  res.json({contract:1,bot_id:b.id,wechat_id:b.wechat_id,state:b.state,revision:b.revision,activation_generation:b.activation_generation,enabled:b.state==='active',identity_bound:!!b.account_fingerprint});
 });
 app.post('/api/runtime/bot-heartbeat',async(req,res)=>{
  const body=z.object({contract:z.literal(1),bot_id:z.uuid(),instance_id:z.uuid(),account_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().positive(),wechat_connected:z.boolean(),reader_connected:z.boolean(),maibot_connected:z.boolean(),sender_queue_depth:z.number().int().min(0).max(10000),active_turns:z.number().int().min(0).max(10000),send_inflight:z.boolean(),stopped:z.boolean(),cutover_generation:z.number().int().min(0),local_ready:z.boolean()}).strict().parse(req.body);
  requireCondition(body.bot_id===req.botId,403,'接入凭据不属于此机器人');
  await controlTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(78511966)');
   const b=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[req.botId])).rows[0];requireCondition(b&&b.state!=='archived',409,'机器人已归档');
   requireCondition(!b.runtime_instance_id||b.runtime_instance_id===body.instance_id,409,'此机器人已绑定其他运行实例');
   requireCondition(!b.account_fingerprint||b.account_fingerprint===body.account_fingerprint,409,'微信账号数据库与已绑定账号不符，已拒绝接入');
   await db.query('UPDATE managed_bots SET runtime_instance_id=$2,account_fingerprint=$3,runtime_status=$4,runtime_seen_at=now() WHERE id=$1',[b.id,body.instance_id,body.account_fingerprint,JSON.stringify(body)]);
   if(b.state==='pausing'&&body.revision===b.revision&&body.stopped&&!body.send_inflight&&body.sender_queue_depth===0&&body.active_turns===0){
    await db.query("UPDATE managed_bots SET state='paused',stopped_revision=$2,revision=revision+1 WHERE id=$1",[b.id,b.revision]);await audit('runtime','bot.pause_confirmed',b.id,{},db);
   }
  });
  await finishPendingActivation();res.json({ok:true});
 });
}
