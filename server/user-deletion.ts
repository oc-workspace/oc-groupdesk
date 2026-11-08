import type express from 'express';
import {deletionReason,reasonFields,reasonDetails,type DeletionReason} from '../shared/deletion.js';
import {registerUserCleanup} from './user-cleanup.js';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {superAdmin} from './user-access.js';
import {requireCondition} from './security.js';
type Db=Pick<typeof controlPool,'query'>;
async function inspectUser(id:string,actorId:string,db:Db,lock=false){
 const u=(await db.query('SELECT id,username,github_login,github_id,display_name,role,status,revision FROM admins WHERE deleted_at IS NULL AND id=$1',[id])).rows[0];requireCondition(u,404,'站点账号已删除或不存在');
 const bots=(await db.query('SELECT name FROM managed_bots WHERE deleted_at IS NULL AND owner_user_id=$1',[id])).rows;
 const keys=(await db.query('SELECT id,name,archived FROM managed_model_keys WHERE owner_user_id=$1'+(lock?' FOR UPDATE':''),[id])).rows;
 const reasons:string[]=[];
 if(id===actorId)reasons.push('不能删除当前登录的账号，请由另一名总管理员操作。');
 if(u.role==='super_admin'&&u.status==='active'&&!(await db.query("SELECT 1 FROM admins WHERE deleted_at IS NULL AND id<>$1 AND role='super_admin' AND status='active'",[id])).rowCount)reasons.push('必须保留至少一名可登录的总管理员。');
 if(bots.length)reasons.push('请先在机器人管理删除或转移其名下 '+bots.length+' 个机器人：'+bots.slice(0,5).map(b=>b.name).join('、')+'。归档仍保留归属，不等于删除。');
 const active=keys.filter(k=>!k.archived);if(active.length)reasons.push('请先在 API Key 管理归档其名下 '+active.length+' 个 Key：'+active.slice(0,5).map(k=>k.name).join('、')+'。不会自动转交给管理员。');
 if((await db.query("SELECT 1 FROM managed_model_usage v JOIN managed_model_keys k ON k.id=v.key_id WHERE v.status='reserved' AND (v.user_id=$1 OR v.actor_user_id=$1 OR k.owner_user_id=$1) LIMIT 1",[id])).rowCount)reasons.push('此账号仍有模型调用等待完成或计量，请稍后再试。');
 const sessions=(await db.query('SELECT count(*)::int n FROM sessions WHERE admin_id=$1',[id])).rows[0].n,grants=(await db.query('SELECT count(*)::int n FROM managed_model_grants WHERE user_id=$1 AND enabled',[id])).rows[0].n;
 return {kind:'user',id,revision:u.revision,name:u.display_name||u.github_login||u.username,confirmation:u.github_login||u.username,scope:u.github_id?'GitHub：@'+u.github_login+' · 身份 ID：'+u.github_id:'本地账号：'+u.username,can_delete:!reasons.length,reasons,counts:{owned_bots:bots.length,active_keys:active.length,retained_keys:keys.length,sessions,grants},effects:[
 '从用户列表移除此站点账号，立即撤销登录会话、权限与其收到的公用 Key 授权；界面不提供恢复。',
 '同一 GitHub 身份再次登录将建立全新普通账号，按当前注册规则重新审核；不继承旧账号的机器人、Key、素材和私人资源权限。',
 '保留必要审计、创建者记录、历史素材和积分/API账单；已归档的私有 Key 继续归原账号，不转给管理员，其他人仍只能看到尾号。',
 '不注销 GitHub 或微信，不退出真实群、不删除 Docker；不自动删除其他人的机器人或共享资源。']};
}
export async function userDeletionPreview(id:string,actorId:string){return inspectUser(id,actorId,controlPool);}
export async function deleteUserAccount(id:string,revision:number,confirmation:string,actorId:string,why:DeletionReason){
 why=deletionReason.parse(why);
 await controlTransaction(async db=>{
  // Ownership, new provisioning, access changes and key maintenance coordinate here.
  await db.query('SELECT pg_advisory_xact_lock(78511966)');
  const users=(await db.query('SELECT id,username,role,status FROM admins WHERE deleted_at IS NULL ORDER BY id FOR UPDATE')).rows;
  const actor=users.find(u=>u.id===actorId);requireCondition(actor?.role==='super_admin'&&actor.status==='active',403,'仅有效总管理员可以删除站点账号');
  const p=await inspectUser(id,actorId,db,true);requireCondition(p.revision===revision,409,'账号信息已变化，请重新检查');requireCondition(p.confirmation===confirmation,400,'请完整输入当前账号确认删除');requireCondition(p.can_delete,409,p.reasons.join(' '));
  await db.query('DELETE FROM sessions WHERE admin_id=$1',[id]);
  await db.query('UPDATE managed_model_grants SET enabled=false,revision=revision+1 WHERE user_id=$1 AND enabled',[id]);
  await db.query("UPDATE managed_model_requests SET status='cancelled',review_note='站点账号已删除',reviewed_at=now() WHERE user_id=$1 AND status='pending'",[id]);
  await db.query('UPDATE managed_model_keys SET enabled=false,revision=revision+1 WHERE owner_user_id=$1 AND enabled',[id]);
  await db.query("UPDATE admins SET deleted_at=now(),deleted_by=$2,deletion_reason=$3,deletion_note=$4,status='disabled',permissions='{}',password_hash='!deleted-account',revision=revision+1 WHERE id=$1",[id,actor.username,why.reason,why.reason_note]);
  await audit(actor.username,'user.account_deleted',id,{...reasonDetails(why),target_name:p.name,account:p.confirmation,retained_history:true,session_revoked:true,github_can_register_again:true},db);
 });
}
export function registerUserDeletion(app:express.Express){
 registerUserCleanup(app);
 app.get('/api/users/:id/deletion',async(req,res)=>{superAdmin(req.admin!);res.json(await userDeletionPreview(z.uuid().parse(req.params.id),req.admin!.id));});
 app.delete('/api/users/:id',async(req,res)=>{superAdmin(req.admin!);const b=z.object({revision:z.number().int().positive(),confirmation:z.string().min(1).max(120),...reasonFields}).strict().refine(v=>v.reason!=='other'||!!v.reason_note,'选择其他时请补充原因').parse(req.body);await deleteUserAccount(z.uuid().parse(req.params.id),b.revision,b.confirmation,req.admin!.id,b);res.json({ok:true,deleted:true});});
}
