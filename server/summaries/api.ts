import type express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,audit} from '../db.js';
import {requireCondition,HttpError} from '../security.js';
import {summaryConfig,scheduleSchema,windowSchema,nextOccurrence,resolveWindow} from '../../shared/summaries.js';
import {settings,group,validateConfig,enqueue,valid} from './core.js';
import {prepareParts,sourceStats} from './generation.js';
const uuid=(v:unknown)=>z.uuid().parse(v);
export function registerSummaryAdmin(app:express.Express){
 app.get('/api/summaries',async(_req,res)=>{
  const groups=(await pool.query('SELECT id,name FROM groups ORDER BY name')).rows;
  res.json({groups:await Promise.all(groups.map(async g=>({...g,...await settings(g.id)}))),templates:(await pool.query('SELECT * FROM summary_templates ORDER BY slug')).rows,schedules:(await pool.query('SELECT * FROM summary_schedules ORDER BY created_at')).rows,jobs:(await pool.query('SELECT j.id,j.group_id,j.status,j.wants_publish,j.window_start,j.window_end,j.report,j.source->\'stats\' stats,j.error,j.created_at,g.name group_name FROM summary_jobs j JOIN groups g ON g.id=j.group_id ORDER BY j.created_at DESC LIMIT 80')).rows});
 });
 app.put('/api/summaries/groups/:id',async(req,res)=>{
  const id=uuid(req.params.id),b=z.object({revision:z.number().int().min(0),config:summaryConfig}).parse(req.body);
  await transaction(async db=>{await db.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE',[id]);const g=await group(id,db),s=await settings(id,db);requireCondition(s.revision===b.revision,409,'总结配置已变化，请刷新');await validateConfig(g,b.config,db);
   await db.query('INSERT INTO summary_settings(group_id,config) VALUES($1,$2) ON CONFLICT(group_id) DO UPDATE SET config=$2,revision=summary_settings.revision+1',[id,b.config]);
   if(!b.config.enabled||b.config.timezone!==s.config.timezone)await db.query('UPDATE summary_schedules SET enabled=false,last_error=$2 WHERE group_id=$1',[id,'发布已停用或时区已变化，请检查后重新启用计划']);
   await db.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='总结配置已修改，请按新配置创建任务',finished_at=now() WHERE group_id=$1 AND status IN ('waiting_source','reading','queued','generating','preview','delivery_ready')",[id]);
   await audit(req.admin!.username,'summary.settings_saved',id,{},db);
  });res.json({ok:true});
 });
 app.put('/api/summaries/templates/:slug',async(req,res)=>{const b=z.object({revision:z.number().int().positive(),name:z.string().trim().min(1).max(100),instructions:z.string().trim().min(20).max(12000)}).parse(req.body);const r=await pool.query('UPDATE summary_templates SET name=$2,instructions=$3,revision=revision+1 WHERE slug=$1 AND revision=$4',[req.params.slug,b.name,b.instructions,b.revision]);requireCondition(r.rowCount,409,'模板已变化，请刷新');await audit(req.admin!.username,'summary.template_saved',String(req.params.slug));res.json({ok:true});});
 app.post('/api/summaries/jobs',async(req,res)=>{const b=z.object({group_id:z.uuid(),window:windowSchema,publish:z.boolean(),request_id:z.uuid()}).parse(req.body);const id=await transaction(db=>enqueue(db,b.group_id,b.window,b.publish,b.request_id));res.status(202).json({id});});
 app.post('/api/summaries/jobs/:id/cancel',async(req,res)=>{const id=uuid(req.params.id);const r=await pool.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='管理员已取消',finished_at=now() WHERE id=$1 AND status IN ('waiting_source','reading','queued','generating','preview','delivery_ready')",[id]);requireCondition(r.rowCount,409,'当前任务无法取消，请刷新查看状态');await audit(req.admin!.username,'summary.cancelled',id);res.json({ok:true});});
 app.post('/api/summaries/jobs/:id/publish',async(req,res)=>{
  const id=uuid(req.params.id),b=z.object({report:z.string().trim().min(20).max(10000)}).parse(req.body);
  await transaction(async db=>{const j=(await db.query('SELECT * FROM summary_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(j?.status==='preview',409,'预览已发布或失效，请刷新');const {g}=await valid(j,db,true);
   const n=(await db.query("SELECT count(*)::int n FROM summary_jobs WHERE group_id=$1 AND wants_publish AND created_at>now()-interval '24 hours'",[j.group_id])).rows[0].n;requireCondition(n<10,429,'本群24小时总结发布额度已用完');
   await prepareParts(db,{...j,report:b.report,group_name:g.name});await db.query("UPDATE summary_jobs SET report=$2,wants_publish=true,status='delivery_ready',created_at=now(),finished_at=NULL WHERE id=$1",[id,b.report]);await audit(req.admin!.username,'summary.publish_requested',id,{},db);
  });res.json({ok:true});
 });
 app.post('/api/summaries/schedules',async(req,res)=>{
  const b=z.object({group_id:z.uuid(),name:z.string().trim().min(1).max(120),enabled:z.boolean(),config:scheduleSchema}).parse(req.body),id=randomUUID();const g=await group(b.group_id),s=await settings(g.id);requireCondition(!b.enabled||s.config.enabled,409,'请先启用本群总结发布');
  let next:string;try{next=nextOccurrence(b.config,s.config.timezone,Date.now());resolveWindow(b.config.window,s.config.timezone,new Date(next).getTime());}catch(e){throw new HttpError(400,(e as Error).message);}
  await pool.query('INSERT INTO summary_schedules(id,group_id,name,enabled,config,next_run) VALUES($1,$2,$3,$4,$5,$6)',[id,g.id,b.name,b.enabled,b.config,next]);await audit(req.admin!.username,'summary.schedule_created',id);res.status(201).json({id});
 });
 app.put('/api/summaries/schedules/:id',async(req,res)=>{const id=uuid(req.params.id),b=z.object({revision:z.number().int().positive(),enabled:z.boolean()}).parse(req.body),s=(await pool.query('SELECT * FROM summary_schedules WHERE id=$1',[id])).rows[0];requireCondition(s,404,'计划不存在');const cfg=await settings(s.group_id);requireCondition(!b.enabled||cfg.config.enabled,409,'请先启用本群总结发布');let next=s.next_run;if(b.enabled)try{next=nextOccurrence(s.config,cfg.config.timezone,Date.now());}catch(e){throw new HttpError(400,(e as Error).message);}const r=await pool.query('UPDATE summary_schedules SET enabled=$2,revision=revision+1,next_run=$3,last_error=NULL WHERE id=$1 AND revision=$4',[id,b.enabled,next,b.revision]);requireCondition(r.rowCount,409,'计划已更新，请刷新');res.json({ok:true});});
}
async function authorized(req:express.Request,id:string,db:any){const g=await group(id,db);requireCondition(!req.runtimeGroups||req.runtimeGroups.includes(g.external_id),403,'此适配器未授权该群');return g;}
export function registerSummaryRuntime(app:express.Express){
 app.post('/api/runtime/summaries/claim',async(req,res)=>{
  const b=z.object({external_id:z.string().min(1).max(200),kind:z.enum(['source','delivery'])}).parse(req.body);
  const result=await transaction(async db=>{
   const g=(await db.query('SELECT id FROM groups WHERE external_id=$1',[b.external_id])).rows[0];requireCondition(g,404,'群不存在');await authorized(req,g.id,db);
   await db.query('UPDATE summary_settings SET last_adapter_seen=now() WHERE group_id=$1',[g.id]);
   const status=b.kind==='source'?'waiting_source':'delivery_ready',j=(await db.query('SELECT * FROM summary_jobs WHERE group_id=$1 AND status=$2 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',[g.id,status])).rows[0];if(!j)return null;
   try{await valid(j,db,b.kind==='delivery');}catch{await db.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='群或总结配置已变化' WHERE id=$1",[j.id]);return null;}
   const token=randomUUID();await db.query('UPDATE summary_jobs SET status=$2,lease_until=now()+interval \'2 minutes\',source_token=CASE WHEN $3 THEN $4 ELSE source_token END,delivery_token=CASE WHEN $3 THEN delivery_token ELSE $4 END WHERE id=$1',[j.id,b.kind==='source'?'reading':'delivering',b.kind==='source',token]);
   return {id:j.id,token,external_id:j.external_id,group_revision:j.group_revision,start:j.window_start,end:j.window_end,...(b.kind==='delivery'?{parts:(await db.query('SELECT ordinal,body FROM summary_parts WHERE job_id=$1 ORDER BY ordinal',[j.id])).rows}:{})};
  });res.json({job:result});
 });
 app.post('/api/runtime/summaries/jobs/:id/source',async(req,res)=>{
  const b=z.object({token:z.uuid(),error:z.enum(['source_unavailable','too_large','no_messages']).optional(),messages:z.array(z.object({seq:z.number().int().positive(),sender:z.string().max(500).nullable(),text:z.string().max(20000),at:z.string().datetime({offset:true}),time_kind:z.enum(['original','capture'])})).max(5000).optional()}).parse(req.body),id=uuid(req.params.id);
  await transaction(async db=>{const j=(await db.query('SELECT * FROM summary_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(j,404,'任务不存在');await authorized(req,j.group_id,db);await valid(j,db);requireCondition(j.status==='reading'&&j.source_token===b.token&&new Date(j.lease_until).getTime()>Date.now(),409,'取数任务租约已失效');
   if(b.error){await db.query("UPDATE summary_jobs SET status='failed',error=$2,finished_at=now() WHERE id=$1",[id,{source_unavailable:'Bot服务器存档暂不可读',too_large:'本时段记录过多，请缩短范围',no_messages:'该时段没有服务器已采集记录'}[b.error]]);return;}
   const messages=b.messages||[];requireCondition(messages.length&&new Set(messages.map(m=>m.seq)).size===messages.length,400,'记录为空或包含重复来源ID');requireCondition(messages.every(m=>Date.parse(m.at)>=new Date(j.window_start).getTime()&&Date.parse(m.at)<new Date(j.window_end).getTime()),400,'消息时间超出总结范围');
   requireCondition(JSON.stringify(messages).length<=115000,400,'本时段文字过多，请缩短范围');
   await db.query("UPDATE summary_jobs SET status='queued',source=$2,lease_until=NULL WHERE id=$1",[id,{messages,stats:sourceStats(messages),origin:'bot-server-captured',fetched_at:new Date().toISOString()}]);
  });res.json({ok:true});
 });
 app.post('/api/runtime/summaries/jobs/:id/part',async(req,res)=>{
  const id=uuid(req.params.id),b=z.object({token:z.uuid(),ordinal:z.number().int().min(0).max(7),action:z.enum(['reserve','sent','failed','uncertain'])}).parse(req.body);
  const result=await transaction(async db=>{
   const j=(await db.query('SELECT * FROM summary_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(j,404,'任务不存在');await authorized(req,j.group_id,db);requireCondition(j.delivery_token===b.token,403,'发布令牌不符');
   const part=(await db.query('SELECT * FROM summary_parts WHERE job_id=$1 AND ordinal=$2',[id,b.ordinal])).rows[0];requireCondition(part,404,'总结分段不存在');
   if(b.action==='reserve'){
    await valid(j,db,true);requireCondition(j.status==='delivering'&&new Date(j.lease_until).getTime()>Date.now(),409,'发布租约已失效');
    if(part.status!=='waiting')return {send:false};
    requireCondition(!(await db.query("SELECT 1 FROM summary_parts WHERE job_id=$1 AND ordinal<$2 AND status<>'sent'",[id,b.ordinal])).rowCount,409,'前一段尚未确认');
    await db.query("UPDATE summary_parts SET status='reserved' WHERE job_id=$1 AND ordinal=$2",[id,b.ordinal]);await db.query("UPDATE summary_jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1",[id]);return {send:true,text:part.body};
   }
   if(part.status===b.action)return {ok:true};requireCondition(part.status==='reserved'&&j.status==='delivering',409,'该分段未预留或已结束');
   await db.query('UPDATE summary_parts SET status=$3 WHERE job_id=$1 AND ordinal=$2',[id,b.ordinal,b.action]);
   const remaining=(await db.query("SELECT 1 FROM summary_parts WHERE job_id=$1 AND status<>'sent'",[id])).rowCount;
   if(b.action!=='sent'||!remaining)await db.query('UPDATE summary_jobs SET status=$2,error=$3,finished_at=now() WHERE id=$1',[id,b.action==='sent'?'sent':b.action,b.action==='sent'?null:'发送未能确认，已停止后续分段；请先核实群内记录']);
   return {ok:true};
  });res.json(result);
 });
}
