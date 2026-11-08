import {isDeepStrictEqual} from 'node:util';
import type express from 'express';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {requireCondition} from './security.js';
export const replyFrequencySchema=z.object({
 windows:z.array(z.object({minutes:z.number().int().min(1).max(1440),max_replies:z.number().int().min(1).max(1000)}).strict()).min(1).max(4),
 catch_up:z.object({enabled:z.boolean(),within_minutes:z.number().int().min(1).max(60)}).strict()
}).strict().refine(v=>new Set(v.windows.map(w=>w.minutes)).size===v.windows.length,{message:'时间窗口不能重复'});
export async function replyFrequency(){return (await pool.query('SELECT revision,policy FROM workspace_reply_frequency WHERE id=1')).rows[0];}
export function registerReplyFrequency(app:express.Express){
 app.get('/api/reply-frequency',async(_req,res)=>{
  const value=await replyFrequency();
  const groups=(await pool.query('SELECT id,name,enabled,reply_frequency_applied_revision applied_revision FROM groups WHERE deleted_at IS NULL ORDER BY name')).rows;
  res.json({...value,groups});
 });
 app.put('/api/reply-frequency',async(req,res)=>{
  const b=z.object({revision:z.number().int().positive(),policy:replyFrequencySchema}).strict().parse(req.body);
  await transaction(async db=>{
   const old=(await db.query('SELECT revision,policy FROM workspace_reply_frequency WHERE id=1 FOR UPDATE')).rows[0];
   requireCondition(old.revision===b.revision,409,'回复频率已被更新，请刷新后重试');
   if(!isDeepStrictEqual(old.policy,b.policy)){
    await db.query('UPDATE workspace_reply_frequency SET revision=revision+1,policy=$1 WHERE id=1',[b.policy]);
    await db.query('UPDATE groups SET reply_frequency_applied_revision=0');
    await audit(req.admin!.username,'reply_frequency.updated',null,{policy:b.policy},db);
   }
  });res.json({ok:true});
 });
}
