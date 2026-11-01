import {randomUUID} from 'node:crypto';
import {pool,transaction,audit} from '../db.js';
import {requireCondition,HttpError} from '../security.js';
import {effectivePolicy} from '../policies.js';
import {effectiveModelRoutes,validateSelection} from '../models.js';
import {summaryConfig,summaryDefaults,resolveWindow,nextOccurrence} from '../../shared/summaries.js';
export type Db=Pick<typeof pool,'query'>;
export async function settings(groupId:string,db:Db=pool){const s=(await db.query('SELECT * FROM summary_settings WHERE group_id=$1',[groupId])).rows[0];return s||{group_id:groupId,revision:0,config:summaryDefaults(),last_adapter_seen:null};}
export async function group(groupId:string,db:Db=pool){const g=(await db.query('SELECT * FROM groups WHERE id=$1',[groupId])).rows[0];requireCondition(g,404,'群不存在');g.policy=effectivePolicy(g);return g;}
export function language(g:any,c:any){const l=g.policy.language;return c.language==='group'?(l.mode==='fixed'?l.fixed:l.fallback)||'zh-CN':c.language;}
export async function validateConfig(g:any,c:any,db:Db=pool){
 const l=g.policy.language,lang=language(g,c);
 requireCondition(l.mode==='follow'||(l.mode==='fixed'?lang===(l.fixed||l.fallback):l.allowed.includes(lang)),400,'总结语言需符合本群语言范围');
 requireCondition((await db.query('SELECT 1 FROM summary_templates WHERE slug=$1',[c.template])).rowCount,400,'请选择总结模板');
 if(c.model_route.mode==='custom')await validateSelection(c.model_route,'text',db);
}
export async function route(g:any,c:any,db:Db=pool){return (await effectiveModelRoutes({model_routes:c.model_route.mode==='inherit'?g.model_routes:{text:c.model_route,image:{mode:'disabled'}}},db)).text as any;}
export async function valid(job:any,db:Db=pool,send=false){const g=await group(job.group_id,db),s=await settings(g.id,db);requireCondition(g.enabled&&g.external_id===job.external_id&&g.revision===job.group_revision&&s.revision===job.settings_revision,409,'群或总结配置已变化，请重新创建任务');if(send)requireCondition(s.config.enabled,409,'本群总结发布已停用');return {g,s};}
export async function enqueue(db:Db,groupId:string,window:unknown,publish:boolean,requestId:string,now=Date.now(),scheduleId:string|null=null,occurrence:string|null=null){
 await db.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE',[groupId]);
 const g=await group(groupId,db),s=await settings(groupId,db),c=summaryConfig.parse(s.config);
 requireCondition(g.enabled&&g.external_id,409,'请先启用群并连接机器人');if(publish)requireCondition(c.enabled,409,'请先保存并启用本群总结发布');
 await validateConfig(g,c,db);const r=await route(g,c,db);requireCondition(r.available,409,'本群总结模型不可用，请选择API Key和模型');
 const prior=(await db.query('SELECT id FROM summary_jobs WHERE request_id=$1',[requestId])).rows[0];if(prior)return prior.id;
 const usage=(await db.query("SELECT count(*)::int n,count(*) FILTER(WHERE wants_publish)::int publishes FROM summary_jobs WHERE group_id=$1 AND created_at>now()-interval '24 hours'",[g.id])).rows[0];
 requireCondition(usage.n<20&&(!publish||usage.publishes<10),429,'本群24小时总结额度已用完（生成20次、发群10次）');
 let bounds;try{bounds=resolveWindow(window,c.timezone,now);}catch(e){throw new HttpError(400,(e as Error).message);}
 const template=(await db.query('SELECT * FROM summary_templates WHERE slug=$1',[c.template])).rows[0],id=randomUUID();
 await db.query('INSERT INTO summary_jobs(id,group_id,external_id,group_revision,settings_revision,request_id,schedule_id,occurrence,wants_publish,window_start,window_end,config,template) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,g.id,g.external_id,g.revision,s.revision,requestId,scheduleId,occurrence,publish,bounds.start,bounds.end,{...c,language:language(g,c),resolved_route:r},template]);
 await audit('summary','summary.queued',id,{group_id:g.id,publish},db);return id;
}
export async function tick(now=Date.now()){
 await pool.query("UPDATE summary_jobs SET status=CASE WHEN status='delivering' THEN 'uncertain' ELSE 'failed' END,error=CASE WHEN status='delivering' THEN '发送确认中断，请核实群内消息，系统不会自动重发' ELSE '任务超时或被中断，请手动重新创建' END,source=NULL,finished_at=now() WHERE (status IN ('reading','generating','delivering') AND lease_until<now()) OR (status IN ('waiting_source','queued','delivery_ready') AND created_at<now()-interval '1 hour')");
 for(let i=0;i<20;i++){
  const worked=await transaction(async db=>{
   const s=(await db.query('SELECT * FROM summary_schedules WHERE enabled AND next_run<=$1 ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT 1',[new Date(now)])).rows[0];if(!s)return false;
   const setting=await settings(s.group_id,db),planned=new Date(s.next_run).getTime();
   await db.query('SAVEPOINT enqueue_summary');
   try{requireCondition(setting.config.enabled,409,'本群总结发布已停用');requireCondition(now-planned<3600000,409,'预约已错过超过一小时，请人工重新创建');await enqueue(db,s.group_id,s.config.window,true,randomUUID(),planned,s.id,new Date(planned).toISOString());}
   catch(e){await db.query('ROLLBACK TO SAVEPOINT enqueue_summary');await audit('scheduler','summary.schedule_skipped',s.id,{reason:e instanceof HttpError?e.message:'计划执行失败'},db);await db.query('UPDATE summary_schedules SET enabled=false,last_error=$2 WHERE id=$1',[s.id,e instanceof HttpError?e.message:'计划执行失败']);}
   const next=s.config.kind==='daily'?nextOccurrence(s.config,setting.config.timezone,now):s.next_run;
   await db.query('UPDATE summary_schedules SET enabled=CASE WHEN $2 THEN enabled ELSE false END,next_run=$3 WHERE id=$1',[s.id,s.config.kind==='daily',next]);return true;
  });if(!worked)break;
 }
}
