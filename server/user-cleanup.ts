import type express from 'express';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {legacyBotId} from './bot-context.js';
import {sqlIdentifier} from './bot-provisioning.js';
import {superAdmin} from './user-access.js';
import {digest,requireCondition} from './security.js';
import {deletionReason,reasonFields,reasonDetails,type DeletionReason} from '../shared/deletion.js';

type Item={kind:'bot'|'key';id:string;name:string;eligible:boolean;message:string};
const present=async(path:string)=>{try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
async function botPath(b:any){
 const ns=b.id.replaceAll('-','');
 requireCondition(b.id!==legacyBotId&&/^[a-f0-9]{32}$/.test(ns)&&b.data_namespace===ns&&b.db_name==='gdb_'+ns&&b.db_role==='gdr_'+ns,409,'存储绑定不符合独立机器人规范，需人工核对');
 const base=resolve(process.env.DATA_DIR||'data'),parent=join(base,'bots'),path=join(parent,ns);
 for(const p of [base,parent,path]){const st=await present(p);requireCondition(!st||st.isDirectory()&&!st.isSymbolicLink(),409,'资料目录不是可信独立目录，需人工核对');if(st)requireCondition(await realpath(p)===p,409,'资料目录存在路径跳转，需人工核对');}
 return path;
}
async function business<T>(name:string,fn:(db:pg.Client)=>Promise<T>){
 const url=new URL(process.env.DATABASE_URL!);url.pathname='/'+name;
 const db=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000,statement_timeout:10000});
 try{await db.connect();return await fn(db);}finally{await db.end();}
}
async function botEligible(b:any,user:string,resuming=false):Promise<string>{
 if(!b.deleted_at||b.owner_user_id!==user)return '机器人未删除或已不属于此账号';
 if(b.storage_purged_at)return '独立业务库与资料目录已清理';
 if(b.id===legacyBotId||b.database_state==='legacy')return '原始兼容业务空间与站点控制库共用，保留并需人工处理';
 if(!['ready','failed'].includes(b.database_state))return '业务空间尚未稳定，需人工核对';
 try{await botPath(b);}catch(e){return (e as Error).message;}
 if((await controlPool.query("SELECT 1 FROM managed_model_usage WHERE bot_id=$1 AND status='reserved' LIMIT 1",[b.id])).rowCount)return '仍有模型调用等待完成或计量';
 if((await controlPool.query('SELECT 1 FROM managed_bot_adapters WHERE bot_id=$1',[b.id])).rowCount)return '仍存在接入凭据，需先撤销';
 const database=(await controlPool.query('SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=$1',[b.db_name])).rows[0];
 if(!database)return resuming?'':'数据库缺失，尚无已确认的清理进度；保留文件供人工核对';
 if(database.owner!==b.db_role)return '数据库所有人不匹配，保留供人工核对';
 const role=(await controlPool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1',[b.db_role])).rows[0];
 if(!role||Object.values(role).some(Boolean))return '数据库角色不符合受限角色规范，保留供人工核对';
 try{return await business(b.db_name,async db=>{
  for(const table of ['topics','personas'])if((await db.query('SELECT 1 FROM '+table+" WHERE visibility<>'private' OR (created_by_user_id IS NOT NULL AND created_by_user_id<>$1) LIMIT 1",[user])).rowCount)return '包含共享内容或其他用户创建的资源，整套业务空间保留';
  if((await db.query('SELECT 1 FROM groups WHERE created_by_user_id IS NOT NULL AND created_by_user_id<>$1 LIMIT 1',[user])).rowCount)return '包含其他用户创建的群配置，整套业务空间保留';
  for(const [table,condition] of [['documents',"status='processing'"],['persona_jobs',"status='processing'"],['conversation_jobs',"status='processing'"],['interaction_templates',"status='processing'"],['summary_jobs',"status IN ('reading','generating','delivering')"],['group_onboarding_jobs',"status='working'"]])if((await db.query('SELECT 1 FROM '+table+' WHERE '+condition+' LIMIT 1')).rowCount)return '业务空间仍有后台处理任务，保留至任务结束';
  return '';
 });}catch{return '业务空间无法完整核验，保留供人工核对';}
}
async function keyEligible(k:any,user:string){
 if(k.owner_user_id!==user)return 'Key 已不属于此账号';
 if(k.secret_purged_at)return '密文已清理，仅保留尾号与账本';
 if(k.scope!=='private')return '站点公用 Key 单独保留，不随私人账号清理';
 if(!k.archived||k.enabled)return 'Key 尚未停用归档';
 if((await controlPool.query("SELECT 1 FROM managed_model_usage WHERE key_id=$1 AND status='reserved' LIMIT 1",[k.id])).rowCount)return '仍有模型调用等待计量';
 if((await controlPool.query('SELECT 1 FROM managed_model_grants WHERE key_id=$1 AND user_id<>$2 AND enabled AND expires_at>now() LIMIT 1',[k.id,user])).rowCount)return '仍有其他用户授权，保留供人工核对';
 return '';
}
async function itemsFor(user:string):Promise<Item[]>{
 const items:Item[]=[];
 for(const b of (await controlPool.query('SELECT * FROM managed_bots WHERE owner_user_id=$1 ORDER BY id',[user])).rows){const previous=(await controlPool.query("SELECT phase FROM managed_deletion_cleanup_items i JOIN managed_deletion_cleanups j ON j.id=i.cleanup_id WHERE j.user_id=$1 AND i.kind='bot' AND i.target_id=$2 AND i.state IN ('pending','failed')",[user,b.id])).rows[0];const message=await botEligible(b,user,!!previous&&previous.phase!=='planned');items.push({kind:'bot',id:b.id,name:b.name,eligible:!message,message:message||'清除独立业务数据库、数据库角色及本机器人资料目录'});}
 for(const k of (await controlPool.query('SELECT * FROM managed_model_keys WHERE owner_user_id=$1 ORDER BY id',[user])).rows){const message=await keyEligible(k,user);items.push({kind:'key',id:k.id,name:k.name,eligible:!message,message:message||'清除私有 Key 密文，保留尾号、所有人、价格与用量账本'});}
 return items;
}
export async function cleanupPreview(id:string){
 const user=(await controlPool.query('SELECT id,username,github_login,display_name,revision,deleted_at FROM admins WHERE id=$1',[id])).rows[0];requireCondition(user,404,'账号不存在');
 const job=(await controlPool.query('SELECT id,status,error,updated_at FROM managed_deletion_cleanups WHERE user_id=$1',[id])).rows[0]||null;
 const items=await itemsFor(id),eligible=items.filter(i=>i.eligible),reasons:string[]=[];
 if(!user.deleted_at)reasons.push('请先删除站点账号，并处理其名下机器人及 Key。');
 if(job&&['queued','processing'].includes(job.status))reasons.push('清理任务已提交，请手动刷新查看结果；不会重复创建任务。');
 if(!eligible.length)reasons.push('目前没有可自动清理的独占数据；已清理或需要保留的项目见下方。');
 return {kind:'user',id,revision:user.revision,name:user.display_name||user.github_login||user.username,confirmation:user.github_login||user.username,scope:'彻底清理仅作用于已删除账号的独占资料',can_delete:!reasons.length,reasons,counts:{cleanup_bots:eligible.filter(i=>i.kind==='bot').length,cleanup_keys:eligible.filter(i=>i.kind==='key').length,retained:items.length-eligible.length},effects:[
 '执行后不能从界面恢复：清除已删除、独立且核验通过的机器人业务库和资料文件，清除符合条件的私有 Key 密文。',
 '真实 API 账单、尾号、删除原因和必要审计仍留存；账号保留精简历史记录，不重新取得登录能力。',
 '共享内容、其他用户资源、公用 Key、原始共用业务空间或无法核验的项目保留，并列出原因。',
 '微信登录目录、Docker及现有运维备份单独管理，本次不删除；资料中的原有独立副本不受影响。'],items,job,plan_hash:digest(JSON.stringify({id,revision:user.revision,items}))};
}
export async function requestCleanup(id:string,revision:number,confirmation:string,planHash:string,actorId:string,why:DeletionReason){
 why=deletionReason.parse(why);
 return controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  const actor=(await db.query("SELECT username FROM admins WHERE deleted_at IS NULL AND id=$1 AND role='super_admin' AND status='active' FOR SHARE",[actorId])).rows[0];requireCondition(actor,403,'仅有效总管理员可以清理');
  const p=await cleanupPreview(id);requireCondition(p.revision===revision&&p.plan_hash===planHash,409,'账号或清理范围已变化，请重新预览');requireCondition(p.confirmation===confirmation,400,'请完整输入账号确认');requireCondition(p.can_delete,409,p.reasons.join(' '));
  const job=(await db.query("INSERT INTO managed_deletion_cleanups(id,user_id,actor_user_id,status,reason,reason_note) VALUES($1,$2,$3,'queued',$4,$5) ON CONFLICT(user_id) DO UPDATE SET actor_user_id=excluded.actor_user_id,status='queued',reason=excluded.reason,reason_note=excluded.reason_note,revision=managed_deletion_cleanups.revision+1,error=NULL,updated_at=now(),finished_at=NULL RETURNING id",[randomUUID(),id,actorId,why.reason,why.reason_note])).rows[0];
  for(const i of p.items)await db.query("INSERT INTO managed_deletion_cleanup_items(cleanup_id,kind,target_id,name,state,message) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cleanup_id,kind,target_id) DO UPDATE SET state=CASE WHEN managed_deletion_cleanup_items.state='done' THEN 'done' ELSE excluded.state END,message=excluded.message,updated_at=now()",[job.id,i.kind,i.id,i.name,i.eligible?'pending':'skipped',i.message]);
  await audit(actor.username,'user.cleanup_requested',id,{...reasonDetails(why),target_name:p.name,cleanup_id:job.id,counts:p.counts},db);return job.id;
 });
}
async function retainDeletionHistory(b:any,db:pg.PoolClient){
 await business(b.db_name,async source=>{
  const rows=(await source.query("SELECT id,actor,action,target,details,created_at FROM audit_logs WHERE action='group.configuration_deleted' ORDER BY id")).rows;
  for(const row of rows)await db.query("INSERT INTO audit_logs(actor,action,target,details,created_at) SELECT $1,'cleanup.retained_group_deletion',$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='cleanup.retained_group_deletion' AND details->>'bot_id'=$5 AND details->>'source_event_id'=$6)",[String(row.actor).slice(0,200),row.target,{bot_id:b.id,source_event_id:String(row.id),reason:row.details.reason||null,reason_label:row.details.reason_label||'历史未填写',reason_note:String(row.details.reason_note||'').slice(0,500),target_name:String(row.details.target_name||'').slice(0,120)},row.created_at,b.id,String(row.id)]);
 });
}
async function clearBot(item:any,job:any,db:pg.PoolClient){
 const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1',[item.target_id])).rows[0];requireCondition(b,409,'机器人记录缺失');
 const message=await botEligible(b,job.user_id,item.phase!=='planned');
 if(message)return {state:b.storage_purged_at?'done':'skipped',message};
 const path=await botPath(b);
 const exists=(await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[b.db_name])).rowCount;
 if(exists){
  await retainDeletionHistory(b,db);
  await db.query("UPDATE managed_deletion_cleanup_items SET phase='authorized',updated_at=now() WHERE cleanup_id=$1 AND kind='bot' AND target_id=$2",[job.id,b.id]);
  await db.query('DROP DATABASE '+sqlIdentifier(b.db_name)+' WITH (FORCE)');
 }
 await db.query("UPDATE managed_deletion_cleanup_items SET phase='database_removed',updated_at=now() WHERE cleanup_id=$1 AND kind='bot' AND target_id=$2",[job.id,b.id]);
 // Only a validated DATA_DIR/bots/<exact UUID> directory can reach rm.
 await botPath(b);await rm(path,{recursive:true,force:true});
 await db.query("UPDATE managed_deletion_cleanup_items SET phase='files_removed',updated_at=now() WHERE cleanup_id=$1 AND kind='bot' AND target_id=$2",[job.id,b.id]);
 await db.query('DROP ROLE IF EXISTS '+sqlIdentifier(b.db_role));
 await db.query('UPDATE managed_bots SET storage_purged_at=now(),db_password_ciphertext=NULL,model_key_ciphertext=NULL,notes=\'\',runtime_status=\'{}\',runtime_instance_id=NULL,account_fingerprint=NULL,runtime_seen_at=NULL,error=NULL WHERE id=$1 AND deleted_at IS NOT NULL',[b.id]);
 return {state:'done',message:'独立业务库、数据库角色和资料文件已清理；计费与删除审计保留'};
}
async function clearKey(item:any,job:any,db:pg.PoolClient){
 await db.query('BEGIN');
 try{
  const k=(await db.query('SELECT * FROM managed_model_keys WHERE id=$1 FOR UPDATE',[item.target_id])).rows[0];requireCondition(k,409,'Key记录缺失');const message=await keyEligible(k,job.user_id);
  if(message){await db.query('COMMIT');return {state:k.secret_purged_at?'done':'skipped',message};}
  await db.query("UPDATE managed_model_keys SET secret_ciphertext='erased:v1',key_digest='erased:'||id::text,secret_purged_at=now(),enabled=false,archived=true,revision=revision+1 WHERE id=$1",[k.id]);
  await db.query('COMMIT');return {state:'done',message:'私有 Key 密文已清除，仅保留尾号及计费记录'};
 }catch(e){await db.query('ROLLBACK');throw e;}
}
// Called by the existing worker outside business workspace iteration. A session
// lock covers nontransactional DROP DATABASE/files, and phases allow crash retry.
export async function processDeletionCleanup(){
 if(!(await controlPool.query("SELECT 1 FROM managed_deletion_cleanups WHERE status IN ('queued','processing') LIMIT 1")).rowCount)return false;
 const db=await controlPool.connect();let locked=false;
 try{
  locked=(await db.query('SELECT pg_try_advisory_lock(78511967) acquired')).rows[0].acquired;if(!locked)return false;
  const job=(await db.query("SELECT * FROM managed_deletion_cleanups WHERE status IN ('queued','processing') ORDER BY created_at,id LIMIT 1")).rows[0];if(!job)return false;
  const actor=(await db.query("SELECT username FROM admins WHERE deleted_at IS NULL AND id=$1 AND role='super_admin' AND status='active'",[job.actor_user_id])).rows[0],user=(await db.query('SELECT deleted_at FROM admins WHERE id=$1',[job.user_id])).rows[0];
  if(!actor||!user?.deleted_at){await db.query("UPDATE managed_deletion_cleanups SET status='failed',error='账号状态或发起管理员权限已变化，请重新确认',updated_at=now() WHERE id=$1",[job.id]);return true;}
  await db.query("UPDATE managed_deletion_cleanups SET status='processing',error=NULL,updated_at=now() WHERE id=$1",[job.id]);
  for(const item of (await db.query("SELECT * FROM managed_deletion_cleanup_items WHERE cleanup_id=$1 AND state IN ('pending','failed') ORDER BY kind,target_id",[job.id])).rows){
   let result;try{result=item.kind==='bot'?await clearBot(item,job,db):await clearKey(item,job,db);}catch{result={state:'failed',message:'清理未完成，已保留进度；请管理员核对存储和权限后重试'};}
   await db.query('UPDATE managed_deletion_cleanup_items SET state=$4,message=$5,updated_at=now() WHERE cleanup_id=$1 AND kind=$2 AND target_id=$3',[job.id,item.kind,item.target_id,result.state,result.message]);
   await audit(actor.username,'user.cleanup_item',item.target_id,{...reasonDetails({reason:job.reason,reason_note:job.reason_note} as DeletionReason),user_id:job.user_id,cleanup_id:job.id,kind:item.kind,target_name:item.name,...result},db);
  }
  const states=(await db.query('SELECT state FROM managed_deletion_cleanup_items WHERE cleanup_id=$1',[job.id])).rows.map(i=>i.state),status=states.includes('failed')?'failed':states.includes('skipped')?'partial':'completed';
  await db.query('UPDATE managed_deletion_cleanups SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1',[job.id,status]);
  await audit(actor.username,'user.cleanup_finished',job.user_id,{...reasonDetails({reason:job.reason,reason_note:job.reason_note} as DeletionReason),cleanup_id:job.id,status},db);return true;
 }finally{if(locked)await db.query('SELECT pg_advisory_unlock(78511967)');db.release();}
}
export function registerUserCleanup(app:express.Express){
 app.get('/api/users/deleted',async(req,res)=>{superAdmin(req.admin!);const users=(await controlPool.query('SELECT a.id,a.username,a.github_login,a.display_name,a.deleted_at,a.deleted_by,a.deletion_reason,a.deletion_note,j.id cleanup_id,j.status cleanup_status,j.error cleanup_error,j.updated_at cleanup_updated_at FROM admins a LEFT JOIN managed_deletion_cleanups j ON j.user_id=a.id WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC,a.id LIMIT 100')).rows;for(const u of users)u.cleanup_items=u.cleanup_id?(await controlPool.query('SELECT kind,target_id,name,state,phase,message FROM managed_deletion_cleanup_items WHERE cleanup_id=$1 ORDER BY kind,target_id',[u.cleanup_id])).rows:[];res.json({users,limit:100});});
 app.get('/api/users/deletion-history',async(req,res)=>{superAdmin(req.admin!);res.json({logs:(await controlPool.query("SELECT id,actor,action,target,details,created_at FROM audit_logs WHERE action IN ('user.account_deleted','bot.registration_deleted','group.configuration_deleted','user.cleanup_requested','user.cleanup_finished','cleanup.retained_group_deletion') ORDER BY created_at DESC,id DESC LIMIT 150")).rows,limit:150});});
 app.get('/api/users/:id/cleanup/preview',async(req,res)=>{superAdmin(req.admin!);res.json(await cleanupPreview(z.uuid().parse(req.params.id)));});
 app.post('/api/users/:id/cleanup',async(req,res)=>{superAdmin(req.admin!);const b=z.object({revision:z.number().int().positive(),confirmation:z.string().min(1).max(120),plan_hash:z.string().regex(/^[a-f0-9]{64}$/),...reasonFields}).strict().refine(v=>v.reason!=='other'||!!v.reason_note,'选择其他时请补充原因').parse(req.body);res.status(202).json({id:await requestCleanup(z.uuid().parse(req.params.id),b.revision,b.confirmation,b.plan_hash,req.admin!.id,b),status:'queued'});});
}
