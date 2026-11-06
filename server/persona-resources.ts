import type express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {makeSkill,skillName,queuePersonaJob} from './persona-generation.js';
import {materialRoot} from './persona-materials.js';
import {fetchResourceSnapshot,personaResourceCatalog,type ResourceSnapshot,type PublicTextReader} from './persona-resource-source.js';

export async function resourceOverview(){
 const imports=(await pool.query('SELECT resource_id,repository,source_path,source_commit,persona_id,dataset_id,collection_id,created_at FROM persona_resource_imports ORDER BY created_at DESC')).rows;
 const personas=(await pool.query('SELECT id,name,skill_name,archived,draft_provenance FROM personas')).rows;
 return {...personaResourceCatalog,entries:personaResourceCatalog.entries.map(e=>({...e,imports:imports.filter(i=>i.resource_id===e.id),
  similar:personas.filter(p=>e.family==='buffett'?p.skill_name==='buffett-value-persona':e.family==='musk'?p.skill_name==='elon-first-principles-persona':String(p.draft_provenance?.source?.repository||'').replace(/\/$/,'').toLowerCase()===e.url.toLowerCase()).map(({id,name,archived})=>({id,name,archived}))}))};
}
export async function previewResource(id:string,path?:string,reader?:PublicTextReader){
 const snapshot=await fetchResourceSnapshot(id,path,reader),previewId=randomUUID();
 await transaction(async db=>{
  // Preview cache is disposable; imported snapshots are independently archived.
  await db.query("DELETE FROM persona_resource_previews WHERE created_at<now()-interval '1 day' OR id IN (SELECT id FROM persona_resource_previews ORDER BY created_at DESC OFFSET 49)");
  await db.query('INSERT INTO persona_resource_previews(id,resource_id,snapshot) VALUES($1,$2,$3)',[previewId,id,snapshot]);
 });
 return {id:previewId,...snapshot};
}
export const resourceImportBody=z.object({preview_id:z.uuid(),name:z.string().trim().min(1).max(120),skill_name:skillName,
 kind:z.enum(['base','feature','reference']),goal:z.string().trim().max(3000).default(''),allow_variant:z.boolean().default(false),allow_partial:z.boolean().default(false),
 generation:z.object({credential_id:z.uuid(),model_id:z.string().trim().min(1).max(200)}).optional()});
