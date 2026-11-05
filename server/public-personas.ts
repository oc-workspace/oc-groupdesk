import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {skillName,validateSkill} from './persona-generation.js';

const entry=z.object({
 skill_name:skillName,name:z.string().min(1).max(120),description:z.string().min(1).max(500),goal:z.string().max(3000),sha256:z.string().regex(/^[a-f0-9]{64}$/),
 source:z.object({repository:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),commit:z.string().regex(/^[a-f0-9]{40}$/),path:z.string().regex(/^[A-Za-z0-9_./-]+\.md$/),license:z.enum(['MIT','not_declared']),adaptation:z.enum(['independently_authored_framework_reference','group_chat_adaptation']),upstream_files_copied:z.literal(false)}).strict()
}).strict();
const catalog=z.object({format:z.literal(1),personas:z.array(entry).min(1).max(20)}).strict();
export async function publicPersonaPackages(){
 const data=catalog.parse(JSON.parse(await readFile(new URL('../skills/base-personas/catalog.json',import.meta.url),'utf8')));
 requireCondition(new Set(data.personas.map(p=>p.skill_name)).size===data.personas.length,500,'基础Persona模板名重复');
 return Promise.all(data.personas.map(async p=>{
  const skill=await readFile(new URL('../skills/base-personas/'+p.skill_name+'/SKILL.md',import.meta.url),'utf8');
  validateSkill(skill,p.skill_name);requireCondition(digest(skill)===p.sha256,500,'基础Persona模板摘要不匹配');
  requireCondition(p.source.license!=='not_declared'||p.source.adaptation==='independently_authored_framework_reference',500,'未声明许可的来源只能作为独立实现参考');
  const license=p.source.license==='MIT'?await readFile(new URL('../skills/base-personas/'+p.skill_name+'/LICENSE.upstream',import.meta.url),'utf8'):null;
  if(license)requireCondition(license.includes('MIT License')&&license.includes('Copyright (c) 2026 OpenDemon')&&license.includes('Permission is hereby granted'),500,'基础Persona许可声明不完整');
  return {...p,skill,provenance:{method:'reviewed-public-base-persona',package_format:1,package_sha256:p.sha256,source:p.source,license_text:license,external_runtime_files_required:false,materials_imported:false}};
 }));
}

// Explicit operator import. Published options are inert until a group selects
// one; existing drafts, versions, bindings and application revisions are kept.
export async function seedPublicBasePersonas(actor:string){
 const packages=await publicPersonaPackages();
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511969)');
  const results=[];
  for(const p of packages){
   const existing=(await db.query('SELECT id,kind,archived FROM personas WHERE skill_name=$1 FOR UPDATE',[p.skill_name])).rows[0];
   if(existing){
    requireCondition(existing.kind==='base',409,'已有同名特色Skill，请先人工核对');
    const latest=(await db.query('SELECT max(version)::int version FROM persona_versions WHERE persona_id=$1',[existing.id])).rows[0].version;
    results.push({id:existing.id,name:p.name,skill_name:p.skill_name,created:false,published_version:latest,existing_preserved:true});continue;
   }
   const id=randomUUID(),versionId=randomUUID();
   await db.query("INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance,kind) VALUES($1,$2,$3,$4,$5,'{}',$6,$7,'base')",[id,p.name,p.skill_name,p.description,p.goal,p.skill,p.provenance]);
   await db.query("INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance,kind) VALUES($1,$2,1,$3,$4,$5,'base')",[versionId,id,p.skill,p.sha256,p.provenance]);
   await audit(actor,'persona.public_base_imported',id,{version:1,skill_name:p.skill_name,sha256:p.sha256,source:p.source},db);
   results.push({id,name:p.name,skill_name:p.skill_name,created:true,published_version:1,version_id:versionId});
  }
  return {personas:results,group_bindings_changed:false};
 });
}
