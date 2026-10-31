import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,audit} from '../server/db.js';
import {digest,requireCondition,HttpError} from '../server/security.js';
import {validateSkill,skillName} from '../server/persona-generation.js';
import {importMaterial} from '../server/persona-materials.js';
const body=z.object({group_name:z.string().max(120),collection_name:z.string().max(120),sender_id:z.string().max(500),persona_name:z.string().max(120),skill_name:skillName,skill_md:z.string().max(30000),description:z.string().max(500),reference_files:z.record(z.string(),z.string().max(500000)).default({})});
try{
 const b=body.parse(JSON.parse(await readFile('/dev/stdin','utf8')));validateSkill(b.skill_md,b.skill_name);
 const out=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(78511945)');
  const group=(await db.query('SELECT id,external_id FROM groups WHERE name=$1',[b.group_name])).rows;
  requireCondition(group.length===1&&group[0].external_id,400,'来源群不唯一或没有真实群 ID');
  async function collection(name:string,g:any=null){
   const old=(await db.query('SELECT * FROM persona_collections WHERE name=$1',[name])).rows[0];
   if(old){requireCondition(old.group_id===(g?.id||null),409,'同名素材库绑定不同');return old.id;}
   const id=randomUUID();await db.query('INSERT INTO persona_collections(id,name,group_id,external_group_id) VALUES($1,$2,$3,$4)',[id,name,g?.id||null,g?.external_id||null]);return id;
  }
  const archive=await collection(b.collection_name,group[0]),refs=await collection(b.persona_name+' · 原有 Skill 资料');
  async function dataset(collectionId:string,name:string,senders:string[]){
   const old=(await db.query('SELECT id FROM persona_datasets WHERE collection_id=$1 AND name=$2',[collectionId,name])).rows[0];if(old)return old.id;
   const id=randomUUID();await db.query('INSERT INTO persona_datasets(id,collection_id,name,sender_ids) VALUES($1,$2,$3,$4)',[id,collectionId,name,senders]);return id;
  }
  const gt=await dataset(archive,b.persona_name+' · 本人发言',[b.sender_id]);
  const all=await dataset(archive,b.group_name+' · 全群历史',[]);
  const reference=await dataset(refs,b.persona_name+' · 旧 Skill 参考资料',[]);
  let p=(await db.query('SELECT id FROM personas WHERE skill_name=$1',[b.skill_name])).rows[0];
  if(!p){p={id:randomUUID()};
   const provenance={source:'导入既有私有 GT Persona 运行规则，未重新调用模型',reference_files:Object.fromEntries(Object.entries(b.reference_files).map(([k,v])=>[k,digest(v)]))};
   await db.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,b.persona_name,b.skill_name,b.description,'在既有 GT 风格上，依据新增发言维护表达规则；保留人工修饰，核对观点与素材来源',[gt,reference],b.skill_md,provenance]);
   await db.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance) VALUES($1,$2,1,$3,$4,$5)',[randomUUID(),p.id,b.skill_md,digest(b.skill_md),provenance]);
  }
  await audit('operator','persona.existing_imported',p.id,{},db);
  return {collection_id:archive,reference_collection_id:refs,gt_dataset_id:gt,all_dataset_id:all,persona_id:p.id};
 });
 for(const [name,text] of Object.entries(b.reference_files))await importMaterial(out.reference_collection_id,Buffer.from(text),name,'md');
 console.log(JSON.stringify(out));
}catch(e){console.error(e instanceof HttpError?e.message:'既有 Persona 导入失败；未覆盖已有草稿或群人设');process.exitCode=1;}
finally{await pool.end();}
