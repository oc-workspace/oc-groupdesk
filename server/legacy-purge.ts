// Frozen business-table allowlist. Never drop the control DB, its schema, or use CASCADE.
import type pg from 'pg';
import {lstat,realpath,unlink} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {controlPool} from './db.js';
import {digest,requireCondition} from './security.js';
import {sqlIdentifier} from './bot-provisioning.js';
export const legacyBusinessTables=[
 'topics','knowledge_bases','groups','group_topics','group_knowledge','documents','chunks','memberships','dm_scenes',
 'persona_collections','persona_imports','persona_materials','persona_datasets','personas','persona_versions','persona_jobs',
 'conversation_jobs','conversation_labels','persona_resource_previews','persona_resource_imports','group_persona_features',
 'summary_settings','summary_schedules','summary_jobs','summary_parts','summary_source_batches',
 'interaction_definitions','interaction_settings','group_interactions','interaction_wallets','interaction_daily_checkins','interaction_prizes',
 'interaction_events','interaction_redemptions','interaction_ledger','interaction_daily_usage','interaction_templates',
 'runtime_notifications','runtime_adapters','group_onboarding_jobs','group_onboarding_bindings','group_onboarding_agent','credential_models','model_credentials'
];
type Db=Pick<pg.PoolClient,'query'>;
export type LegacyFile={root:'uploads'|'persona';name:string;inode:string;device:string;bytes:number;mtime:number;present:boolean};
async function fileInfo(root:LegacyFile['root'],name:string):Promise<LegacyFile>{
 requireCondition(name===basename(name)&&/^[a-f0-9-]{36}\.[A-Za-z0-9.]+$/.test(name),409,'旧资料文件名不符合已登记格式，保留待核对');
 const base=resolve(process.env.DATA_DIR||'data'),dir=resolve(base,root),path=resolve(dir,name);
 for(const p of [base,dir]){try{const s=await lstat(p);requireCondition(s.isDirectory()&&!s.isSymbolicLink()&&await realpath(p)===p,409,'旧资料根目录存在路径跳转');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 try{const s=await lstat(path);requireCondition(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,409,'旧资料有共享硬链接或异常路径，保留待核对');return {root,name,inode:String(s.ino),device:String(s.dev),bytes:s.size,mtime:s.mtimeMs,present:true};}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;return {root,name,inode:'',device:'',bytes:0,mtime:0,present:false};}
}
export async function legacyDataPlan(owner:string,db:Db=controlPool){
 const blockers:string[]=[];
 if((await db.query('SELECT 1 FROM model_credentials WHERE vault_key_id IS NULL LIMIT 1')).rowCount)blockers.push('旧API凭据尚未迁移到独立Key管理，业务资料保留以免丢失用户Key');
 for(const t of ['topics','personas'])if((await db.query('SELECT 1 FROM '+t+" WHERE visibility<>'private' OR created_by_user_id IS DISTINCT FROM $1 LIMIT 1",[owner])).rowCount)blockers.push('包含共享或其他作者的话题/人设；业务数据及资料整体保留，请先处理资源归属');
 if((await db.query('SELECT 1 FROM groups WHERE created_by_user_id IS DISTINCT FROM $1 LIMIT 1',[owner])).rowCount)blockers.push('包含其他作者的群配置，业务空间保留');
 // An unknown referencing table must prevent TRUNCATE, never be pulled in by CASCADE.
 if((await db.query("SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(SELECT to_regclass('public.'||unnest($1::text[]))) LIMIT 1",[legacyBusinessTables])).rowCount)blockers.push('业务表含未审核触发器，保留待核对');
 const outside=(await db.query("SELECT DISTINCT conrelid::regclass::text name FROM pg_constraint WHERE contype='f' AND confrelid=ANY(SELECT to_regclass('public.'||unnest($1::text[]))) AND NOT conrelid=ANY(SELECT to_regclass('public.'||unnest($1::text[])))",[legacyBusinessTables])).rows;
 if(outside.length)blockers.push('发现清单外的数据库引用，保留待核对：'+outside.map(r=>r.name).join('、'));
 const tables=[];
 for(const t of legacyBusinessTables){const x=(await db.query('SELECT count(*)::int count FROM '+sqlIdentifier(t))).rows[0];tables.push({table:t,count:x.count});}
 const identity=(await db.query("SELECT id::text,revision,created_by_user_id::text,visibility FROM topics UNION ALL SELECT id::text,revision,created_by_user_id::text,visibility FROM personas ORDER BY 1")).rows;
 const materialsSignature=(await db.query("SELECT md5(COALESCE(string_agg(collection_id::text||':'||source_id||':'||content_hash,',' ORDER BY collection_id,source_id),'')) s FROM persona_materials")).rows[0].s;
 const groups=(await db.query('SELECT id,revision,created_by_user_id FROM groups ORDER BY id')).rows;
 const refs=[...(await db.query('SELECT filename name FROM documents WHERE filename IS NOT NULL')).rows.map(r=>({root:'uploads' as const,name:r.name})),...(await db.query('SELECT filename name FROM persona_imports UNION SELECT input_file name FROM persona_jobs')).rows.map(r=>({root:'persona' as const,name:r.name}))];
 const files:LegacyFile[]=[];const seen=new Set<string>();
 for(const r of refs){if(seen.has(r.root+'/'+r.name))continue;seen.add(r.root+'/'+r.name);try{files.push(await fileInfo(r.root,r.name));}catch(e){blockers.push((e as Error).message);}}
 const bytes=Number((await db.query("SELECT COALESCE(sum(pg_total_relation_size(to_regclass('public.'||t))),0)::text bytes FROM unnest($1::text[]) t",[legacyBusinessTables])).rows[0].bytes);
 return {kind:'legacy',eligible:!blockers.length,blockers:[...new Set(blockers)],tables,files,bytes,file_bytes:files.reduce((n,f)=>n+f.bytes,0),fingerprint:digest(JSON.stringify({tables,identity,groups,files,materialsSignature}))};
}
export async function clearLegacyRows(db:pg.PoolClient,plan:Awaited<ReturnType<typeof legacyDataPlan>>,owner:string,jobId?:string){
 await db.query('BEGIN');try{
  await db.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='90s'");
  await db.query('LOCK TABLE '+legacyBusinessTables.map(sqlIdentifier).join(',')+' IN ACCESS EXCLUSIVE MODE');
  const fresh=await legacyDataPlan(owner,db);requireCondition(fresh.eligible&&fresh.fingerprint===plan.fingerprint,409,'旧业务或文件范围已变化，未清理');
  await db.query('TRUNCATE TABLE '+legacyBusinessTables.map(sqlIdentifier).join(',')+' RESTRICT');
  await db.query("UPDATE model_settings SET routes='{}',revision=revision+1");
  const role='gdr_00000000000040008000000000000001';
  const r=(await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  requireCondition(!r||!Object.values(r).some(Boolean),409,'原账号数据库角色异常，保留待核对');
  if(r)await db.query('ALTER ROLE '+sqlIdentifier(role)+' NOLOGIN');
  const after=Number((await db.query("SELECT COALESCE(sum(pg_total_relation_size(to_regclass('public.'||t))),0)::text bytes FROM unnest($1::text[]) t",[legacyBusinessTables])).rows[0].bytes);
  if(jobId)await db.query("UPDATE managed_bot_purges SET phase='database_removed',receipt=receipt||$2::jsonb,updated_at=now() WHERE id=$1",[jobId,JSON.stringify({database_bytes_reclaimed:Math.max(0,plan.bytes-after)})]);
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}
}
export async function clearLegacyFiles(files:LegacyFile[]){
 let bytes=0;
 for(const f of files){const fresh=await fileInfo(f.root,f.name);if(!fresh.present)continue;
  requireCondition(f.present&&fresh.inode===f.inode&&fresh.device===f.device&&fresh.bytes===f.bytes&&fresh.mtime===f.mtime,409,'旧资料文件已被替换，保留待核对');
  await unlink(resolve(process.env.DATA_DIR||'data',f.root,f.name));bytes+=f.bytes;
 }
 return bytes;
}
