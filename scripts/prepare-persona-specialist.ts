/** stdin carries operator-selected private IDs; no materials or credentials leave this process. */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,audit} from '../server/db.js';
import {makeSkill,validateSkill,skillName,queuePersonaJob} from '../server/persona-generation.js';
import {datasetRecords} from '../server/persona-materials.js';
import {effectiveModelRoutes} from '../server/models.js';
import {requireCondition,digest,HttpError} from '../server/security.js';
try{
 const b=z.object({collection_id:z.uuid(),sender_id:z.string().min(1).max(500),contains_any:z.array(z.string().min(1).max(100)).min(1).max(30),dataset_name:z.string().min(1).max(120),base_persona_id:z.uuid(),persona_name:z.string().min(1).max(120),skill_name:skillName,goal:z.string().min(1).max(3000)}).parse(JSON.parse(await readFile('/dev/stdin','utf8')));
 const result=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511946)');
  const c=(await db.query('SELECT * FROM persona_collections WHERE id=$1 FOR SHARE',[b.collection_id])).rows[0];requireCondition(c?.group_id,400,'须选择真实群的聊天素材库');
  const base=(await db.query('SELECT * FROM personas WHERE id=$1 AND NOT archived',[b.base_persona_id])).rows[0];requireCondition(base,404,'基础 Persona 不存在');
  requireCondition((await db.query('SELECT 1 FROM persona_materials WHERE collection_id=$1 AND sender_id=$2 LIMIT 1',[c.id,b.sender_id])).rowCount,400,'该素材库没有指定发言人');
  const old=(await db.query('SELECT id FROM personas WHERE skill_name=$1',[b.skill_name])).rows[0];
  if(old)return {id:old.id,reused:true};
  const datasetId=randomUUID();
  await db.query('INSERT INTO persona_datasets(id,collection_id,name,sender_ids,contains_any) VALUES($1,$2,$3,$4,$5)',[datasetId,c.id,b.dataset_name,[b.sender_id],b.contains_any]);
  const {rows}=await datasetRecords(datasetId,db);requireCondition(rows.some(r=>r.authored_text?.trim()),400,'筛选后没有可读正文');
  const id=randomUUID(),skill=makeSkill(b.skill_name,'基于已存档互动归纳的专项表达草稿，须人工核对后再发布',validateSkill(base.draft_skill,base.skill_name));
  await db.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,b.persona_name,b.skill_name,'专项接梗表达；不将历史玩笑当作人物事实',b.goal,[datasetId],skill,{base_persona_id:base.id,base_revision:base.revision,base_sha256:digest(base.draft_skill),source:'operator-selected archived authored text; draft only'}]);
  await audit('operator','persona.specialist_prepared',id,{dataset_id:datasetId,matched:rows.length},db);
  return {id,dataset_id:datasetId,matched:rows.length,revision:1,group_id:c.group_id,reused:false};
 });
 if(!result.reused){
  const group=(await pool.query('SELECT * FROM groups WHERE id=$1',[result.group_id])).rows[0],route=(await effectiveModelRoutes(group)).text as any;
  requireCondition(route?.available,400,'本群文字模型不可用；素材和草稿已保存，可在网页重新选择生成模型');
  const job=await queuePersonaJob(result.id,result.revision!,route,'operator');
  console.log(JSON.stringify({...result,job_id:job.id,sampled:job.provenance.sampled_records,model_id:route.model_id,draft_only:true}));
 }else console.log(JSON.stringify({...result,draft_only:true}));
}catch(e){console.error(e instanceof HttpError?e.message:'专项 Persona 制作失败；请检查所选素材及已有草稿');process.exitCode=1;}
finally{await pool.end();}
