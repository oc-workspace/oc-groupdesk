import type express from 'express';
import {z} from 'zod';
import {pool,controlPool,transaction,controlTransaction,audit} from './db.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {superAdmin,accessibleBot} from './user-access.js';
import {requireCondition} from './security.js';

// This removes a registration from the product. Tombstones preserve independent
// billing/audit attribution and account data; it never runs Docker/WeChat tools.
function stopped(b:any){
 if(!b||!['paused','archived'].includes(b.state))return false;
 if(!b.runtime_instance_id&&!b.account_fingerprint&&!b.runtime_seen_at)return true;
 const s=b.runtime_status||{};
 return s.stopped===true&&s.sender_queue_depth===0&&s.active_turns===0&&s.send_inflight===false&&(b.stopped_revision!=null||s.revision===b.revision&&!!b.runtime_seen_at&&Date.now()-new Date(b.runtime_seen_at).getTime()<90000);
}
async function currentSuperAdministrator(actor:string,db:Pick<typeof pool,'query'>){const user=(await db.query('SELECT role,status FROM admins WHERE username=$1 FOR SHARE',[actor])).rows[0];requireCondition(user?.role==='super_admin'&&user.status==='active',403,'仅有效总管理员可以删除登记');}
async function blockedBot(b:any,db:Pick<typeof pool,'query'>=controlPool){
 const reasons:string[]=[];
 if(!['paused','archived'].includes(b.state))reasons.push('请先暂停机器人并等待运行端确认停止。');
 else if(!stopped(b))reasons.push('尚无可信的停止确认；请等待运行端确认发送队列和处理中任务均已清空。');
 if(b.database_state==='provisioning')reasons.push('业务空间正在初始化，请完成后再删除。');
 if((await db.query('SELECT 1 FROM managed_bot_switch WHERE target_id=$1',[b.id])).rowCount)reasons.push('请先取消等待切换的任务。');
 if((await db.query("SELECT 1 FROM managed_model_usage WHERE bot_id=$1 AND status='reserved' LIMIT 1",[b.id])).rowCount)reasons.push('仍有模型请求正在执行或等待计量完成，请稍后再试。');
 return reasons;
}
async function workCounts(groupId?:string,lock=false,db:Pick<typeof pool,'query'>=pool){
 const where=groupId?' AND group_id=$1':'',params=groupId?[groupId]:[];
 const counts:Record<string,number>={};
 const specs=groupId?[['summary_jobs',"status IN ('reading','generating','delivering')"],['group_onboarding_jobs',"status='working'"]]:[
  ['documents',"status='processing'"],['persona_jobs',"status='processing'"],['conversation_jobs',"status='processing'"],['interaction_templates',"status='processing'"],['summary_jobs',"status IN ('reading','generating','delivering')"],['group_onboarding_jobs',"status='working'"]];
 for(const [table,condition] of specs)counts[table]=(await db.query('SELECT 1 FROM '+table+' WHERE '+condition+where+(lock?' FOR UPDATE':''),params)).rowCount||0;
 return counts;
}
async function botStats(id:string){
 return withBot(id,async()=>{
 const counts:Record<string,number>={};for(const table of ['groups','topics','personas','knowledge_bases'])counts[table]=(await pool.query('SELECT count(*)::int n FROM '+table+(table==='groups'?' WHERE deleted_at IS NULL':''))).rows[0].n;
 return counts;
 });
}
export async function botDeletionPreview(id:string){
 const b=await botRecord(id);requireCondition(b,404,'机器人已删除或不存在');
 const reasons=await blockedBot(b);let counts:Record<string,number>={};
 if(['legacy','ready'].includes(b.database_state))try{counts=await botStats(id);const active=await withBot(id,()=>workCounts());if(Object.values(active).some(Boolean))reasons.push('此机器人仍有后台任务正在处理，请完成后再删除。');}catch{reasons.push('业务空间暂不可读取，不能确认后台任务状态；请管理员排查后重试。');}
 return {kind:'bot',id,revision:b.revision,name:b.name,confirmation:b.wechat_id,scope:'微信号：'+b.wechat_id,can_delete:!reasons.length,reasons,counts,
  effects:['从后台移除此微信号登记、所属群及业务资源的正常访问入口；删除后不能在界面恢复。','撤销此机器人的接入凭据，取消尚未开始的接入/生成任务。','用户自己的 API Key、公用授权及用量账单独立保留；不会删除其他机器人的资源。','底层历史数据、必要审计和账目留存；不删除微信账号、微信本地记录或服务器 Docker。']};
}
export async function deleteBotRegistration(id:string,revision:number,confirmation:string,actor:string){
 await controlTransaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  await currentSuperAdministrator(actor,db);
  const b=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(b,404,'机器人已删除或不存在');
  requireCondition(b.revision===revision,409,'机器人配置已变化，请重新查看删除确认');requireCondition(confirmation===b.wechat_id,400,'请完整输入当前微信号确认删除');
  const reasons=await blockedBot(b,db);requireCondition(!reasons.length,409,reasons.join(' '));
  if(['legacy','ready'].includes(b.database_state))await withBot(id,async()=>transaction(async client=>{
   const active=await workCounts(undefined,true,client);requireCondition(!Object.values(active).some(Boolean),409,'此机器人仍有后台任务正在处理，请完成后重试');
   // Queue status changes also prevent a picker that was waiting on these rows
   // from dispatching work after the registration becomes inaccessible.
   await client.query("UPDATE documents SET status='failed',error='机器人登记已删除，未开始的任务已取消' WHERE status='pending'");
   await client.query("UPDATE persona_jobs SET status='failed',error='机器人登记已删除，未开始的任务已取消',finished_at=now() WHERE status='pending'");
   await client.query("UPDATE conversation_jobs SET status='failed',error='机器人登记已删除，未开始的任务已取消',finished_at=now() WHERE status='pending'");
   await client.query("UPDATE interaction_templates SET status='failed',error='机器人登记已删除',updated_at=now() WHERE status='pending'");
   await client.query("UPDATE group_onboarding_jobs SET status='cancelled',stage='cancelled',error_code='registration_deleted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='queued'");
   await client.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='机器人登记已删除',finished_at=now() WHERE status IN ('waiting_source','queued','preview','delivery_ready')");
   await client.query('UPDATE summary_schedules SET enabled=false');
  }));
  await db.query('DELETE FROM managed_bot_adapters WHERE bot_id=$1',[id]);
  await db.query("UPDATE managed_model_requests SET status='cancelled',review_note='机器人登记已删除',reviewed_at=now() WHERE bot_id=$1 AND status='pending'",[id]);
  await db.query("UPDATE managed_bots SET deleted_at=now(),deleted_by=$2,state='archived',revision=revision+1 WHERE id=$1",[id,actor]);
  await audit(actor,'bot.registration_deleted',id,{retained_history:true,credentials_revoked:true},db);
 });
}
async function groupReasons(g:any,b:any,db:Pick<typeof pool,'query'>=controlPool){
 const reasons:string[]=[];
 if(g.external_id&&!stopped(b))reasons.push('这是已绑定的微信群，请先暂停所属机器人并等待停止确认；删除后可重新启用其余群。');
 if(!g.external_id&&g.enabled)reasons.push('请先停用此群并保存。');
 if((await db.query("SELECT 1 FROM managed_model_usage WHERE bot_id=$1 AND group_id=$2 AND status='reserved' LIMIT 1",[b.id,g.id])).rowCount)reasons.push('本群仍有模型请求等待完成或计量，请稍后再试。');
 return reasons;
}
export async function groupDeletionPreview(botId:string,id:string){
 const b=await botRecord(botId);requireCondition(b,404,'机器人不存在');
 const g=(await pool.query('SELECT * FROM groups WHERE deleted_at IS NULL AND id=$1',[id])).rows[0];requireCondition(g,404,'群聊配置已删除或不存在');
 const reasons=await groupReasons(g,b);if(Object.values(await workCounts(id)).some(Boolean))reasons.push('本群仍有接入或总结任务正在处理，请完成后再删除。');
 const counts={schedules:(await pool.query('SELECT count(*)::int n FROM summary_schedules WHERE group_id=$1',[id])).rows[0].n,members:(await pool.query('SELECT count(*)::int n FROM memberships WHERE group_id=$1 AND revoked_at IS NULL',[id])).rows[0].n};
 return {kind:'group',id,revision:g.revision,name:g.name,confirmation:g.name,scope:'机器人：'+b.name+' · 微信号：'+b.wechat_id+(g.external_id?' · 群标识：'+g.external_id:''),can_delete:!reasons.length,reasons,counts,
  effects:['从群管理、群人设配置及总结/互动等正常选择入口移除此群，界面不提供恢复。','停止此群的计划与未开始任务，解除话题、知识库、人设和成员授权的群绑定。','独立话题、知识库、人设、素材、历史积分账目及 API 用量保留，不删除其他群。','不会退出或解散真实微信群，也不会删除微信本地聊天记录。']};
}
export async function deleteGroupConfiguration(botId:string,id:string,revision:number,confirmation:string,actor:string){
 await controlTransaction(async control=>{
  await control.query('SELECT pg_advisory_xact_lock(78511966)');
  await currentSuperAdministrator(actor,control);
  const b=(await control.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR SHARE',[botId])).rows[0];requireCondition(b,404,'机器人已删除或不存在');
  await transaction(async db=>{
   const g=(await db.query('SELECT * FROM groups WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(g,404,'群聊配置已删除或不存在');
   requireCondition(g.revision===revision,409,'群配置已变化，请重新查看删除确认');requireCondition(confirmation===g.name,400,'请完整输入当前群名确认删除');
   const reasons=await groupReasons(g,b,control);requireCondition(!reasons.length,409,reasons.join(' '));
   const work=await workCounts(id,true,db);requireCondition(!Object.values(work).some(Boolean),409,'本群还有接入或总结任务正在处理，请稍后再试');
   await db.query("UPDATE group_onboarding_jobs SET status='cancelled',stage='cancelled',error_code='registration_deleted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE group_id=$1 AND status='queued'",[id]);
   await db.query('DELETE FROM group_onboarding_bindings WHERE group_id=$1',[id]);
   await db.query('UPDATE summary_schedules SET enabled=false WHERE group_id=$1',[id]);
   await db.query("UPDATE summary_jobs SET status='cancelled',source=NULL,error='群聊配置已删除',finished_at=now() WHERE group_id=$1 AND status IN ('waiting_source','queued','preview','delivery_ready')",[id]);
   await db.query("UPDATE group_interactions SET config=jsonb_set(config,'{enabled}','false') WHERE group_id=$1",[id]);
   await db.query("UPDATE interaction_templates SET status='failed',error='群聊配置已删除',updated_at=now() WHERE group_id=$1 AND status='pending'",[id]);
   await db.query('UPDATE memberships SET revoked_at=COALESCE(revoked_at,now()) WHERE group_id=$1',[id]);
   await db.query('DELETE FROM dm_scenes WHERE group_id=$1',[id]);
   await db.query('DELETE FROM group_topics WHERE group_id=$1',[id]);await db.query('DELETE FROM group_knowledge WHERE group_id=$1',[id]);await db.query('DELETE FROM group_persona_features WHERE group_id=$1',[id]);
   await db.query(`UPDATE groups SET deleted_at=now(),deleted_by=$2,enabled=false,revision=revision+1,persona_version_id=NULL,model_routes='{"text":{"mode":"disabled"},"image":{"mode":"disabled"}}' WHERE id=$1`,[id,actor]);
   await audit(actor,'group.configuration_deleted',id,{external_id:g.external_id,retained_history:true},db);
  });
 });
}
const deleteBody=z.object({revision:z.number().int().positive(),confirmation:z.string().min(1).max(120)}).strict();
export function registerBotDeletion(app:express.Express){
 app.get('/api/bots/:id/deletion',async(req,res)=>{superAdmin(req.admin!);const id=z.uuid().parse(req.params.id);res.json(await botDeletionPreview(id));});
 app.delete('/api/bots/:id',async(req,res)=>{superAdmin(req.admin!);const id=z.uuid().parse(req.params.id),b=deleteBody.parse(req.body);await deleteBotRegistration(id,b.revision,b.confirmation,req.admin!.username);res.json({ok:true,deleted:true});});
}
export function registerGroupDeletion(app:express.Express){
 app.get('/api/groups/:id/deletion',async(req,res)=>{superAdmin(req.admin!);await accessibleBot(req.admin!,req.botId!);res.json(await groupDeletionPreview(req.botId!,z.uuid().parse(req.params.id)));});
 app.delete('/api/groups/:id',async(req,res)=>{superAdmin(req.admin!);const b=deleteBody.parse(req.body);await deleteGroupConfiguration(req.botId!,z.uuid().parse(req.params.id),b.revision,b.confirmation,req.admin!.username);res.json({ok:true,deleted:true});});
}