export async function importResource(id:string,body:z.infer<typeof resourceImportBody>,actor:string){
 const entry=personaResourceCatalog.entries.find(e=>e.id===id);requireCondition(entry,404,'资源不存在');
 const preview=(await pool.query("SELECT snapshot FROM persona_resource_previews WHERE id=$1 AND resource_id=$2 AND created_at>now()-interval '1 day'",[body.preview_id,id])).rows[0];
 requireCondition(preview,409,'来源预览已过期或不属于当前机器人，请重新读取');
 const s=preview.snapshot as ResourceSnapshot;
 requireCondition(body.kind==='reference'||entry.resource_type==='persona'&&/(^|\/)SKILL\.md$/i.test(s.path),400,'制作工具或 README 请先保存为参考素材，再在 Persona 编辑器中选择制作目标');
 requireCondition(body.kind==='reference'||!s.omitted.length||body.allow_partial,400,'来源参考资料超过上限，尚未完整读取；请先存为素材，或确认仅按已读资料制作');
 const importId=randomUUID(),collectionId=randomUUID(),datasetId=randomUUID(),personaId=body.kind==='reference'?null:randomUUID(),fileId=randomUUID(),filename=fileId+'.source';
 const raw=JSON.stringify(s,null,2)+'\n';await mkdir(materialRoot(),{recursive:true,mode:0o700});await writeFile(resolve(materialRoot(),filename),raw,{mode:0o600,flag:'wx'});
 let retained=false;
 try{
  const result=await transaction(async db=>{
   // Serializes concurrent/repeated clicks per source, including reference-first imports.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['persona-resource:'+s.repository+'/'+s.path]);
   const existing=(await db.query('SELECT * FROM persona_resource_imports WHERE repository=$1 AND source_path=$2',[s.repository,s.path])).rows[0];
   if(existing)return {id:existing.id,persona_id:existing.persona_id,dataset_id:existing.dataset_id,collection_id:existing.collection_id,reused:true};
   const similarSlug=entry.family==='buffett'?'buffett-value-persona':entry.family==='musk'?'elon-first-principles-persona':'';
   requireCondition(body.kind==='reference'||body.allow_variant||!(await db.query('SELECT 1 FROM personas WHERE skill_name=$1',[similarSlug])).rowCount,409,'已有同类人设；请打开现有内容，或明确选择创建独立变体');
   requireCondition(!personaId||!(await db.query('SELECT 1 FROM personas WHERE skill_name=$1',[body.skill_name])).rowCount,409,'Skill 名称已存在，请使用另一个英文名称');
   const title=entry.name+' · '+importId.slice(0,8);
   await db.query('INSERT INTO persona_collections(id,name) VALUES($1,$2)',[collectionId,title]);
   await db.query("INSERT INTO persona_imports(id,collection_id,name,format,sha256,filename,added,updated,unchanged) VALUES($1,$2,$3,'md',$4,$5,$6,0,0)",[fileId,collectionId,entry.name+'-source.json',digest(raw),filename,s.files.reduce((n,f)=>n+Math.ceil(f.content.length/3500),0)]);
   for(const f of s.files){for(let offset=0;offset<f.content.length;offset+=3500){const content=f.content.slice(offset,offset+3500);
    await db.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,kind,content_status,source,content_hash,import_id)
     VALUES($1,$2,'__reference__','公开来源参考',0,$3,'document','text_document',$4,$5,$6)`,[collectionId,f.path+':'+offset,content,{repository:s.repository,commit:s.commit,path:f.path,offset,sha256:f.sha256},digest(content),fileId]);
   }}
   await db.query('INSERT INTO persona_datasets(id,collection_id,name,sender_ids) VALUES($1,$2,$3,$4)',[datasetId,collectionId,entry.name+' · 公开来源资料',[]]);
   const provenance={method:'public-resource-draft',resource_source:{catalog:personaResourceCatalog.source,catalog_commit:personaResourceCatalog.commit,catalog_entry_origin:entry.origin||'awesome-persona-distill-skills',reviewed_source_commit:entry.reviewed_commit||null,...s},source:{repository:entry.url,commit:s.commit,path:s.path,license:s.license}};
   if(personaId)await db.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [personaId,body.name,body.skill_name,entry.description.slice(0,500),body.goal||'根据公开参考资料提炼可独立使用的表达与思考方式；保留来源许可，删除外部工具依赖。参考人物不是机器人身份，本群称呼和点名配置优先。',[datasetId],makeSkill(body.skill_name,entry.description.slice(0,500),'# '+body.name+'\n\n在这里编写适用场景、表达方式、语言和边界；也可以先关联素材，再生成待人工修订的草稿。'),provenance,body.kind]);
   await db.query('INSERT INTO persona_resource_imports(id,resource_id,repository,source_path,source_commit,source_sha256,snapshot,collection_id,dataset_id,persona_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[importId,id,s.repository,s.path,s.commit,s.sha256,s,collectionId,datasetId,personaId]);
   await audit(actor,'persona.resource_imported',importId,{resource_id:id,persona_id:personaId,dataset_id:datasetId,source_sha256:s.sha256},db);
   return {id:importId,persona_id:personaId,dataset_id:datasetId,collection_id:collectionId,reused:false};
  });
  retained=!result.reused;
  if(result.persona_id&&!result.reused&&body.generation){
   try{return {...result,generation:await queuePersonaJob(result.persona_id,1,body.generation,actor)};}
   catch{return {...result,generation_error:'来源与初始化草稿已保存，AI 制作未能排队；请在编辑器检查模型并点击“制作完整草稿”重试'};}
  }
  return result;
 }finally{if(!retained)await unlink(resolve(materialRoot(),filename)).catch(()=>{});}
}
export function registerPersonaResources(app:express.Express,reader?:PublicTextReader){
 app.get('/api/persona-resources',async(_req,res)=>res.json(await resourceOverview()));
 app.post('/api/persona-resources/:id/preview',async(req,res)=>{
  const b=z.object({path:z.string().min(1).max(500).optional()}).parse(req.body);res.json(await previewResource(String(req.params.id),b.path,reader));
 });
 app.post('/api/persona-resources/:id/import',async(req,res)=>res.json(await importResource(String(req.params.id),resourceImportBody.parse(req.body),req.admin!.username)));
}
