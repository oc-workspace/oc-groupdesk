/** Explicit operator maintenance: immutable history, no implicit draft publication. */
import {randomUUID} from 'node:crypto';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {advanceFollowers} from './persona-composition.js';
import {validateSkill} from './persona-generation.js';
import {identityPolicySchema} from './identity.js';
import {isInitialPersonaDraft} from '../shared/persona-editor.js';
import {withPersonaIdentityBoundary} from '../shared/bot-identity.js';
export function cleanPersonaIdentity(text:string){return withPersonaIdentityBoundary(text.replace(/GT\s*小\s*跟\s*班/g,'当前群配置的机器人称呼'));}
async function inventory(db:Pick<typeof pool,'query'>,lock=false){
 const personas=(await db.query('SELECT id,skill_name,kind,revision,draft_skill,draft_provenance FROM personas ORDER BY id'+(lock?' FOR UPDATE':''))).rows;
 const versions=(await db.query('SELECT * FROM persona_versions ORDER BY persona_id,version')).rows;
 const groups=(await db.query('SELECT id,policy,revision,persona_version_id,persona_follow_latest FROM groups WHERE deleted_at IS NULL ORDER BY id'+(lock?' FOR UPDATE':''))).rows;
 return {personas,versions,groups};
}
export async function identityMaintenancePlan(){
 const data=await inventory(pool);
 const fingerprint=digest(JSON.stringify({personas:data.personas.map(p=>[p.id,p.revision,digest(p.draft_skill)]),versions:data.versions.map(v=>[v.id,v.sha256]),groups:data.groups.map(g=>[g.id,g.revision,g.policy,g.persona_version_id,g.persona_follow_latest])}));
 return {fingerprint,personas:data.personas.length,base:data.personas.filter(p=>p.kind==='base').length,features:data.personas.filter(p=>p.kind==='feature').length,published_versions:data.versions.length,groups:data.groups.length};
}
export async function maintainBotIdentity(expected:string,names:string[]){
 identityPolicySchema.parse({mention_names:names});
 return transaction(async db=>{
  const data=await inventory(db,true),fingerprint=digest(JSON.stringify({personas:data.personas.map(p=>[p.id,p.revision,digest(p.draft_skill)]),versions:data.versions.map(v=>[v.id,v.sha256]),groups:data.groups.map(g=>[g.id,g.revision,g.policy,g.persona_version_id,g.persona_follow_latest])}));
  requireCondition(expected===fingerprint,409,'配置或人设已修改，请重新审查维护计划');
  requireCondition(!(await db.query("SELECT 1 FROM persona_jobs WHERE status IN ('pending','processing') LIMIT 1")).rowCount,409,'请等待人设生成结束再维护');
  const changes:any[]=[];
  for(const p of data.personas){
   const draft=isInitialPersonaDraft(p.draft_skill)?p.draft_skill:cleanPersonaIdentity(p.draft_skill);
   if(draft!==p.draft_skill){validateSkill(draft,p.skill_name);requireCondition(draft.length<=(p.kind==='feature'?6000:30000),400,'身份修订后人设过长，请人工精简');await db.query('UPDATE personas SET draft_skill=$2,revision=revision+1 WHERE id=$1',[p.id,draft]);}
   const latest=data.versions.filter(v=>v.persona_id===p.id).at(-1);
   if(!latest)continue; // Never publish an unpublished draft.
   const skill=cleanPersonaIdentity(latest.skill_md);if(skill===latest.skill_md)continue;
   validateSkill(skill,p.skill_name);requireCondition(skill.length<=(p.kind==='feature'?6000:30000),400,'身份修订后发布版本过长，请人工精简');
   const id=randomUUID();await db.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,p.id,latest.version+1,skill,digest(skill),{...latest.provenance,identity_maintenance:{contract:1,source_version_id:latest.id,source_sha256:latest.sha256}},p.kind]);
   const groups=await advanceFollowers(p.id,id,db);changes.push({persona_id:p.id,old_version_id:latest.id,new_version_id:id,old_sha256:latest.sha256,new_sha256:digest(skill),updated_groups:groups});
  }
  for(const g of data.groups){
   const identity=identityPolicySchema.parse({...g.policy.identity,name_policy_version:1,mention_names:g.policy.identity?.mention_names??names});
   if(JSON.stringify(identity)!==JSON.stringify(g.policy.identity))await db.query("UPDATE groups SET policy=jsonb_set(policy,'{identity}',$2::jsonb),revision=revision+1 WHERE id=$1",[g.id,JSON.stringify(identity)]);
  }
  await audit('operator','bot.identity_maintained',null,{contract:1,plan:expected,published:changes},db);
  return {personas:data.personas.length,new_versions:changes.length,groups:data.groups.length,changes};
 });
}
