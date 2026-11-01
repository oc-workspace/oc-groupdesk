import type express from 'express';
import {z} from 'zod';
import {transaction,audit} from './db.js';
import {requireCondition} from './security.js';

export const runtimeHealthSchema=z.object({
 external_id:z.string().min(1).max(200),
 state:z.enum(['online','recovering','needs_phone','needs_unlock','degraded','maintenance','offline']),
 wechat:z.boolean(),bridge:z.boolean(),maibot:z.boolean(),
 reason:z.string().regex(/^[a-z_]{1,80}$/),
 interval_seconds:z.literal(3600),
 notification_configured:z.boolean().optional(),notification_pending:z.boolean().optional(),
 actions:z.array(z.enum(['restart_bridge','restart_adapter','start_wechat','click_login','restart_maibot'])).max(5),
 memory_mib:z.number().nonnegative().max(1000000).optional(),
 swap_mib:z.number().nonnegative().max(1000000).optional()
}).strict();

export function registerRuntimeHealth(app:express.Express){
 app.post('/api/runtime/health',async(req,res)=>{
  const body=runtimeHealthSchema.parse(req.body);
  requireCondition(!req.runtimeGroups||req.runtimeGroups.includes(body.external_id),403,'此适配器未授权该群');
  await transaction(async db=>{
   const group=(await db.query('SELECT id,runtime_health FROM groups WHERE external_id=$1 FOR UPDATE',[body.external_id])).rows[0];
   requireCondition(group,404,'群未绑定');
   const {external_id,...health}=body;
   await db.query('UPDATE groups SET runtime_health=$1,runtime_health_at=now() WHERE id=$2',[health,group.id]);
   if(group.runtime_health?.state!==body.state||group.runtime_health?.reason!==body.reason)
    await audit('bot','runtime.health_changed',group.id,{state:body.state,reason:body.reason},db);
  });
  res.json({ok:true});
 });
}
