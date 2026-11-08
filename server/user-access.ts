import type express from 'express';
import {pool,controlPool} from './db.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {requireCondition} from './security.js';
import {allowed,type SessionUser,type Permission} from '../shared/user-permissions.js';
export const superAdmin=(u:SessionUser)=>requireCondition(u.role==='super_admin',403,'仅总管理员可以执行此操作');
export async function accessibleBot(user:SessionUser,id:string){const b=await botRecord(id);requireCondition(b&&(user.role==='super_admin'||b.owner_user_id===user.id),404,'机器人不存在或无权访问');return b;}
export function canReadResource(user:SessionUser,r:any){return user.role==='super_admin'||r.created_by_user_id===user.id||r.visibility==='common'||r.visibility==='selected'&&r.audience_user_ids?.includes(user.id);}
export async function initializeWorkspaceOwners(owner:string|null){if(!owner)return;for(const table of ['topics','personas','groups'])await pool.query('UPDATE '+table+' SET created_by_user_id=$1 WHERE created_by_user_id IS NULL',[owner]);}
export async function initializeUserOwners(){
 const admin=(await controlPool.query("SELECT id FROM admins WHERE deleted_at IS NULL AND role='super_admin' AND status='active' ORDER BY created_at,id LIMIT 1")).rows[0];if(!admin)return;
 await controlPool.query('UPDATE managed_bots SET owner_user_id=COALESCE(owner_user_id,$1),created_by_user_id=COALESCE(created_by_user_id,$1)',[admin.id]);
 for(const b of (await controlPool.query("SELECT id,owner_user_id FROM managed_bots WHERE deleted_at IS NULL AND database_state IN ('legacy','ready')")).rows)await withBot(b.id,()=>initializeWorkspaceOwners(b.owner_user_id));
}
function mutationPermission(path:string):Permission|null{
 if(/^\/topics(?:\/|$)|^\/catalog\//.test(path))return 'topics.create';
 if(/^\/persona|^\/personas/.test(path))return 'personas.create';
 if(/^\/groups|^\/group-onboarding|^\/reply-frequency/.test(path))return 'groups.manage';
 if(/^\/model/.test(path))return 'models.manage';
 if(/^\/knowledge|^\/documents/.test(path))return 'knowledge.manage';
 if(/^\/interaction/.test(path))return 'interactions.manage';
 if(/^\/summar/.test(path))return 'summaries.manage';
 if(/^\/conversation/.test(path))return 'conversation.manage';
 if(/^\/membership/.test(path))return 'members.manage';
 return null;
}
export async function workspaceAccess(req:express.Request,res:express.Response,next:express.NextFunction){
 const u=req.admin!,isAdmin=u.role==='super_admin',path=req.path;
 const [topics,personas,versions]=await Promise.all([
  pool.query('SELECT id,created_by_user_id,visibility,audience_user_ids FROM topics'),
  pool.query('SELECT id,created_by_user_id,visibility,audience_user_ids FROM personas'),
  pool.query('SELECT id,persona_id FROM persona_versions')]);
 const topicMap=new Map(topics.rows.map(r=>[r.id,r])),personaMap=new Map(personas.rows.map(r=>[r.id,r]));
 const visibleTopics=new Set(topics.rows.filter(r=>canReadResource(u,r)).map(r=>r.id));
 const visiblePersonas=new Set(personas.rows.filter(r=>canReadResource(u,r)).map(r=>r.id));
 const visibleVersions=new Set(versions.rows.filter(r=>visiblePersonas.has(r.persona_id)).map(r=>r.id));
 const mutable=!['GET','HEAD','OPTIONS'].includes(req.method);
 if(!isAdmin&&/^\/(notifications|system|logs)(\/|$)/.test(path))throw new (await import('./security.js')).HttpError(403,'仅总管理员可以访问系统设置和审计记录');
 const readOnlyPost=/^\/topics\/[^/]+\/test$|^\/persona-bindings\/|^\/persona-resources\/[^/]+\/preview$|^\/knowledge\/[^/]+\/search$/.test(path)&&req.method==='POST';
 if(mutable&&!isAdmin&&path==='/catalog/import')requireCondition(!req.body.replace,403,'普通用户不能覆盖目录中的已有资源');
 if(mutable&&!readOnlyPost&&!isAdmin){const permission=mutationPermission(path);requireCondition(permission&&allowed(u,permission),403,'没有此操作权限，请联系总管理员');}
 let target:any=null,resourceKind='';
 const topic=/^\/topics\/([0-9a-f-]{36})(?:\/|$)/.exec(path),persona=/^\/personas\/([0-9a-f-]{36})(?:\/|$)/.exec(path),version=/^\/persona-versions\/([0-9a-f-]{36})(?:\/|$)/.exec(path);
 if(topic){target=topicMap.get(topic[1]);resourceKind='topics';}
 if(persona){target=personaMap.get(persona[1]);resourceKind='personas';}
 if(version){target=personaMap.get(versions.rows.find(v=>v.id===version[1])?.persona_id);resourceKind='personas';}
 if(topic||persona||version){requireCondition(target&&canReadResource(u,target),404,'资源不存在或无权访问');if(mutable&&!readOnlyPost)requireCondition(isAdmin||target.created_by_user_id===u.id,403,'共享资源只读，请复制为自己的版本后编辑');}
 const foreignPersona=!isAdmin&&target&&resourceKind==='personas'&&target.created_by_user_id!==u.id;
 if(foreignPersona&&version&&path.endsWith('/export'))requireCondition(false,403,'请先复制为自己的草稿；原始来源包包含作者私有制作溯源');
 const publicSkill=foreignPersona&&persona?(await pool.query('SELECT skill_md FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[target.id])).rows[0]?.skill_md||'':null;
 res.locals.visiblePersonaVersions=visibleVersions;
 if(!isAdmin&&req.method==='GET'&&/^\/persona-bindings\/[0-9a-f-]{36}$/.test(path)){
  const id=path.split('/')[2],g=(await pool.query('SELECT persona_version_id FROM groups WHERE deleted_at IS NULL AND id=$1',[id])).rows[0];
  const features=(await pool.query('SELECT version_id FROM group_persona_features WHERE group_id=$1',[id])).rows;
  requireCondition((!g?.persona_version_id||visibleVersions.has(g.persona_version_id))&&features.every(f=>visibleVersions.has(f.version_id)),403,'群中包含管理员维护的受限人设，请联系管理员分享后再预览');
 }
 // Membership in a group cannot be used to bind a guessed private resource ID.
 const assertTopic=(id:string)=>requireCondition(visibleTopics.has(id),403,'所选话题不可用');
 const assertVersion=(id:string)=>requireCondition(visibleVersions.has(id),403,'所选人设不可用');
 if(mutable&&!isAdmin){
  if(path==='/group-onboarding/connect'){for(const id of req.body.config?.topic_ids||[])assertTopic(id);if(req.body.config?.base_version_id)assertVersion(req.body.config.base_version_id);for(const f of req.body.config?.features||[])assertVersion(f.version_id);}
  if(/^\/groups\/[^/]+$/.test(path)&&req.method==='PUT'){
   const current=(await pool.query('SELECT external_id FROM groups WHERE deleted_at IS NULL AND id=$1',[path.split('/')[2]])).rows[0];
   if(req.body.external_id&&req.body.external_id!==current?.external_id)requireCondition(new RegExp('^bowxt-'+req.botId!.replaceAll('-','')+':[1-9][0-9]*$').test(req.body.external_id),403,'群标识必须属于当前机器人');
   const old=(await pool.query('SELECT topic_id FROM group_topics WHERE group_id=$1',[path.split('/')[2]])).rows.map(r=>r.topic_id);
   for(const id of req.body.topic_ids||[])if(!old.includes(id))assertTopic(id);
  }
  if(/^\/persona-bindings\//.test(path)&&req.method==='PUT'){if(req.body.version_id)assertVersion(req.body.version_id);for(const f of req.body.features||[])assertVersion(f.version_id);}
 }
 const users=(await controlPool.query('SELECT id,username,display_name,github_login,deleted_at FROM admins')).rows;
 const creator=(id:string)=>{const a=users.find(a=>a.id===id);return a?{id:a.id,name:(a.display_name||a.github_login||a.username)+(a.deleted_at?'（已删除账号）':'')}:null;};
 const decorate=(r:any,kind:string)=>({...r,audience_user_ids:isAdmin?r.audience_user_ids:undefined,creator:creator(r.created_by_user_id),can_edit:isAdmin||r.created_by_user_id===u.id&&allowed(u,kind==='topics'?'topics.create':'personas.create')});
 const group=(g:any)=>({...g,creator:creator(g.created_by_user_id),persona_binding:g.persona_version_id&&!visibleVersions.has(g.persona_version_id)?{name:'管理员配置的受限人设',version:null}:g.persona_binding,persona_features:g.persona_features?.map((f:any)=>visiblePersonas.has(f.persona_id)?f:{...f,name:'管理员配置的受限特色'})});
 const json=res.json.bind(res);res.json=((data:any)=>{
  if(path==='/overview'&&Array.isArray(data?.groups)&&Array.isArray(data?.topics))data={...data,groups:data.groups.map(group),topics:data.topics.filter((r:any)=>visibleTopics.has(r.id)).map((r:any)=>decorate(r,'topics'))};
  if(path==='/catalog'&&Array.isArray(data)&&!isAdmin)data=data.map(r=>r.id&&!visibleTopics.has(r.id)?{...r,id:undefined,revision:undefined,current:null,customized:false,status:'restricted'}:r);
  if(req.method==='GET'&&/^\/groups\/[0-9a-f-]{36}$/.test(path)&&data?.id)data=group(data);
  if(path==='/persona-studio'&&Array.isArray(data?.personas))data={...data,personas:data.personas.filter((p:any)=>visiblePersonas.has(p.id)).map((p:any)=>decorate({...p,...personaMap.get(p.id)},'personas')),versions:data.versions.filter((v:any)=>visibleVersions.has(v.id)),bindings:data.bindings.map((b:any)=>({...b,persona_id:b.persona_id&&visiblePersonas.has(b.persona_id)?b.persona_id:null,persona_version_id:b.persona_version_id&&visibleVersions.has(b.persona_version_id)?b.persona_version_id:null,features:(b.features||[]).filter((f:any)=>visiblePersonas.has(f.persona_id))}))};
  if(persona&&data?.id){data=decorate(data,'personas');if(foreignPersona)data={...data,draft_skill:publicSkill,goal:'共享已发布人设；请复制为自己的草稿后编辑。',dataset_ids:[],draft_provenance:{},jobs:[],versions:data.versions.map(({provenance,...v}:any)=>v)};}
  if(!isAdmin&&path==='/persona-resources'&&data?.entries)data={...data,entries:data.entries.map((e:any)=>({...e,similar:e.similar.filter((p:any)=>visiblePersonas.has(p.id)),imports:e.imports.filter((i:any)=>!i.persona_id||visiblePersonas.has(i.persona_id))}))};
  if(!isAdmin&&path==='/group-onboarding'&&data?.versions)data={...data,versions:data.versions.filter((v:any)=>visibleVersions.has(v.id))};
  return json(data);
 }) as typeof res.json;
 next();
}
