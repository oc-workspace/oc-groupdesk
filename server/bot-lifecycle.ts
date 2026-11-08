import type {SessionUser} from '../shared/user-permissions.js';
import {controlPool,controlTransaction,audit} from './db.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {nextOccurrence,summaryConfig} from '../shared/summaries.js';
import {requireCondition} from './security.js';
export async function cancelBotTasks(id:string){
 const row=await botRecord(id);if(!['legacy','ready'].includes(row?.database_state))return;
 await withBot(id,async()=>{
  const {pool}=await import('./db.js');
  await pool.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='机器人暂停，任务已取消；恢复后不会自动重发',finished_at=now() WHERE status IN ('waiting_source','reading','queued','generating','preview','delivery_ready')");
  await pool.query("DELETE FROM summary_source_batches WHERE job_id IN (SELECT id FROM summary_jobs WHERE status='cancelled')");
 });
}
async function advanceSchedules(id:string){
 await withBot(id,async()=>{
  const {pool,transaction}=await import('./db.js');
  await transaction(async db=>{
   const rows=(await db.query('SELECT s.*,c.config settings FROM summary_schedules s JOIN summary_settings c ON c.group_id=s.group_id WHERE s.enabled FOR UPDATE OF s')).rows;
   for(const row of rows){const cfg=summaryConfig.parse(row.settings);if(row.config.kind==='daily')await db.query('UPDATE summary_schedules SET next_run=$2,last_error=NULL WHERE id=$1',[row.id,nextOccurrence(row.config,cfg.timezone,Date.now())]);else if(new Date(row.next_run).getTime()<=Date.now())await db.query("UPDATE summary_schedules SET enabled=false,last_error='暂停期间已错过单次预约，请检查后重新安排' WHERE id=$1",[row.id]);}
  });
 });
}
// Product policy: one active slot per owner for now; additional slots require an explicit future policy.
export const activeBotsPerUser=1;
export async function requestPause(id:string,revision:number,actor:string,principal:Pick<SessionUser,'id'|'role'>){
 await controlTransaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(78511966)');const row=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row&&(principal.role==='super_admin'||row.owner_user_id===principal.id),404,'机器人不存在或无权访问');requireCondition(row&&row.revision===revision,409,'机器人状态已变化，请刷新');requireCondition(row.state==='active',409,'机器人当前没有运行');await db.query("UPDATE managed_bots SET state='pausing',revision=revision+1,pause_requested_at=now(),stopped_revision=NULL WHERE id=$1",[id]);await db.query('DELETE FROM managed_bot_switch WHERE owner_user_id=$1 AND activation_slot=$2',[row.owner_user_id,row.activation_slot]);await audit(actor,'bot.pause_requested',id,{},db);});
 await cancelBotTasks(id);
}
export function readyForActivation(row:any){return row&&['legacy','ready'].includes(row.database_state)&&row.runtime_instance_id&&row.account_fingerprint&&row.runtime_status?.contract===1&&row.runtime_status?.revision===row.revision&&row.runtime_status?.cutover_generation===row.activation_generation&&row.runtime_status?.wechat_connected===true&&row.runtime_status?.reader_connected===true&&row.runtime_status?.maibot_connected===true&&row.runtime_status?.local_ready===true&&row.runtime_status?.stopped===true&&row.runtime_status?.sender_queue_depth===0&&row.runtime_status?.active_turns===0&&row.runtime_status?.send_inflight===false&&Date.now()-new Date(row.runtime_seen_at).getTime()<90000;}
export async function requestActivation(id:string,revision:number,actor:string,principal:Pick<SessionUser,'id'|'role'>){
 const target=await botRecord(id);requireCondition(target?.revision===revision&&target.state==='paused',409,'机器人状态已变化，请刷新');requireCondition(readyForActivation(target),409,'请先完成独立微信接入，确认微信、读取器和MaiBot在线');
 let previous:string|null=null;
 await controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  const locked=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];
  requireCondition(locked&&(principal.role==='super_admin'||locked.owner_user_id===principal.id),404,'机器人不存在或无权访问');
  requireCondition(locked?.state==='paused'&&locked.revision===revision&&readyForActivation(locked),409,'目标机器人状态已变化，请刷新');
  requireCondition(locked.owner_user_id,409,'请先由管理员分配机器人所有人');
  requireCondition(locked.activation_slot===activeBotsPerUser,409,'当前每个用户只能启用一个机器人');
  requireCondition((await db.query("SELECT 1 FROM admins WHERE deleted_at IS NULL AND id=$1 AND status='active'",[locked.owner_user_id])).rowCount,409,'机器人所有人未通过审核或已停用');
  const pending=(await db.query('SELECT target_id FROM managed_bot_switch WHERE owner_user_id=$1 AND activation_slot=$2 FOR UPDATE',[locked.owner_user_id,locked.activation_slot])).rows[0];
  requireCondition(!pending,409,'此用户已有机器人正在等待切换，请先完成或取消');
  const current=(await db.query("SELECT * FROM managed_bots WHERE deleted_at IS NULL AND owner_user_id=$1 AND activation_slot=$2 AND state IN ('active','pausing') FOR UPDATE",[locked.owner_user_id,locked.activation_slot])).rows[0];
  requireCondition(!current||current.state==='active',409,'此用户已有机器人正在暂停，请等待确认后再切换');
  await db.query('INSERT INTO managed_bot_switch(owner_user_id,activation_slot,target_id) VALUES($1,$2,$3)',[locked.owner_user_id,locked.activation_slot,id]);
  if(current){previous=current.id;await db.query("UPDATE managed_bots SET state='pausing',revision=revision+1,pause_requested_at=now(),stopped_revision=NULL WHERE id=$1",[current.id]);}
  await audit(actor,'bot.activation_requested',id,{previous_bot_id:previous,owner_user_id:locked.owner_user_id},db);
 });
 if(previous)await cancelBotTasks(previous);
 await finishPendingActivation();
}
async function finishOneActivation(owner:string,slot:number){
 return controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  const pending=(await db.query('SELECT target_id FROM managed_bot_switch WHERE owner_user_id=$1 AND activation_slot=$2 FOR UPDATE',[owner,slot])).rows[0];if(!pending)return false;
  if((await db.query("SELECT 1 FROM managed_bots WHERE deleted_at IS NULL AND owner_user_id=$1 AND activation_slot=$2 AND state IN ('active','pausing')",[owner,slot])).rowCount)return false;
  const target=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[pending.target_id])).rows[0];
  if(!target||target.owner_user_id!==owner||target.activation_slot!==slot||slot!==activeBotsPerUser||target.state!=='paused'||!readyForActivation(target))return false;
  if(!(await db.query("SELECT 1 FROM admins WHERE deleted_at IS NULL AND id=$1 AND status='active'",[owner])).rowCount)return false;
  try{await (await import('./bot-onboarding.js')).requireOnboardingReady(target.id);}catch{return false;}
  await advanceSchedules(target.id);
  await db.query("UPDATE managed_bots SET state='active',revision=revision+1,activation_generation=activation_generation+1,error=NULL WHERE id=$1",[target.id]);
  await db.query('DELETE FROM managed_bot_switch WHERE owner_user_id=$1 AND activation_slot=$2',[owner,slot]);
  await db.query('UPDATE managed_bot_onboarding SET completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE bot_id=$1',[target.id]);
  await audit('runtime','bot.activated',target.id,{owner_user_id:owner},db);return true;
 });
}
export async function finishPendingActivation(){
 let changed=false;
 for(const pending of (await controlPool.query('SELECT owner_user_id,activation_slot FROM managed_bot_switch ORDER BY requested_at')).rows)if(await finishOneActivation(pending.owner_user_id,pending.activation_slot))changed=true;
 return changed;
}
export async function archiveBot(id:string,revision:number,archived:boolean,actor:string,principal:Pick<SessionUser,'id'|'role'>){
 await controlTransaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(78511966)');const row=(await db.query('SELECT state,revision,owner_user_id FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row&&(principal.role==='super_admin'||row.owner_user_id===principal.id),404,'机器人不存在或无权访问');requireCondition(row?.revision===revision&&row.state===(archived?'paused':'archived'),409,'请先暂停并确认停止后再归档；状态变化时请刷新');requireCondition(!(await db.query('SELECT 1 FROM managed_bot_switch WHERE target_id=$1',[id])).rowCount,409,'此机器人正在等待切换，不能归档');await db.query('UPDATE managed_bots SET state=$2,revision=revision+1 WHERE id=$1',[id,archived?'archived':'paused']);await audit(actor,archived?'bot.archived':'bot.restored',id,{},db);});
}
