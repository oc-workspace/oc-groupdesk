import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import type pg from 'pg';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition,HttpError} from './security.js';
import {textMatchesAny} from '../shared/conversation.js';

export const materialRoot=()=>resolve(process.env.DATA_DIR||'data','persona');
const short=z.string().max(500).min(1);
const recordSchema=z.object({id:short,group_id:short.optional(),sender_id:short,
 sender_display_name:z.string().max(500).nullable().optional(),timestamp:z.number().int().min(0).max(4102444800),
 authored_text:z.string().max(200000).nullable().optional(),quoted_context:z.record(z.string(),z.unknown()).nullable().optional(),
 shared_content:z.record(z.string(),z.unknown()).nullable().optional(),message_type:z.string().max(50).optional(),
 content_status:z.string().max(80).optional(),source:z.record(z.string(),z.unknown()).optional(),source_payload_sha256:z.string().max(100).optional()});
export function parseMaterial(buffer:Buffer,format:string,name:string,externalGroup?:string|null){
 const input=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');
 const unique=new Map<string,any>();
 if(format==='jsonl'){
  requireCondition(externalGroup,400,'聊天 JSONL 请导入已绑定真实群 ID 的素材库');
  for(const line of input.split('\n')){
   if(!line.trim())continue;
   let value;try{value=JSON.parse(line);}catch{throw new Error('JSONL 格式错误，请检查文件');}
   const r=recordSchema.parse(value);
   requireCondition(!externalGroup||r.group_id===externalGroup,400,'素材群 ID 与素材库绑定不符，整次导入已取消');
   const normalized={source_id:r.id,sender_id:r.sender_id,sender_name:r.sender_display_name||r.sender_id,timestamp:r.timestamp,
    authored_text:r.authored_text??null,quoted_context:r.quoted_context??null,shared_content:r.shared_content??null,
    kind:r.message_type||'unknown',content_status:r.content_status||'imported',source:{...(r.source||{}),payload_sha256:r.source_payload_sha256||null}};
   const hash=digest(JSON.stringify(normalized));
   requireCondition(!unique.has(r.id)||unique.get(r.id).content_hash===hash,400,'同一文件内出现冲突来源 ID，整次导入已取消');
   unique.set(r.id,{...normalized,content_hash:hash});
   requireCondition(unique.size<=200000,400,'单次最多导入 20 万条记录，请分批上传');
  }
 }else{
  requireCondition(input.trim()&&input.length<=500000,400,'资料须含文字，且不超过 50 万字');
  const r={source_id:'document:'+digest(name),sender_id:'__reference__',sender_name:'参考资料',timestamp:0,
   authored_text:input,quoted_context:null,shared_content:null,kind:'document',content_status:'text_document',source:{name}};
  unique.set(r.source_id,{...r,content_hash:digest(JSON.stringify(r))});
 }
 requireCondition(unique.size,400,'文件中没有可导入的记录');
 return [...unique.values()];
}
export async function importMaterial(collectionId:string,buffer:Buffer,name:string,format:string,actor='operator'){
 const collection=(await pool.query('SELECT * FROM persona_collections WHERE id=$1',[collectionId])).rows[0];
 requireCondition(collection,404,'素材库不存在');
 const hash=createHash('sha256').update(buffer).digest('hex');
 const prior=(await pool.query('SELECT * FROM persona_imports WHERE collection_id=$1 AND sha256=$2',[collectionId,hash])).rows[0];
 if(prior)return {...prior,reused:true};
 let decoded=buffer;
 if(format==='pdf'){
  requireCondition(buffer.subarray(0,5).toString()==='%PDF-',400,'文件不是有效 PDF');
  const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data:buffer});
  try{decoded=Buffer.from((await parser.getText()).text);}finally{await parser.destroy();}
 }
 let sourceGroup=collection.source_group_id;
 if(format==='jsonl'){
  requireCondition(collection.group_id,400,'聊天 JSONL 请导入已选择来源群的素材库');
  if(!sourceGroup){
   try{const first=new TextDecoder('utf-8',{fatal:true}).decode(decoded).replace(/^\uFEFF/,'').split('\n').find(l=>l.trim());sourceGroup=short.parse(JSON.parse(first||'{}').group_id);}
   catch{throw new HttpError(400,'JSONL 缺少有效的来源群 ID');}
  }
 }
 let rows;try{rows=parseMaterial(decoded,format,name,sourceGroup);}catch(e){
  if(e instanceof z.ZodError)throw new Error('JSONL 记录字段无效，请使用标准导出格式');
  if(e instanceof TypeError)throw new Error('文件不是有效 UTF-8 文本');throw e;
 }
 const id=randomUUID(),filename=id+'.source';await mkdir(materialRoot(),{recursive:true,mode:0o700});
 await writeFile(resolve(materialRoot(),filename),buffer,{mode:0o600,flag:'wx'});
 try{return await transaction(async db=>{
  const locked=(await db.query('SELECT source_group_id FROM persona_collections WHERE id=$1 FOR UPDATE',[collectionId])).rows[0];
  if(format==='jsonl'){requireCondition(!locked.source_group_id||locked.source_group_id===sourceGroup,409,'素材库来源群已变化，请重新导入');if(!locked.source_group_id)await db.query('UPDATE persona_collections SET source_group_id=$1 WHERE id=$2',[sourceGroup,collectionId]);}
  const duplicate=(await db.query('SELECT * FROM persona_imports WHERE collection_id=$1 AND sha256=$2',[collectionId,hash])).rows[0];
  if(duplicate){await unlink(resolve(materialRoot(),filename));return {...duplicate,reused:true};}
  const old=new Map((await db.query('SELECT source_id,content_hash FROM persona_materials WHERE collection_id=$1',[collectionId])).rows.map(r=>[r.source_id,r.content_hash]));
  const added=rows.filter(r=>!old.has(r.source_id)).length,updated=rows.filter(r=>old.has(r.source_id)&&old.get(r.source_id)!==r.content_hash).length;
  const result=(await db.query('INSERT INTO persona_imports(id,collection_id,name,format,sha256,filename,added,updated,unchanged) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,collectionId,name,format,hash,filename,added,updated,rows.length-added-updated])).rows[0];
  for(let i=0;i<rows.length;i+=500)await db.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,quoted_context,shared_content,kind,content_status,source,content_hash,import_id)
   SELECT $1,r.source_id,r.sender_id,r.sender_name,r.timestamp,r.authored_text,r.quoted_context,r.shared_content,r.kind,r.content_status,r.source,r.content_hash,$2
   FROM jsonb_to_recordset($3::jsonb) r(source_id text,sender_id text,sender_name text,timestamp bigint,authored_text text,quoted_context jsonb,shared_content jsonb,kind text,content_status text,source jsonb,content_hash text)
   ON CONFLICT(collection_id,source_id) DO UPDATE SET sender_id=excluded.sender_id,sender_name=excluded.sender_name,timestamp=excluded.timestamp,authored_text=excluded.authored_text,quoted_context=excluded.quoted_context,shared_content=excluded.shared_content,kind=excluded.kind,content_status=excluded.content_status,source=excluded.source,content_hash=excluded.content_hash,import_id=excluded.import_id
   WHERE persona_materials.content_hash<>excluded.content_hash`,[collectionId,id,JSON.stringify(rows.slice(i,i+500))]);
  await audit(actor,'persona.material_imported',collectionId,{added,updated,unchanged:result.unchanged},db);return result;
 });}catch(e){await unlink(resolve(materialRoot(),filename)).catch(()=>{});throw e;}
}
export const datasetBody=z.object({name:z.string().trim().min(1).max(120),collection_id:z.uuid(),sender_ids:z.array(short).max(500).default([]),contains_any:z.array(z.string().trim().min(1).max(100)).max(30).default([]),since:z.number().int().min(0).nullable().default(null),until_time:z.number().int().min(0).nullable().default(null)}).refine(v=>v.since===null||v.until_time===null||v.since<=v.until_time,'时间范围无效');
export async function datasetRecords(datasetId:string,db:Pick<pg.PoolClient,'query'>=pool,includeExcluded=false){
 const d=(await db.query('SELECT d.*,c.source_group_id FROM persona_datasets d JOIN persona_collections c ON c.id=d.collection_id WHERE d.id=$1',[datasetId])).rows[0];requireCondition(d,404,'数据集不存在');
 const rows=(await db.query(`SELECT * FROM persona_materials WHERE collection_id=$1 AND (cardinality($2::text[])=0 OR sender_id=ANY($2::text[])) AND ($3::bigint IS NULL OR timestamp>=$3) AND ($4::bigint IS NULL OR timestamp<=$4) ${includeExcluded?'':'AND NOT excluded'} ORDER BY timestamp,source_id`,[d.collection_id,d.sender_ids,d.since,d.until_time])).rows;
 return {dataset:d,rows:rows.filter(r=>textMatchesAny(r.authored_text||'',d.contains_any||[]))};
}
export async function materialOverview(){
 return {collections:(await pool.query(`SELECT c.*,count(m.source_id)::int message_count,count(m.source_id) FILTER(WHERE m.authored_text IS NOT NULL AND m.authored_text<>'')::int text_count,count(DISTINCT m.sender_id)::int sender_count,min(NULLIF(m.timestamp,0)) first_timestamp,max(m.timestamp) last_timestamp FROM persona_collections c LEFT JOIN persona_materials m ON m.collection_id=c.id GROUP BY c.id ORDER BY c.created_at`)).rows,
 datasets:(await pool.query('SELECT * FROM persona_datasets ORDER BY created_at')).rows,
 imports:(await pool.query('SELECT id,collection_id,name,format,sha256,added,updated,unchanged,created_at FROM persona_imports ORDER BY created_at DESC LIMIT 100')).rows};
}
export async function readJobInput(filename:string){return JSON.parse(await readFile(resolve(materialRoot(),filename),'utf8'));}
