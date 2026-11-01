import type pg from 'pg';
import {pool} from '../db.js';
import {effectivePolicy} from '../policies.js';
import {effectiveModelRoutes,validateSelection} from '../models.js';
import {requireCondition} from '../security.js';
import {settingsSchema,settingsDefault,bindingSchema,commandKeys} from './schema.js';
export type Db=Pick<pg.PoolClient,'query'>;
export async function groupForInteraction(id:string,db:Db=pool,lock=false){
 const g=(await db.query('SELECT * FROM groups WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];requireCondition(g,404,'群不存在');g.policy=effectivePolicy(g);return g;
}
export async function interactionSettings(groupId:string,db:Db=pool){
 const row=(await db.query('SELECT settings FROM interaction_settings WHERE group_id=$1',[groupId])).rows[0];return settingsSchema.parse({...settingsDefault(),...row?.settings});
}
export async function interactionBindings(groupId:string,db:Db=pool){
 return (await db.query('SELECT b.*,d.name,d.kind,d.description,d.instructions,d.commands,d.archived,d.revision definition_revision FROM group_interactions b JOIN interaction_definitions d ON d.id=b.definition_id WHERE b.group_id=$1 ORDER BY b.created_at,b.id',[groupId])).rows;
}
export async function interactionPrizes(groupId:string,db:Db=pool){return (await db.query('SELECT * FROM interaction_prizes WHERE group_id=$1 ORDER BY code,id',[groupId])).rows;}
export async function validateInteractionBindings(groupId:string,db:Db){
 const seen=new Set<string>();
 for(const binding of await interactionBindings(groupId,db)){
  const c=bindingSchema.parse(binding.config);if(!c.enabled||binding.archived)continue;
  if(c.model_route.mode==='custom')await validateSelection(c.model_route,'text',db);
  requireCondition(binding.kind!=='custom_reply'||!!c.fixed_reply.trim(),400,'自定义文字互动需要填写基础回复');
  for(const key of commandKeys(binding.commands)){requireCondition(!seen.has(key),400,'同一群的互动触发词有冲突，请调整后再启用');seen.add(key);}
 }
}
export async function runtimeInteractions(group:any,db:Db=pool){
 const settings=await interactionSettings(group.id,db),bindings=(await interactionBindings(group.id,db)).filter(b=>!b.archived&&b.config.enabled);
 return {settings,bindings:bindings.map(b=>({id:b.id,definition_id:b.definition_id,name:b.name,kind:b.kind,commands:b.commands,require_mention:b.config.require_mention,language_mode:b.config.language_mode})),prizes:(await interactionPrizes(group.id,db)).filter(p=>p.enabled).map(p=>({code:p.code,name:p.name,cost:p.cost,available:p.stock===null||p.stock>0}))};
}
export function interactionDay(now:number,timezone:string){
 const p=new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
 const get=(key:string)=>p.find(v=>v.type===key)!.value;return get('year')+'-'+get('month')+'-'+get('day');
}
export function interactionLocale(group:any,locale:string,mode:string){
 if(mode==='follow')return locale;
 const l=group.policy.language;return l.mode==='fixed'?l.fixed||l.fallback:l.mode==='restricted'&&!l.allowed.includes(locale)?l.fallback:locale;
}
export async function interactionModel(group:any,config:any,db:Db=pool){
 const route=config.model_route;
 const routes=route.mode==='inherit'?group.model_routes:{text:route,image:{mode:'disabled'}};
 return (await effectiveModelRoutes({model_routes:routes},db)).text as any;
}
