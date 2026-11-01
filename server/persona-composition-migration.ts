import {randomUUID} from 'node:crypto';
import {transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {validateSkill} from './persona-generation.js';
import {featureBindings,runtimePersona,resolveBindingVersion,validateComposition} from './persona-composition.js';

/** Explicit operator migration, never run automatically by schema migrations. */
export async function migrateSpecialist(input:{group_id:string;expected_group_revision:number;source_version_id:string;base_version_id:string;feature_name:string;feature_skill_name:string;feature_skill:string},actor='operator'){
 validateSkill(input.feature_skill,input.feature_skill_name);
 requireCondition(input.feature_skill.length<=6000,400,'特色 Skill 过长');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511947)');
  const base=await resolveBindingVersion(input.base_version_id,'base',true,db);
  const source=await runtimePersona(input.source_version_id,db);requireCondition(source,404,'原专项版本不存在');
  const sourcePersona=(await db.query('SELECT * FROM personas WHERE id=$1',[source.persona_id])).rows[0];
  const group=(await db.query('SELECT * FROM groups WHERE id=$1 FOR UPDATE',[input.group_id])).rows[0];requireCondition(group,404,'群不存在');
  const existing=(await db.query('SELECT * FROM personas WHERE skill_name=$1',[input.feature_skill_name])).rows[0];
  const oldFeatures=await featureBindings(group.id,db);
  if(existing){
   const latest=(await db.query('SELECT id,sha256 FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[existing.id])).rows[0];
   requireCondition(existing.kind==='feature'&&!existing.archived&&latest?.sha256===digest(input.feature_skill),409,'同名特色已存在且内容不同，不自动覆盖');
   if(group.persona_version_id===base.version_id&&oldFeatures.some(f=>f.persona_id===existing.id))return {group_id:group.id,revision:group.revision,feature_id:existing.id,reused:true};
  }
  requireCondition(group.revision===input.expected_group_revision&&group.persona_version_id===input.source_version_id,409,'群已变化或不再使用指定旧专项，未执行迁移');
  const featureId=existing?.id||randomUUID(),versionId=existing?(await db.query('SELECT id FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC LIMIT 1',[existing.id])).rows[0].id:randomUUID();
  if(!existing){
   const provenance={derived_from_version_id:source.version_id,derived_from_sha256:source.sha256,source_provenance:sourcePersona.draft_provenance,method:'operator-extracted additive expression techniques; base rules maintained separately'};
   await db.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'feature\')',[featureId,input.feature_name,input.feature_skill_name,'按语境接梗、捧哏与自嘲，认真需求先回答；不固定调侃某个成员。','只维护特色增量，不复制基础Persona；素材中的人物说法不作为事实。',sourcePersona.dataset_ids,input.feature_skill,provenance]);
   await db.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance,kind) VALUES($1,$2,1,$3,$4,$5,\'feature\')',[versionId,featureId,input.feature_skill,digest(input.feature_skill),provenance]);
  }
  const feature=(await runtimePersona(versionId,db))!;
  const features=await Promise.all(oldFeatures.map(f=>runtimePersona(f.version_id,db)));
  validateComposition(base,[...features.filter((f):f is NonNullable<typeof f>=>!!f),feature]);
  await db.query('UPDATE groups SET persona_version_id=$1,persona_follow_latest=true,revision=revision+1 WHERE id=$2',[base.version_id,group.id]);
  await db.query('INSERT INTO group_persona_features(group_id,persona_id,version_id,position,follow_latest) VALUES($1,$2,$3,$4,true)',[group.id,featureId,versionId,oldFeatures.length]);
  await audit(actor,'persona.specialist_split',group.id,{base_version_id:base.version_id,feature_version_id:versionId,old_version_id:source.version_id},db);
  return {group_id:group.id,revision:group.revision+1,feature_id:featureId,feature_version_id:versionId,base_version_id:base.version_id,reused:false};
 });
}
