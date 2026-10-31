import type express from 'express';
import multer from 'multer';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition,HttpError} from './security.js';
import {importMaterial,materialOverview,datasetBody,datasetRecords,materialRoot} from './persona-materials.js';
import {makeSkill,skillName,validateSkill,queuePersonaJob} from './persona-generation.js';

const uuid=(v:unknown)=>z.uuid().parse(v);
const revision=z.number().int().positive();
const personaBody=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().max(500),goal:z.string().trim().max(3000),dataset_ids:z.array(z.uuid()).max(20),draft_skill:z.string().max(30000)});
export async function runtimePersona(versionId:string|null,db:Pick<typeof pool,'query'>=pool){
 if(!versionId)return null;
 const r=(await db.query('SELECT v.id version_id,v.persona_id,p.name,v.version,v.skill_md,v.sha256 FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE v.id=$1',[versionId])).rows[0];
 requireCondition(r,409,'所选 Persona 发布版本不存在');return r;
}
// A portable skill package needs no executable archive utility or extra dependency.
export function skillArchive(name:string,skill:string,provenance:unknown){
 skillName.parse(name);const blocks:Buffer[]=[];
 for(const [file,content] of [['SKILL.md',skill],['references/provenance.json',JSON.stringify(provenance,null,2)+'\n']]){
  const path=name+'/'+file,data=Buffer.from(content),header=Buffer.alloc(512);
  header.write(path,0,100);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=48;
  header.write('ustar\0',257);header.write('00',263);
  const sum=header.reduce((s,n)=>s+n,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  blocks.push(header,data,Buffer.alloc((512-data.length%512)%512));
 }
 return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
export function registerPersonaAdmin(app:express.Express){
 app.get('/api/persona-studio',async(_req,res)=>{
  res.json({...await materialOverview(),personas:(await pool.query(`SELECT p.id,p.name,p.skill_name,p.description,p.revision,p.archived,p.created_at,(SELECT max(version) FROM persona_versions WHERE persona_id=p.id) published_version FROM personas p ORDER BY p.created_at`)).rows,
   versions:(await pool.query('SELECT id,persona_id,version FROM persona_versions ORDER BY version DESC')).rows,
   bindings:(await pool.query('SELECT g.id group_id,g.name group_name,g.revision,g.applied_revision,g.persona_version_id,v.persona_id,v.version FROM groups g LEFT JOIN persona_versions v ON v.id=g.persona_version_id ORDER BY g.name')).rows});
 });
 app.post('/api/persona-collections',async(req,res)=>{
  const b=z.object({name:z.string().trim().min(1).max(120),group_id:z.uuid().nullable().default(null)}).parse(req.body),id=randomUUID();
  const g=b.group_id?(await pool.query('SELECT external_id FROM groups WHERE id=$1',[b.group_id])).rows[0]:null;
  requireCondition(!b.group_id||g,404,'群不存在');
  requireCondition(!b.group_id||g?.external_id,400,'请先在群管理绑定微信真实群 ID');
  await pool.query('INSERT INTO persona_collections(id,name,group_id,external_group_id) VALUES($1,$2,$3,$4)',[id,b.name,b.group_id,g?.external_id||null]);
  await audit(req.admin!.username,'persona.collection_created',id);res.status(201).json({id});
 });
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:100*1024*1024,files:1,fields:1}});
 app.post('/api/persona-collections/:id/import',(req,res,next)=>upload.single('file')(req,res,e=>e?next(new HttpError(400,'素材文件不能超过 100 MB，且一次只上传一个文件')):next()),async(req,res)=>{
  requireCondition(req.file,400,'请选择素材文件');
  const name=req.file.originalname.replace(/[\r\n\0]/g,'').slice(0,180),format=name.split('.').pop()?.toLowerCase()||'';
  requireCondition(['jsonl','txt','md','pdf'].includes(format),400,'支持 JSONL、TXT、Markdown 和文字型 PDF');
  try{res.json(await importMaterial(uuid(req.params.id),req.file.buffer,name,format,req.admin!.username));}
  catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,e instanceof Error&&/^(JSONL|文件不是|同一文件)/.test(e.message)?e.message:'素材解析失败，请检查格式、编码或 PDF 是否含文字');}
 });
 app.get('/api/persona-collections/:id/senders',async(req,res)=>{
  res.json((await pool.query('SELECT sender_id,max(sender_name) sender_name,count(*)::int count,count(*) FILTER(WHERE NOT excluded AND authored_text IS NOT NULL AND authored_text<>\'\')::int text_count FROM persona_materials WHERE collection_id=$1 GROUP BY sender_id ORDER BY count(*) DESC,sender_id',[uuid(req.params.id)])).rows);
 });
 app.get('/api/persona-collections/:id/messages',async(req,res)=>{
  const b=z.object({sender:z.string().max(500).default(''),query:z.string().max(200).default(''),offset:z.coerce.number().int().min(0).max(200000).default(0)}).parse(req.query);
  const rows=(await pool.query(`SELECT source_id,sender_id,sender_name,timestamp,authored_text,kind,content_status,excluded,quoted_context,shared_content FROM persona_materials WHERE collection_id=$1 AND ($2='' OR sender_id=$2) AND ($3='' OR strpos(lower(COALESCE(authored_text,'')),lower($3))>0) ORDER BY timestamp,source_id LIMIT 50 OFFSET $4`,[uuid(req.params.id),b.sender,b.query,b.offset])).rows;res.json(rows);
 });
 app.post('/api/persona-collections/:id/exclusion',async(req,res)=>{
  const b=z.object({source_id:z.string().max(500),excluded:z.boolean()}).parse(req.body);
  const r=await pool.query('UPDATE persona_materials SET excluded=$1 WHERE collection_id=$2 AND source_id=$3',[b.excluded,uuid(req.params.id),b.source_id]);requireCondition(r.rowCount,404,'素材记录不存在');
  await audit(req.admin!.username,'persona.material_curated',String(req.params.id),{excluded:b.excluded});res.json({ok:true});
 });
 app.get('/api/persona-imports/:id/download',async(req,res)=>{
  const r=(await pool.query('SELECT name,filename FROM persona_imports WHERE id=$1',[uuid(req.params.id)])).rows[0];requireCondition(r,404,'导入存档不存在');
  res.attachment(r.name).send(await readFile(resolve(materialRoot(),r.filename)));
 });
 app.post('/api/persona-datasets',async(req,res)=>{
  const b=datasetBody.parse(req.body),id=randomUUID();
  await pool.query('INSERT INTO persona_datasets(id,collection_id,name,sender_ids,since,until_time) VALUES($1,$2,$3,$4,$5,$6)',[id,b.collection_id,b.name,b.sender_ids,b.since,b.until_time]);
  await audit(req.admin!.username,'persona.dataset_created',id);res.status(201).json({id});
 });
 app.put('/api/persona-datasets/:id',async(req,res)=>{
  const b=datasetBody.parse(req.body),id=uuid(req.params.id);
  const r=await pool.query('UPDATE persona_datasets SET name=$1,sender_ids=$2,since=$3,until_time=$4 WHERE id=$5 AND collection_id=$6',[b.name,b.sender_ids,b.since,b.until_time,id,b.collection_id]);requireCondition(r.rowCount,409,'数据集不存在或素材库已变化');
  await audit(req.admin!.username,'persona.dataset_updated',id);res.json({ok:true});
 });
 app.get('/api/persona-datasets/:id/export',async(req,res)=>{
  const {dataset,rows}=await datasetRecords(uuid(req.params.id));
  const data=rows.map(r=>JSON.stringify({id:r.source_id,group_id:dataset.external_group_id||undefined,sender_id:r.sender_id,sender_display_name:r.sender_name,timestamp:Number(r.timestamp),authored_text:r.authored_text,quoted_context:r.quoted_context,shared_content:r.shared_content,message_type:r.kind,content_status:r.content_status,source:r.source})).join('\n')+'\n';
  res.type('application/x-ndjson').attachment(dataset.id+'.jsonl').send(data);
 });
 app.post('/api/personas',async(req,res)=>{
  const b=personaBody.omit({draft_skill:true}).extend({skill_name:skillName}).parse(req.body),id=randomUUID();
  await pool.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,b.name,b.skill_name,b.description,b.goal,b.dataset_ids,makeSkill(b.skill_name,b.description||b.name,'# '+b.name+'\n\n在这里编写适用场景、表达方式、语言和边界；也可以先关联素材，再生成待人工修订的草稿。')]);
  await audit(req.admin!.username,'persona.created',id);res.status(201).json({id});
 });
 app.get('/api/personas/:id',async(req,res)=>{
  const id=uuid(req.params.id),p=(await pool.query('SELECT * FROM personas WHERE id=$1',[id])).rows[0];requireCondition(p,404,'Persona 不存在');
  res.json({...p,versions:(await pool.query('SELECT id,version,sha256,created_at,provenance FROM persona_versions WHERE persona_id=$1 ORDER BY version DESC',[id])).rows,
   jobs:(await pool.query('SELECT id,status,model_id,provenance,output_skill,error,created_at,finished_at FROM persona_jobs WHERE persona_id=$1 ORDER BY created_at DESC LIMIT 10',[id])).rows});
 });
 app.put('/api/personas/:id',async(req,res)=>{
  const b=personaBody.extend({revision}).parse(req.body),id=uuid(req.params.id);
  await transaction(async db=>{
   for(const datasetId of b.dataset_ids)requireCondition((await db.query('SELECT 1 FROM persona_datasets WHERE id=$1',[datasetId])).rowCount,400,'关联数据集不存在');
   const r=await db.query('UPDATE personas SET name=$1,description=$2,goal=$3,dataset_ids=$4,draft_skill=$5,revision=revision+1 WHERE id=$6 AND revision=$7 AND NOT archived',[b.name,b.description,b.goal,b.dataset_ids,b.draft_skill,id,b.revision]);requireCondition(r.rowCount,409,'草稿已更新或已归档，请保留本地修改后载入最新版本');
   await audit(req.admin!.username,'persona.draft_saved',id,{},db);
  });res.json({ok:true});
 });
 app.post('/api/personas/:id/publish',async(req,res)=>{
  const id=uuid(req.params.id),b=z.object({revision}).parse(req.body);
  const out=await transaction(async db=>{
   const p=(await db.query('SELECT * FROM personas WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(p&&!p.archived&&p.revision===b.revision,409,'请先保存并载入最新草稿');validateSkill(p.draft_skill,p.skill_name);
   const version=Number((await db.query('SELECT COALESCE(max(version),0)+1 next FROM persona_versions WHERE persona_id=$1',[id])).rows[0].next),versionId=randomUUID();
   await db.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance) VALUES($1,$2,$3,$4,$5,$6)',[versionId,id,version,p.draft_skill,digest(p.draft_skill),p.draft_provenance]);
   await audit(req.admin!.username,'persona.version_published',id,{version},db);return {id:versionId,version};
  });res.status(201).json(out);
 });
 app.post('/api/personas/:id/archive',async(req,res)=>{
  const id=uuid(req.params.id),b=z.object({archived:z.boolean(),revision}).parse(req.body);
  await transaction(async db=>{
   await db.query('SELECT id FROM personas WHERE id=$1 FOR UPDATE',[id]);
   if(b.archived){requireCondition(!(await db.query('SELECT 1 FROM groups g JOIN persona_versions v ON v.id=g.persona_version_id WHERE v.persona_id=$1',[id])).rowCount,409,'请先解除或更换使用此 Persona 的群');
    requireCondition(!(await db.query("SELECT 1 FROM persona_jobs WHERE persona_id=$1 AND status IN ('pending','processing')",[id])).rowCount,409,'生成任务完成后再归档');}
   const r=await db.query('UPDATE personas SET archived=$1,revision=revision+1 WHERE id=$2 AND revision=$3',[b.archived,id,b.revision]);requireCondition(r.rowCount,409,'Persona 版本已变化，请重新载入');
   await audit(req.admin!.username,'persona.archive_changed',id,{archived:b.archived},db);
  });res.json({ok:true});
 });
 app.post('/api/personas/:id/generate',async(req,res)=>{
  const b=z.object({revision,credential_id:z.uuid(),model_id:z.string().max(200)}).parse(req.body);
  res.status(202).json(await queuePersonaJob(uuid(req.params.id),b.revision,b,req.admin!.username));
 });
 app.get('/api/persona-versions/:id',async(req,res)=>res.json(await runtimePersona(uuid(req.params.id))));
 app.get('/api/persona-versions/:id/export',async(req,res)=>{
  const v=(await pool.query('SELECT v.*,p.skill_name FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE v.id=$1',[uuid(req.params.id)])).rows[0];requireCondition(v,404,'版本不存在');
  res.type('application/gzip').attachment(v.skill_name+'-v'+v.version+'.tar.gz').send(skillArchive(v.skill_name,v.skill_md,v.provenance));
 });
 app.put('/api/persona-bindings/:id',async(req,res)=>{
  const b=z.object({revision,version_id:z.uuid().nullable()}).parse(req.body),groupId=uuid(req.params.id);
  await transaction(async db=>{
   if(b.version_id){const v=(await db.query('SELECT p.id,p.archived FROM personas p JOIN persona_versions v ON v.persona_id=p.id WHERE v.id=$1 FOR SHARE OF p',[b.version_id])).rows[0];requireCondition(v&&!v.archived,400,'请先发布 Persona，且不能选择已归档人设');}
   const r=await db.query('UPDATE groups SET persona_version_id=$1,revision=revision+1 WHERE id=$2 AND revision=$3',[b.version_id,groupId,b.revision]);requireCondition(r.rowCount,409,'群配置已变化，请刷新后重新应用');
   await audit(req.admin!.username,'persona.group_bound',groupId,{version_id:b.version_id},db);
  });res.json({ok:true});
 });
}
