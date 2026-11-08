import type express from 'express';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {botRecord} from './bot-workspaces.js';
import {finishPendingActivation} from './bot-lifecycle.js';
import {requireCondition} from './security.js';
export function registerBotRuntime(app:express.Express){
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
