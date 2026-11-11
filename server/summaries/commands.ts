import type express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction,audit} from '../db.js';
import {requireCondition} from '../security.js';
import {resolveWindow} from '../../shared/summaries.js';
import {enqueue,group,settings} from './core.js';

const command=z.object({
 external_id:z.string().min(1).max(200),
 epoch:z.string().regex(/^[a-f0-9]{32}$/),
 seq:z.number().int().positive(),
 server_id:z.string().regex(/^[1-9][0-9]{0,20}$/),
 sender_id:z.string().trim().min(1).max(200),
 sender_name:z.string().trim().min(1).max(500).nullable(),
 source_at:z.string().datetime({offset:true}),
 text:z.enum(['/generate-summary','/generate-summary 截止目前'])
});

export function registerSummaryCommands(app:express.Express){
 app.post('/api/runtime/summaries/command',async(req,res)=>{
  const b=command.parse(req.body),at=Date.parse(b.source_at),now=Date.now();
  requireCondition(at<=now+30000&&at>=now-600000,409,'群命令已过期或时间无效');
  const result=await transaction(async db=>{
   const found=(await db.query('SELECT id FROM groups WHERE deleted_at IS NULL AND external_id=$1 FOR UPDATE',[b.external_id])).rows[0];
   requireCondition(found,404,'群不存在');
   const g=await group(found.id,db);
   requireCondition(!req.runtimeGroups||req.runtimeGroups.includes(g.external_id),403,'此适配器未授权该群');
   const s=await settings(g.id,db);requireCondition(g.enabled&&s.config.enabled&&s.config.group_command_enabled===true,409,'本群未启用群命令总结');
   const mode=b.text==='/generate-summary'?'previous_day':'today';
   const bounds=resolveWindow({kind:mode},s.config.timezone,at);
   const source=(await db.query("SELECT id FROM summary_jobs WHERE group_id=$1 AND trigger_kind='group_command' AND trigger_source_epoch=$2 AND trigger_source_seq=$3",[g.id,b.epoch,b.seq])).rows[0];
   const candidate=source?.id?(await db.query('SELECT * FROM summary_jobs WHERE id=$1',[source.id])).rows[0]:
    (await db.query(`SELECT * FROM summary_jobs WHERE group_id=$1 AND wants_publish AND window_start=$2
      AND ($3='today' OR window_end=$4) AND window_end<=$4
      AND status IN ('waiting_source','reading','queued','generating','delivery_ready','delivering','sent','uncertain')
      ORDER BY CASE WHEN status='sent' THEN 0 WHEN status='uncertain' THEN 2 ELSE 1 END,created_at DESC LIMIT 1`,
      [g.id,bounds.start,mode,bounds.end])).rows[0];
   let j=candidate;
   if(!j){
    const id=await enqueue(db,g.id,{kind:mode},true,randomUUID(),at);
    await db.query("UPDATE summary_jobs SET trigger_kind='group_command',trigger_mode=$2,trigger_actor_id=$3,trigger_actor_name=$4,trigger_source_epoch=$5,trigger_source_seq=$6,trigger_source_server_id=$7 WHERE id=$1",[id,mode,b.sender_id,b.sender_name,b.epoch,b.seq,b.server_id]);
    await audit('group_command','summary.command_queued',id,{group_id:g.id,sender_id:b.sender_id,mode,source_seq:b.seq},db);
    j={id,status:'waiting_source',window_end:bounds.end};
   }
   if(source)return {state:'already_processed',job_id:j.id,window_end:j.window_end};
   if(j.status!=='sent')return {state:j.status==='uncertain'?'uncertain':'in_progress',job_id:j.id,window_end:j.window_end};
   const part=(await db.query('SELECT body,wechat_server_id FROM summary_parts WHERE job_id=$1 AND ordinal=0',[j.id])).rows[0];
   if(!part?.wechat_server_id)return {state:'reference_unavailable',job_id:j.id,window_end:j.window_end};
   return {state:'already_sent',job_id:j.id,window_end:j.window_end,server_id:part.wechat_server_id,anchor_text:part.body};
  });res.json(result);
 });
}
