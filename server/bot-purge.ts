import type express from 'express';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {legacyBotId} from './bot-context.js';
import {botDeletionPreview,deleteBotRegistration,stopped} from './deletion.js';
import {botPath,botEligible,retainDeletionHistory,business} from './user-cleanup.js';
import {sqlIdentifier} from './bot-provisioning.js';
import {legacyDataPlan,clearLegacyRows,clearLegacyFiles} from './legacy-purge.js';
import {runtimePreview,queuePurgeRuntime} from './runtime-maintenance.js';
import {superAdmin} from './user-access.js';
import {digest,requireCondition,HttpError} from './security.js';
import {reasonFields,reasonDetails,purgePreviewChangedCode,type DeletionReason} from '../shared/deletion.js';
async function actor(id:string,db:Pick<typeof controlPool,'query'>=controlPool){const a=(await db.query("SELECT username FROM admins WHERE id=$1 AND role='super_admin' AND status='active' AND deleted_at IS NULL FOR SHARE",[id])).rows[0];requireCondition(a,403,'总管理员权限已变化');return a;}
const record=async(id:string)=>(await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[id])).rows[0];
async function businessConnectionHasRawKey(name:string){return business(name,async db=>!!(await db.query('SELECT 1 FROM model_credentials WHERE vault_key_id IS NULL LIMIT 1')).rowCount);}
export async function botPurgePreview(id:string){
 const b=await record(id);requireCondition(b,404,'机器人不存在');const blockers:string[]=[];
 if(!b.deleted_at){const p=await botDeletionPreview(id);blockers.push(...p.reasons);}else{requireCondition(b.state==='archived',409,'机器人状态异常');if((await controlPool.query('SELECT 1 FROM managed_bot_adapters WHERE bot_id=$1',[id])).rowCount)blockers.push('接入凭据尚未撤销');}
 if((await controlPool.query("SELECT 1 FROM managed_model_usage WHERE bot_id=$1 AND status='reserved'",[id])).rowCount)blockers.push('仍有模型请求等待计量');
 if((await controlPool.query('SELECT 1 FROM managed_bot_switch WHERE target_id=$1',[id])).rowCount)blockers.push('仍有待切换任务');
 const existing=(await controlPool.query('SELECT * FROM managed_bot_purges WHERE bot_id=$1',[id])).rows[0];if(existing&&['queued','processing'].includes(existing.status))blockers.push('已有彻底清理任务，请手动刷新进度');
 let business:any=null;
 if(b.storage_purged_at)business={eligible:false,blockers:['业务资料已完成清理'],bytes:0,file_bytes:0};
 else if(id===legacyBotId){business=await legacyDataPlan(b.owner_user_id);const database=(await controlPool.query('SELECT current_database() name')).rows[0].name;if(b.database_state!=='legacy'||b.db_name!==database||b.db_role!=='gdr_'+legacyBotId.replaceAll('-','')){business.eligible=false;business.blockers.push('旧共用库绑定异常，保留待核对');}}
 else{let message=await botEligible({...b,deleted_at:b.deleted_at||new Date()},b.owner_user_id);if(!message&&await businessConnectionHasRawKey(b.db_name))message='API凭据尚未迁移到独立Key管理，业务资料保留';business={kind:'independent',eligible:!message,blockers:message?[message]:[],binding:{database:b.db_name,role:b.db_role,namespace:b.data_namespace},bytes:null,file_bytes:null};}
 let runtime:any=null,runtime_error='';
 try{const p=await runtimePreview(id,'rococo-root2');const independentBlockers=p.blockers.filter((s:string)=>!s.includes('仅已删除登记'));const selections=[...new Set(p.inventory.resources.filter((r:any)=>r.present&&!r.blocked.length).map((r:any)=>r.kind))] as string[];
  if(selections.includes('deployment')&&!selections.includes('containers'))selections.splice(selections.indexOf('deployment'),1);
  runtime={plan_hash:p.plan_hash,eligible:!independentBlockers.length&&!p.inventory.quarantine&&selections.length>0,blockers:independentBlockers,selection:selections,inventory:p.inventory};if(p.inventory.quarantine)runtime.blockers.push('存在此前暂存，请先在运行环境与备份中完成还原或清理');
 }catch(e){runtime_error=(e as Error).message;}
 const plan={business,runtime};const fingerprint=digest(JSON.stringify({id,revision:b.revision,owner:b.owner_user_id,business,runtime:runtime?{hash:runtime.plan_hash,selection:runtime.selection,eligible:runtime.eligible}:null}));
 return {id,name:b.name,confirmation:b.wechat_id,revision:b.revision,deleted:!!b.deleted_at,legacy:id===legacyBotId,can_submit:!blockers.length&&(business.eligible||runtime?.eligible),blockers,plan,plan_hash:fingerprint,runtime_error,job:existing?{id:existing.id,status:existing.status,phase:existing.phase,receipt:existing.receipt,error:existing.error}:null,
  retained:['站点用户、GitHub登录、站点主密钥和控制库','所有用户持有的API Key、公用授权及真实用量账本','Tatsumi及其他机器人、共享资源、必要删除审计','现有备份、共享镜像、被其他容器引用的部署目录及未登记文件'],
  effects:['这是永久物理清理，不能从界面恢复；未删除的登记会先撤销接入并移出正常列表。','只处理下方勾选的范围。未通过核验的内容保留并说明原因；不会为清理扩大范围。','运行环境先停止并临时隔离，再按本次明确授权永久删除；中途失败保留进度，不是到期自动删除。','旧共用库仅清空明确业务表与登记文件，绝不删除整个数据库或站点资料根目录。']};
}
export async function requestBotPurge(id:string,input:{revision:number;confirmation:string;plan_hash:string;business:boolean;runtime:boolean;reason:string;reason_note:string},actorId:string){
 const a=await actor(actorId),p=await botPurgePreview(id);if(p.revision!==input.revision||p.plan_hash!==input.plan_hash)throw new HttpError(409,'清理范围已变化，请重新预览',purgePreviewChangedCode);requireCondition(p.can_submit,409,p.blockers.join(' ')||'没有可清理范围');requireCondition(p.confirmation===input.confirmation,400,'请完整输入微信号确认');
 requireCondition(input.business||input.runtime,400,'请勾选清理范围');requireCondition(!input.business||p.plan.business.eligible,409,'业务数据须保留');requireCondition(!input.runtime||p.plan.runtime?.eligible,409,'运行环境尚未通过核验');
 if(!p.deleted)await deleteBotRegistration(id,p.revision,p.confirmation,a.username,input as DeletionReason);
 return controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');await actor(actorId,db);const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!b||!b.deleted_at||!b.owner_user_id||b.revision!==p.revision+(p.deleted?0:1))throw new HttpError(409,'登记状态已变化，请在已删除机器人中重新预览',purgePreviewChangedCode);
  const prior=(await db.query('SELECT id,status FROM managed_bot_purges WHERE bot_id=$1',[id])).rows[0];requireCondition(!prior||!['queued','processing'].includes(prior.status),409,'已有彻底清理任务');
  if(input.business&&id===legacyBotId){const fresh=await legacyDataPlan(b.owner_user_id,db);if(!fresh.eligible||fresh.fingerprint!==p.plan.business.fingerprint)throw new HttpError(409,'旧业务范围已变化，请重新预览',purgePreviewChangedCode);}
  const job=randomUUID(),plan={business:input.business?p.plan.business:null,runtime:input.runtime?p.plan.runtime:null};
  // Failed jobs with irreversible progress resume the original job, never replace its manifest.
  requireCondition(!prior||prior.status==='completed'||prior.status==='partial'||prior.status==='cancelled',409,'请先重试或核对原失败任务，不能覆盖已执行进度');
  if(prior)await db.query('DELETE FROM managed_bot_purges WHERE id=$1',[prior.id]);
  await db.query("INSERT INTO managed_bot_purges(id,bot_id,actor_user_id,status,reason,reason_note,expected_revision,expected_owner,plan) VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8)",[job,id,actorId,input.reason,input.reason_note,b.revision,b.owner_user_id,plan]);await audit(a.username,'bot.purge_requested',id,{...reasonDetails(input as DeletionReason),target_name:b.name,job_id:job,business:input.business,runtime:input.runtime},db);return job;
 });
}
export async function processBotPurge(){
 if(!(await controlPool.query("SELECT 1 FROM managed_bot_purges WHERE status IN ('queued','processing') LIMIT 1")).rowCount)return false;
 const db=await controlPool.connect();let locked=false;
 try{locked=(await db.query('SELECT pg_try_advisory_lock(78511967) acquired')).rows[0].acquired;if(!locked)return false;
 const j=(await db.query("SELECT * FROM managed_bot_purges WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1")).rows[0];if(!j)return false;
 try{
  const a=await actor(j.actor_user_id,db),b=await record(j.bot_id);requireCondition(b?.deleted_at&&b.state==='archived'&&b.revision===j.expected_revision&&b.owner_user_id===j.expected_owner,409,'登记或所有人已变化');
  requireCondition(!(await db.query("SELECT 1 FROM managed_model_usage WHERE bot_id=$1 AND status='reserved'",[b.id])).rowCount&&!(await db.query('SELECT 1 FROM managed_bot_adapters WHERE bot_id=$1',[b.id])).rowCount,409,'仍有接入凭据或在途调用');
  await db.query("UPDATE managed_bot_purges SET status='processing',updated_at=now() WHERE id=$1",[j.id]);
  const phase=async(s:string,receipt?:object)=>{j.phase=s;await db.query('UPDATE managed_bot_purges SET phase=$2,receipt=receipt||$3::jsonb,updated_at=now() WHERE id=$1',[j.id,s,JSON.stringify(receipt||{})]);};
  if(j.plan.runtime){
   if(!j.runtime_quarantine_id){const id=await queuePurgeRuntime(b.id,'quarantine',j.plan.runtime.selection,j.actor_user_id,j,j.plan.runtime.plan_hash,undefined,j.id);await db.query('UPDATE managed_bot_purges SET runtime_quarantine_id=$2 WHERE id=$1',[j.id,id]);return true;}
   const q=(await db.query('SELECT * FROM managed_runtime_jobs WHERE id=$1',[j.runtime_quarantine_id])).rows[0];requireCondition(q&&!['failed','cancelled'].includes(q.status),409,'运行环境暂存未完成，请核对原任务');if(q.status!=='completed')return false;
   if(j.phase==='planned')await phase('runtime_stopped',{runtime:'旧运行环境已停止并暂存，等待永久清理'});
  }
  if(j.plan.business&&!['files_removed','business_done'].includes(j.phase)&&!b.storage_purged_at){
   if(b.id===legacyBotId){
    requireCondition(b.database_state==='legacy'&&b.db_role==='gdr_'+legacyBotId.replaceAll('-','')&&b.db_name===(await db.query('SELECT current_database() name')).rows[0].name,409,'旧共用库绑定异常，未清理');
    if(!['database_removed'].includes(j.phase)){
     // Table truncation and its phase marker commit atomically, so retries cannot clear new data.
     await clearLegacyRows(db,j.plan.business,b.owner_user_id,j.id);
     await phase('database_removed',{business:'旧业务表已清空；控制库、Key和审计保留'});
    }
    const bytes=await clearLegacyFiles(j.plan.business.files);await phase('files_removed',{file_bytes_removed:bytes});
    await db.query('UPDATE managed_bots SET storage_purged_at=now(),db_password_ciphertext=NULL WHERE id=$1',[b.id]);
   }else{
    const message=await botEligible(b,b.owner_user_id,j.phase==='authorized'||j.phase==='database_removed');requireCondition(!message,409,message);const path=await botPath(b);
    if((await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[b.db_name])).rowCount){requireCondition(!await businessConnectionHasRawKey(b.db_name),409,'尚有未迁移的API凭据，保留业务资料');await retainDeletionHistory(b,db);await phase('authorized');await db.query('DROP DATABASE '+sqlIdentifier(b.db_name)+' WITH(FORCE)');}
    await phase('database_removed');await botPath(b);await rm(path,{recursive:true,force:true});await phase('files_removed');await db.query('DROP ROLE IF EXISTS '+sqlIdentifier(b.db_role));await db.query('UPDATE managed_bots SET storage_purged_at=now(),db_password_ciphertext=NULL,model_key_ciphertext=NULL WHERE id=$1',[b.id]);
   }
   await phase('business_done',{business:'独占业务数据及登记资料文件清理完成'});
  }
  if(j.plan.runtime){
   if(!j.runtime_purge_id){const id=await queuePurgeRuntime(b.id,'purge',j.plan.runtime.selection,j.actor_user_id,j,undefined,j.runtime_quarantine_id,j.id);await db.query('UPDATE managed_bot_purges SET runtime_purge_id=$2 WHERE id=$1',[j.id,id]);return true;}
   const r=(await db.query('SELECT * FROM managed_runtime_jobs WHERE id=$1',[j.runtime_purge_id])).rows[0];requireCondition(r&&!['failed','cancelled'].includes(r.status),409,'运行环境永久清理未完成，请核对原任务');if(r.status!=='completed')return false;await phase('finished',{runtime:r.receipt});
  }
  await db.query("UPDATE managed_bot_purges SET status='completed',error=NULL,finished_at=now(),updated_at=now() WHERE id=$1",[j.id]);await audit(a.username,'bot.purge_completed',b.id,{job_id:j.id,target_name:b.name,...reasonDetails(j)},db);return true;
 }catch(e){await db.query("UPDATE managed_bot_purges SET status='failed',error=$2,updated_at=now() WHERE id=$1",[j.id,(e as Error).message.slice(0,500)]);return true;}
 }finally{if(locked)await db.query('SELECT pg_advisory_unlock(78511967)');db.release();}
}
export function registerBotPurge(app:express.Express){
 app.get('/api/bots/deleted',async(req,res)=>{superAdmin(req.admin!);res.json({bots:(await controlPool.query('SELECT b.id,b.name,b.wechat_id,b.revision,b.deleted_at,b.deleted_by,b.deletion_reason,b.deletion_note,b.storage_purged_at,j.id job_id,j.status,j.phase,j.receipt,j.error FROM managed_bots b LEFT JOIN managed_bot_purges j ON j.bot_id=b.id WHERE b.deleted_at IS NOT NULL ORDER BY b.deleted_at DESC LIMIT 100')).rows});});
 app.get('/api/bots/:id/purge/preview',async(req,res)=>{superAdmin(req.admin!);res.json(await botPurgePreview(z.uuid().parse(req.params.id)));});
 app.post('/api/bots/:id/purge',async(req,res)=>{superAdmin(req.admin!);const body=z.object({revision:z.number().int().positive(),confirmation:z.string().min(1).max(120),plan_hash:z.string().regex(/^[a-f0-9]{64}$/),business:z.boolean(),runtime:z.boolean(),permanent_confirm:z.literal(true),...reasonFields}).strict().refine(v=>v.reason!=='other'||!!v.reason_note,'其他原因需填写说明').parse(req.body);res.status(202).json({id:await requestBotPurge(z.uuid().parse(req.params.id),body,req.admin!.id),status:'queued'});});
 app.post('/api/bots/:id/purge/cancel',async(req,res)=>{superAdmin(req.admin!);await controlTransaction(async db=>{await actor(req.admin!.id,db);const j=(await db.query("SELECT * FROM managed_bot_purges WHERE bot_id=$1 AND status='failed' FOR UPDATE",[z.uuid().parse(req.params.id)])).rows[0];requireCondition(j&&['planned','runtime_stopped'].includes(j.phase),409,'业务清理已经开始，只能保留原进度核对重试');requireCondition(!(await db.query("SELECT 1 FROM managed_runtime_jobs WHERE id=ANY($1::uuid[]) AND status IN ('queued','preparing','executing')",[[j.runtime_quarantine_id,j.runtime_purge_id].filter(Boolean)])).rowCount,409,'主机任务仍在途，请先处理原主机任务');await db.query("UPDATE managed_bot_purges SET status='cancelled',updated_at=now(),finished_at=now() WHERE id=$1",[j.id]);await audit(req.admin!.username,'bot.purge_cancelled',j.bot_id,{job_id:j.id,phase:j.phase,reason:j.reason,reason_note:j.reason_note,error:j.error},db);});res.json({ok:true});});
 app.post('/api/bots/:id/purge/retry',async(req,res)=>{superAdmin(req.admin!);await controlTransaction(async db=>{await actor(req.admin!.id,db);const j=(await db.query("SELECT * FROM managed_bot_purges WHERE bot_id=$1 AND status='failed' FOR UPDATE",[z.uuid().parse(req.params.id)])).rows[0];requireCondition(j,409,'没有可重试的任务');requireCondition(!j.runtime_quarantine_id||!(await db.query("SELECT 1 FROM managed_runtime_jobs WHERE id=ANY($1::uuid[]) AND status IN ('failed','cancelled')",[[j.runtime_quarantine_id,j.runtime_purge_id].filter(Boolean)])).rowCount,409,'请先在运行环境与备份中核对并重试原主机任务');await db.query("UPDATE managed_bot_purges SET status='queued',actor_user_id=$2,error=NULL,updated_at=now() WHERE id=$1",[j.id,req.admin!.id]);await audit(req.admin!.username,'bot.purge_retry',j.bot_id,{job_id:j.id},db);});res.json({ok:true});});
}
