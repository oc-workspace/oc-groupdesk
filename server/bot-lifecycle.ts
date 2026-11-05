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
export async function requestPause(id:string,revision:number,actor:string){
 await controlTransaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(78511966)');const row=(await db.query('SELECT * FROM managed_bots WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row&&row.revision===revision,409,'机器人状态已变化，请刷新');requireCondition(row.state==='active',409,'机器人当前没有运行');await db.query("UPDATE managed_bots SET state='pausing',revision=revision+1,pause_requested_at=now(),stopped_revision=NULL WHERE id=$1",[id]);await db.query('DELETE FROM managed_bot_switch WHERE singleton=true');await audit(actor,'bot.pause_requested',id,{},db);});
 await cancelBotTasks(id);
}
function ready(row:any){return row&&['legacy','ready'].includes(row.database_state)&&row.runtime_instance_id&&row.account_fingerprint&&row.runtime_status?.contract===1&&row.runtime_status?.revision===row.revision&&row.runtime_status?.cutover_generation===row.activation_generation&&row.runtime_status?.wechat_connected===true&&row.runtime_status?.reader_connected===true&&row.runtime_status?.maibot_connected===true&&row.runtime_status?.local_ready===true&&row.runtime_status?.stopped===true&&row.runtime_status?.sender_queue_depth===0&&row.runtime_status?.active_turns===0&&row.runtime_status?.send_inflight===false&&Date.now()-new Date(row.runtime_seen_at).getTime()<90000;}
export async function requestActivation(id:string,revision:number,actor:string){
 const target=await botRecord(id);requireCondition(target?.revision===revision&&target.state==='paused',409,'机器人状态已变化，请刷新');requireCondition(ready(target),409,'请先完成独立微信接入，确认微信、读取器和MaiBot在线');
 await controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');const locked=(await db.query('SELECT * FROM managed_bots WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(locked?.state==='paused'&&locked.revision===revision&&ready(locked),409,'目标机器人状态已变化，请刷新');const current=(await db.query("SELECT * FROM managed_bots WHERE state IN ('active','pausing') FOR UPDATE")).rows[0];
  requireCondition(!current||current.state==='active',409,'已有机器人正在暂停，请等待确认后再切换');
  await db.query('INSERT INTO managed_bot_switch(singleton,target_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET target_id=excluded.target_id,requested_at=now()',[id]);
  if(current)await db.query("UPDATE managed_bots SET state='pausing',revision=revision+1,pause_requested_at=now(),stopped_revision=NULL WHERE id=$1",[current.id]);
  await audit(actor,'bot.activation_requested',id,{previous_bot_id:current?.id||null},db);
 });
 const old=(await controlPool.query("SELECT id FROM managed_bots WHERE state='pausing'")).rows[0];if(old)await cancelBotTasks(old.id);
 await finishPendingActivation();
}
export async function finishPendingActivation(){
 const pending=(await controlPool.query('SELECT target_id FROM managed_bot_switch WHERE singleton=true')).rows[0];if(!pending)return false;
 const target=await botRecord(pending.target_id);if(!ready(target))return false;
 if((await controlPool.query("SELECT 1 FROM managed_bots WHERE state IN ('active','pausing')")).rowCount)return false;
 return controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  const pending=(await db.query('SELECT target_id FROM managed_bot_switch WHERE singleton=true FOR UPDATE')).rows[0];if(!pending||pending.target_id!==target.id)return false;
  if((await db.query("SELECT 1 FROM managed_bots WHERE state IN ('active','pausing')")).rowCount)return false;
  const fresh=(await db.query('SELECT * FROM managed_bots WHERE id=$1 FOR UPDATE',[target.id])).rows[0];if(fresh.state!=='paused'||!ready(fresh))return false;
  await advanceSchedules(target.id);
  await db.query("UPDATE managed_bots SET state='active',revision=revision+1,activation_generation=activation_generation+1,error=NULL WHERE id=$1",[target.id]);await db.query('DELETE FROM managed_bot_switch WHERE singleton=true');await audit('runtime','bot.activated',target.id,{},db);return true;
 });
}
export async function archiveBot(id:string,revision:number,archived:boolean,actor:string){
 await controlTransaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(78511966)');const row=(await db.query('SELECT state,revision FROM managed_bots WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(row?.revision===revision&&row.state===(archived?'paused':'archived'),409,'请先暂停并确认停止后再归档；状态变化时请刷新');requireCondition(!(await db.query('SELECT 1 FROM managed_bot_switch WHERE target_id=$1',[id])).rowCount,409,'此机器人正在等待切换，不能归档');await db.query('UPDATE managed_bots SET state=$2,revision=revision+1 WHERE id=$1',[id,archived?'archived':'paused']);await audit(actor,archived?'bot.archived':'bot.restored',id,{},db);});
}
