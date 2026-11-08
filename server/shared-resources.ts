import type express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,controlPool,transaction,audit} from './db.js';
import {withBot,botRecord} from './bot-workspaces.js';
import {superAdmin,canReadResource,accessibleBot} from './user-access.js';
import {allowed,type SessionUser} from '../shared/user-permissions.js';
import {requireCondition,digest} from './security.js';
const table=(kind:string)=>kind==='topic'?'topics':'personas';
async function resources(user:SessionUser){
 const users=(await controlPool.query('SELECT id,username,github_login,display_name,deleted_at FROM admins')).rows,result:any[]=[];
 const bots=(await controlPool.query("SELECT id,name,owner_user_id FROM managed_bots WHERE deleted_at IS NULL AND database_state IN ('legacy','ready') AND state<>'archived'")).rows;
 for(const bot of bots)await withBot(bot.id,async()=>{
  for(const [kind,t] of [['topic','topics'],['persona','personas']]){
   const rows=(await pool.query('SELECT id,name,created_by_user_id,visibility,audience_user_ids FROM '+t+' ORDER BY name')).rows;
   for(const r of rows){if(!canReadResource(user,r))continue;const c=users.find(u=>u.id===r.created_by_user_id);let version=null;
    if(kind==='persona')version=(await pool.query('SELECT version FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[r.id])).rows[0]?.version||null;
    result.push({...r,...(user.role==='super_admin'?{}:{audience_user_ids:undefined}),kind,bot_id:bot.id,...(user.role==='super_admin'?{bot_name:bot.name,owner_user_id:bot.owner_user_id}:{}),creator:c?{id:c.id,name:(c.display_name||c.github_login||c.username)+(c.deleted_at?'（已删除账号）':'')}:null,version,importable:kind==='topic'||!!version});
   }
  }
 });return result;
}
export function registerSharedResources(app:express.Express){
 app.get('/api/shared-resources',async(req,res)=>res.json({resources:await resources(req.admin!)}));
 app.put('/api/shared-resources/visibility',async(req,res)=>{
  superAdmin(req.admin!);const b=z.object({bot_id:z.uuid(),id:z.uuid(),kind:z.enum(['topic','persona']),visibility:z.enum(['private','common','selected']),audience_user_ids:z.array(z.uuid()).max(1000)}).strict().parse(req.body);
  requireCondition(b.visibility!=='selected'||b.audience_user_ids.length>0,400,'请选择允许访问的用户');requireCondition(new Set(b.audience_user_ids).size===b.audience_user_ids.length,400,'用户不能重复');
  requireCondition((await controlPool.query("SELECT count(*)::int n FROM admins WHERE deleted_at IS NULL AND id=ANY($1::uuid[]) AND status='active'",[b.audience_user_ids])).rows[0].n===b.audience_user_ids.length,400,'指定用户不存在或已停用');
  await accessibleBot(req.admin!,b.bot_id);await withBot(b.bot_id,async()=>transaction(async db=>{requireCondition((await db.query('UPDATE '+table(b.kind)+' SET visibility=$2,audience_user_ids=$3 WHERE id=$1 RETURNING id',[b.id,b.visibility,b.visibility==='selected'?b.audience_user_ids:[]])).rowCount,404,'资源不存在');await audit(req.admin!.username,'resource.visibility_updated',b.id,{kind:b.kind,visibility:b.visibility,audience:b.audience_user_ids},db);}));res.json({ok:true});
 });
 app.post('/api/shared-resources/copy',async(req,res)=>{
  const u=req.admin!,b=z.object({source_bot_id:z.uuid(),source_id:z.uuid(),kind:z.enum(['topic','persona']),target_bot_id:z.uuid(),name:z.string().trim().min(1).max(80)}).strict().parse(req.body);
  requireCondition(allowed(u,b.kind==='topic'?'topics.create':'personas.create'),403,'没有创建此类资源的权限');await accessibleBot(u,b.target_bot_id);
  requireCondition((await botRecord(b.source_bot_id))?.state!=='archived',404,'来源不可用');
  const source=await withBot(b.source_bot_id,async()=>{const r=(await pool.query('SELECT * FROM '+table(b.kind)+' WHERE id=$1',[b.source_id])).rows[0];requireCondition(r&&canReadResource(u,r),404,'来源不存在或无权访问');
   if(b.kind==='persona'){const v=(await pool.query('SELECT * FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[r.id])).rows[0];requireCondition(v,409,'该人设尚未发布，请等待作者发布后复制');return {...r,published:v};}return r;
  });
  const id=randomUUID(),provenance={source_bot_id:b.source_bot_id,source_id:b.source_id,source_revision:source.revision,source_version:source.published?.version||null,source_creator_id:source.created_by_user_id,copied_at:new Date().toISOString()};
  await withBot(b.target_bot_id,()=>transaction(async db=>{
   if(b.kind==='topic')await db.query('INSERT INTO topics(id,name,description,instructions,color,policy,created_by_user_id,source_resource) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,b.name,source.description,source.instructions,source.color,source.policy,u.id,provenance]);
   else{
    const slug='copy-'+id.replaceAll('-','').slice(0,24),skill=source.published.skill_md.replace(/^name:.*$/m,'name: '+slug);
    await db.query('INSERT INTO personas(id,name,skill_name,description,goal,draft_skill,draft_provenance,kind,created_by_user_id,source_resource) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,b.name,slug,source.description,'基于共享已发布版本制作独立草稿；请人工修订后发布。',skill,{method:'shared-snapshot-copy',source:provenance,sha256:digest(skill)},source.kind,u.id,provenance]);
   }
   await audit(u.username,'resource.copied',id,{kind:b.kind,source_id:b.source_id},db);
  }));res.status(201).json({id,kind:b.kind,unpublished:b.kind==='persona'});
 });
}
