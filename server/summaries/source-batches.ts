import type express from 'express';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from '../db.js';
import {requireCondition,digest} from '../security.js';
import {valid} from './core.js';
import {sourceStats} from './generation.js';
import {saveReaderSource} from './source-cache.js';
export const sourceMessage=z.object({seq:z.number().int().positive().safe(),sender:z.string().max(1000).nullable(),text:z.string().max(40000),at:z.string().datetime({offset:true}),time_kind:z.enum(['original','capture'])});
const planSchema=z.object({epoch:z.string().regex(/^[a-f0-9]{32}$/),through:z.number().int().min(0).safe(),count:z.number().int().min(0).max(100000000),text_chars:z.number().int().min(0).max(10000000000),max_text_chars:z.number().int().min(0).max(100000000),page_limit:z.number().int().min(1).max(200),planned_batches:z.number().int().min(0).max(100000000)});
export const sourceErrors={source_unavailable:'Bot服务器存档暂不可读或本次读取未完整完成，请重试',too_large:'总结材料超过本次处理上限，请缩短范围',no_messages:'该时段没有服务器已采集记录',too_many_messages:'本时段超过20,000条消息，请缩短范围',too_much_text:'本时段正文超过200万字符，请缩短范围',message_too_long:'本时段存在超过2万字符的单条消息，请缩短范围'};
export const characters=(v:string)=>Array.from(v).length;
async function reading(db:any,id:string,token:string,req:express.Request,authorize:any){
 const job=(await db.query('SELECT * FROM summary_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
 requireCondition(job,404,'任务不存在');await authorize(req,job.group_id,db);await valid(job,db);
 requireCondition(job.status==='reading'&&job.source_token===token&&new Date(job.lease_until).getTime()>Date.now(),409,'取数任务租约已失效');return job;
}
export function validateMessages(messages:z.infer<typeof sourceMessage>[],job:any){
 requireCondition(messages.length>0&&new Set(messages.map(m=>m.seq)).size===messages.length,400,'记录为空或包含重复来源ID');
 requireCondition(messages.every(m=>Date.parse(m.at)>=new Date(job.window_start).getTime()&&Date.parse(m.at)<new Date(job.window_end).getTime()),400,'消息时间超出总结范围');
 requireCondition(messages.every(m=>characters(m.text)<=20000&&(!m.sender||characters(m.sender)<=500)),400,'单条消息或发言人名称超过上限');
}
export function registerSourceBatches(app:express.Express,authorize:any){
 app.post('/api/runtime/summaries/jobs/:id/source-plan',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),body=z.object({token:z.uuid(),source_kind:z.literal('wechat_database'),plan:planSchema}).parse(req.body);
  await transaction(async db=>{
   const job=await reading(db,id,body.token,req,authorize),old=job.source?.plan;
   if(old){requireCondition(isDeepStrictEqual(old,body.plan),409,'取数计划已存在差异');return;}
   await db.query("UPDATE summary_jobs SET source=$2,progress=$3,lease_until=now()+interval '2 minutes' WHERE id=$1",[id,JSON.stringify({plan:body.plan,origin:'wechat-database-chatlog-keeper'}),JSON.stringify({phase:'reading',source_origin:'wechat-database-chatlog-keeper',total_count:body.plan.count,total_characters:body.plan.text_chars,planned_batches:body.plan.planned_batches,read_count:0,completed_batches:0})]);
  });res.json({ok:true});
 });
 app.post('/api/runtime/summaries/jobs/:id/source-batch',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),body=z.object({token:z.uuid(),ordinal:z.number().int().min(0).max(20000),read_batches:z.number().int().min(1).max(20000),messages:z.array(sourceMessage).min(1).max(200)}).parse(req.body);
  const serialized=JSON.stringify(body.messages),hash=digest(serialized);requireCondition(Buffer.byteLength(serialized)<=200000,400,'本批材料过大，请减小批次');
  await transaction(async db=>{
   const job=await reading(db,id,body.token,req,authorize),plan=job.source?.plan;
   requireCondition(plan&&plan.count<=20000&&plan.text_chars<=2000000&&plan.max_text_chars<=20000,409,'取数预检查未通过');validateMessages(body.messages,job);
   const old=(await db.query('SELECT digest FROM summary_source_batches WHERE job_id=$1 AND ordinal=$2',[id,body.ordinal])).rows[0];
   if(old){requireCondition(old.digest===hash,409,'同批材料已存在差异');return;}
   const previous=(await db.query('SELECT count(*)::int n FROM summary_source_batches WHERE job_id=$1',[id])).rows[0].n;
   requireCondition(previous===body.ordinal,409,'请按顺序上传取数批次');
   const count=(job.progress.read_count||0)+body.messages.length,chars=(job.progress.read_characters||0)+body.messages.reduce((n,m)=>n+characters(m.text),0),size=(job.progress.source_bytes||0)+Buffer.byteLength(serialized);
   requireCondition(count<=plan.count&&chars<=plan.text_chars&&size<=16000000,400,'本次读取与统计不一致或材料过大，请重新创建任务');
   await db.query('INSERT INTO summary_source_batches(job_id,ordinal,messages,digest) VALUES($1,$2,$3,$4)',[id,body.ordinal,serialized,hash]);
   await db.query("UPDATE summary_jobs SET progress=progress||$2::jsonb,lease_until=now()+interval '2 minutes' WHERE id=$1",[id,JSON.stringify({phase:'reading',read_count:count,read_characters:chars,source_bytes:size,completed_batches:body.read_batches})]);
  });res.json({ok:true});
 });
 app.post('/api/runtime/summaries/jobs/:id/source-complete',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),body=z.object({token:z.uuid(),batches:z.number().int().min(1).max(20000),read_batches:z.number().int().min(1).max(20000)}).parse(req.body);
  await transaction(async db=>{
   const previous=(await db.query('SELECT * FROM summary_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
   requireCondition(previous,404,'任务不存在');await authorize(req,previous.group_id,db);await valid(previous,db);
   if(previous.source_token===body.token&&['queued','generating','preview','delivery_ready','delivering','sent'].includes(previous.status))return;
   const job=await reading(db,id,body.token,req,authorize),plan=job.source?.plan;
   requireCondition(plan,409,'缺少取数计划');
   const batches=(await db.query('SELECT ordinal,messages FROM summary_source_batches WHERE job_id=$1 ORDER BY ordinal',[id])).rows;
   requireCondition(batches.length===body.batches&&batches.every((b,i)=>b.ordinal===i),400,'取数批次不完整');
   const messages=batches.flatMap(b=>b.messages) as z.infer<typeof sourceMessage>[];validateMessages(messages,job);
   requireCondition(messages.length===plan.count&&messages.reduce((n,m)=>n+characters(m.text),0)===plan.text_chars,400,'取数统计不一致，请重新创建任务');
   messages.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.seq-b.seq);
   const fetchedAt=new Date().toISOString();
   const cacheStored=await saveReaderSource(db,job,messages,fetchedAt,plan);
   await db.query("UPDATE summary_jobs SET source=$2,status='queued',lease_until=NULL,progress=progress||$3::jsonb WHERE id=$1",[id,JSON.stringify({messages,stats:sourceStats(messages),origin:'wechat-database-chatlog-keeper',fetched_at:fetchedAt}),JSON.stringify({phase:'queued',read_count:messages.length,completed_batches:body.read_batches,cache_stored:cacheStored})]);
   await db.query('DELETE FROM summary_source_batches WHERE job_id=$1',[id]);
  });res.json({ok:true});
 });
}
