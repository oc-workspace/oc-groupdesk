import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {pool,transaction,audit} from './db.js';
import {requireCondition,HttpError,digest} from './security.js';
import {sealKey,openKey,baseUrl,fetchCatalog} from './model-security.js';

export const modelId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,199}$/,'模型 ID 格式无效');
export const keyValue=z.string().regex(/^[!-~]{8,500}$/,'API Key 应为不含空白的密钥');
export const selection=z.object({credential_id:z.uuid(),model_id:modelId});
export const groupRoute=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('inherit')}),z.object({mode:z.literal('disabled')}),
  selection.extend({mode:z.literal('custom')})
]);
export const groupRoutes=z.object({text:groupRoute,image:groupRoute});
export const defaultRoutes=z.object({text:selection.nullable(),image:selection.nullable()});
export type Routes=z.infer<typeof groupRoutes>;
type Db=Pick<pg.PoolClient,'query'>;
export function inferCapability(id:string):'text'|'image'|'other'|'unknown'{
  if(/video|embedding|whisper|tts|audio|rerank/i.test(id))return 'other';
  if(/image|dall-e|flux|stable-diffusion|sdxl/i.test(id))return 'image';
  if(/imagine/i.test(id))return 'unknown';
  return 'text';
}
export function parseCatalog(value:unknown){
  const result=z.object({data:z.array(z.object({id:modelId,display_name:z.string().max(200).optional()})).max(5000)}).safeParse(value);
  requireCondition(result.success,502,'服务返回的模型目录格式无效，已保留原目录');
  return [...new Map(result.data.data.map(m=>[m.id,{id:m.id,name:m.display_name||m.id,capability:inferCapability(m.id)}])).values()];
}
export async function modelOverview(db:Db=pool){
  const credentials=(await db.query('SELECT id,name,base_url,key_hint,enabled,revision,catalog_synced_at,catalog_error FROM model_credentials ORDER BY created_at,id')).rows;
  const models=(await db.query('SELECT credential_id,model_id,display_name,capability,source,listed FROM credential_models ORDER BY model_id')).rows;
  return {credentials:credentials.map(c=>({...c,models:models.filter(m=>m.credential_id===c.id)})),defaults:(await db.query('SELECT revision,routes FROM model_settings WHERE singleton=true')).rows[0]};
}
export async function validateSelection(route:z.infer<typeof selection>|null,kind:'text'|'image',db:Db=pool){
  if(!route)return;
  const row=(await db.query('SELECT c.enabled,m.capability FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id WHERE c.id=$1 AND m.model_id=$2',[route.credential_id,route.model_id])).rows[0];
  requireCondition(row?.enabled,400,'请选择已启用的 API Key 和已登记模型');
  requireCondition(row.capability===kind,400,'所选模型的功能类型不匹配');
}
export async function validateRoutes(routes:Routes,db:Db){
  for(const kind of ['text','image'] as const)if(routes[kind].mode==='custom')await validateSelection(routes[kind] as z.infer<typeof selection>,kind,db);
}
export async function effectiveModelRoutes(group:{model_routes:Routes},db:Db=pool){
  const defaults=(await db.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes;
  const result:Record<string,unknown>={};
  for(const kind of ['text','image'] as const){
    const configured=group.model_routes[kind],route=configured.mode==='custom'?configured:configured.mode==='inherit'?defaults[kind]:null;
    const source=configured.mode==='disabled'?'disabled':route?(configured.mode==='inherit'?'default':'group'):kind==='text'&&configured.mode==='inherit'?'legacy':'disabled';
    const row=route?(await db.query('SELECT c.id credential_id,c.name,c.enabled,c.revision credential_revision,m.model_id,m.capability FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id WHERE c.id=$1 AND m.model_id=$2',[route.credential_id,route.model_id])).rows[0]:null;
    result[kind]={source,...(row||{}),available:!!row?.enabled&&row.capability===kind};
  }
  return result;
}
export async function privateTextRoute(group:{id:string;model_routes:Routes},db:Db=pool){
  const routes=await effectiveModelRoutes(group,db),route=routes.text as any;
  if(route.source==='legacy')return null;
  requireCondition(route.source!=='disabled'&&route.available,409,'本群文字模型已停用或不可用');
  const credential=(await db.query('SELECT base_url,key_ciphertext FROM model_credentials WHERE id=$1',[route.credential_id])).rows[0];
  return {...route,base_url:credential.base_url,api_key:openKey(credential.key_ciphertext),client_type:'openai'};
}
export async function createCredential(input:{name:string;base_url:string;api_key:string},actor:string){
  keyValue.parse(input.api_key);
  const credentialId=randomUUID(),endpoint=baseUrl(input.base_url),cipher=sealKey(input.api_key),hint='••••'+input.api_key.slice(-4);
  await transaction(async db=>{
    await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest) VALUES($1,$2,$3,$4,$5,$6)',[credentialId,input.name,endpoint,cipher,hint,digest(input.api_key)]);
    await audit(actor,'model.credential_created',credentialId,{},db);
  });return credentialId;
}
export async function refreshCatalog(credentialId:string,actor:string,fetcher=fetchCatalog){
  const credential=(await pool.query('SELECT * FROM model_credentials WHERE id=$1',[credentialId])).rows[0];
  requireCondition(credential?.enabled,400,'请先启用 API Key');
  try{
    const models=parseCatalog(await fetcher(credential.base_url,openKey(credential.key_ciphertext)));
    await transaction(async db=>{
      const current=(await db.query('SELECT revision FROM model_credentials WHERE id=$1 FOR UPDATE',[credentialId])).rows[0];
      requireCondition(current?.revision===credential.revision,409,'API Key 已更新，请重新查询模型目录');
      await db.query('UPDATE credential_models SET listed=false WHERE credential_id=$1',[credentialId]);
      for(const m of models)await db.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,$2,$3,$4,'catalog',true) ON CONFLICT(credential_id,model_id) DO UPDATE SET display_name=excluded.display_name,listed=true",[credentialId,m.id,m.name,m.capability]);
      await db.query('UPDATE model_credentials SET catalog_synced_at=now(),catalog_error=NULL WHERE id=$1',[credentialId]);
      await audit(actor,'model.catalog_refreshed',credentialId,{count:models.length},db);
    });return {count:models.length};
  }catch(error){
    const message=error instanceof HttpError?error.message:'模型目录查询失败，已保留原目录';
    await pool.query('UPDATE model_credentials SET catalog_error=$1 WHERE id=$2 AND revision=$3',[message,credentialId,credential.revision]);
    if(error instanceof HttpError)throw error;throw new HttpError(502,message);
  }
}
