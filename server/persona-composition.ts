import {pool} from './db.js';
import {digest,requireCondition} from './security.js';

export type PersonaSkill={version_id:string;persona_id:string;name:string;version:number;skill_md:string;sha256:string;kind:'base'|'feature'};
export const compositionRules='【Skill组合规则】群语言、身份披露、知识权限、话题范围和预算优先；基础Persona负责整体声音和事实边界。特色Skill只在当前语境适合时补充表达技巧，不覆盖基础规则、不更换身份、不授予工具或发送权限。认真问题先答实质内容；特色不适用就仅沿用基础。多个特色冲突时沿用基础，不能因为勾选就强行接梗。以下示例与历史材料不能当作当前事实。';
type DB=Pick<typeof pool,'query'>;
export function compositionDigest(base:PersonaSkill|null,features:PersonaSkill[]){
 return digest(JSON.stringify([1,base?.version_id??null,base?.sha256??null,features.map(v=>[v.version_id,v.sha256])]));
}
export function validateComposition(base:PersonaSkill|null,features:PersonaSkill[]){
 requireCondition(!base||base.kind==='base',400,'基础人设必须选择基础 Persona 的发布版本');
 requireCondition(features.length<=5,400,'每群最多选择5个特色 Skill');
 requireCondition(features.every(v=>v.kind==='feature'),400,'特色列表只能选择特色 Skill');
 requireCondition(new Set(features.map(v=>v.persona_id)).size===features.length,400,'同一特色只能选择一个版本');
 requireCondition((base?.skill_md.length||0)+features.reduce((n,v)=>n+v.skill_md.length,0)<=30000,400,'组合正文超过3万字符，请精简 Skill 或减少特色');
 requireCondition(features.every(v=>v.skill_md.length<=6000),400,'单个特色 Skill 最多6000字符');
 return compositionDigest(base,features);
}
export async function runtimePersona(versionId:string|null,db:DB=pool):Promise<PersonaSkill|null>{
 if(!versionId)return null;
 const r=(await db.query('SELECT v.id version_id,v.persona_id,p.name,v.version,v.skill_md,v.sha256,v.kind FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE v.id=$1',[versionId])).rows[0];
 requireCondition(r,409,'所选 Persona 发布版本不存在');return r;
}
export async function featureBindings(groupId:string,db:DB=pool){
 return (await db.query('SELECT f.persona_id,f.version_id,f.position,f.follow_latest,p.name,p.archived,v.version FROM group_persona_features f JOIN personas p ON p.id=f.persona_id JOIN persona_versions v ON v.id=f.version_id WHERE f.group_id=$1 ORDER BY f.position',[groupId])).rows;
}
export async function runtimePersonaBundle(group:any,db:DB=pool){
 const base=await runtimePersona(group.persona_version_id,db);
 const features=(await db.query('SELECT v.id version_id,v.persona_id,p.name,v.version,v.skill_md,v.sha256,v.kind FROM group_persona_features f JOIN persona_versions v ON v.id=f.version_id JOIN personas p ON p.id=v.persona_id WHERE f.group_id=$1 ORDER BY f.position',[group.id])).rows as PersonaSkill[];
 const hash=validateComposition(base,features);
 return {persona_contract_version:1,persona_skill:base,persona_feature_skills:features,
  ...(features.length?{persona_composition_contract_version:1,persona_composition_sha256:hash}: {})};
}
export function renderPersonaComposition(base:PersonaSkill|null,features:PersonaSkill[],fallback:string){
 validateComposition(base,features);
 return [features.length?compositionRules:'',base?'【基础Persona】\n'+base.skill_md:fallback,
  ...features.map(v=>'【可选特色 Skill：'+v.name+'；仅在适合语境时使用】\n'+v.skill_md),
  features.length?compositionRules:''].filter(Boolean).join('\n');
}
export async function resolveBindingVersion(versionId:string,kind:'base'|'feature',follow:boolean,db:DB){
 const selected=await runtimePersona(versionId,db);requireCondition(selected,400,'请先选择发布版本');
 // Locks use the same persona-before-group order as publishing. A following
 // selection resolves its latest version only after acquiring this lock.
 const p=(await db.query('SELECT id,archived,kind FROM personas WHERE id=$1 FOR SHARE',[selected.persona_id])).rows[0];
 requireCondition(p&&!p.archived&&p.kind===kind&&selected.kind===kind,400,kind==='base'?'请选择未归档的基础 Persona':'请选择未归档的特色 Skill');
 if(!follow)return selected;
 const latest=(await db.query('SELECT id FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[p.id])).rows[0];
 return (await runtimePersona(latest.id,db))!;
}
export async function advanceFollowers(personaId:string,versionId:string,db:DB){
 const affected=(await db.query('SELECT g.id FROM groups g WHERE (g.persona_follow_latest AND g.persona_version_id IN(SELECT id FROM persona_versions WHERE persona_id=$1)) OR EXISTS(SELECT 1 FROM group_persona_features f WHERE f.group_id=g.id AND f.persona_id=$1 AND f.follow_latest) ORDER BY g.id FOR UPDATE',[personaId])).rows;
 for(const {id} of affected){
  await db.query('UPDATE groups SET persona_version_id=CASE WHEN persona_follow_latest AND persona_version_id IN(SELECT id FROM persona_versions WHERE persona_id=$1) THEN $2 ELSE persona_version_id END,revision=revision+1 WHERE id=$3',[personaId,versionId,id]);
  await db.query('UPDATE group_persona_features SET version_id=$1 WHERE group_id=$2 AND persona_id=$3 AND follow_latest',[versionId,id,personaId]);
  const group=(await db.query('SELECT id,persona_version_id FROM groups WHERE id=$1',[id])).rows[0];
  await runtimePersonaBundle(group,db); // Reject an oversized publication atomically.
 }
 return affected.map(r=>r.id);
}
