import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {pool,transaction,audit} from './db.js';
import {requireCondition,HttpError,digest} from './security.js';
import {sealKey,openKey,baseUrl,fetchCatalog,type ClientType} from './model-security.js';
import {parseCatalog,inferCapability} from './model-catalog.js';
export {parseCatalog,inferCapability} from './model-catalog.js';
export const clientType=z.enum(['openai','openai_responses','gemini']);

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
export async function modelOverview(db:Db=pool){
  const credentials=(await db.query('SELECT id,name,base_url,client_type,key_hint,enabled,revision,catalog_synced_at,catalog_error FROM model_credentials ORDER BY created_at,id')).rows;
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
    const row=route?(await db.query('SELECT c.id credential_id,c.name,c.enabled,c.revision credential_revision,c.client_type,m.model_id,m.capability FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id WHERE c.id=$1 AND m.model_id=$2',[route.credential_id,route.model_id])).rows[0]:null;
    result[kind]={source,...(row||{}),available:!!row?.enabled&&row.capability===kind};
  }
  return result;
}
export async function privateTextRoute(group:{id:string;model_routes:Routes},db:Db=pool){
  const routes=await effectiveModelRoutes(group,db),route=routes.text as any;
  if(route.source==='legacy')return null;
  requireCondition(route.source!=='disabled'&&route.available,409,'本群文字模型已停用或不可用');
  const credential=(await db.query('SELECT base_url,key_ciphertext,client_type FROM model_credentials WHERE id=$1',[route.credential_id])).rows[0];
  return {...route,base_url:credential.base_url,api_key:openKey(credential.key_ciphertext),client_type:credential.client_type};
}
export async function createCredential(input:{name:string;base_url:string;api_key:string;client_type?:ClientType},actor:string){
  keyValue.parse(input.api_key);
  const credentialId=randomUUID(),endpoint=baseUrl(input.base_url),cipher=sealKey(input.api_key),hint='••••'+input.api_key.slice(-4);
  await transaction(async db=>{
    await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[credentialId,input.name,endpoint,cipher,hint,digest(input.api_key),clientType.parse(input.client_type||'openai')]);
    await audit(actor,'model.credential_created',credentialId,{},db);
  });return credentialId;
}
export async function refreshCatalog(credentialId:string,actor:string,fetcher=fetchCatalog){
  const credential=(await pool.query('SELECT * FROM model_credentials WHERE id=$1',[credentialId])).rows[0];
  requireCondition(credential?.enabled,400,'请先启用 API Key');
  try{
    const models=parseCatalog(await fetcher(credential.base_url,openKey(credential.key_ciphertext),credential.client_type),credential.client_type);
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

export async function importExistingCredential(input:{name:string;base_url:string;api_key:string;model_id:string}){
  keyValue.parse(input.api_key);modelId.parse(input.model_id);
  const endpoint=baseUrl(input.base_url);
  return transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(78511943)');
    const existing=(await db.query('SELECT id,key_ciphertext FROM model_credentials WHERE base_url=$1 AND key_digest=$2',[endpoint,digest(input.api_key)])).rows[0];
    const defaults=(await db.query('SELECT routes FROM model_settings WHERE singleton=true FOR UPDATE')).rows[0];
    requireCondition(!defaults.routes.text||(defaults.routes.text.credential_id===existing?.id&&defaults.routes.text.model_id===input.model_id),409,'已有默认文字模型，请在后台明确修改，导入不会覆盖');
    const id=existing?.id||randomUUID();
    if(existing)requireCondition(openKey(existing.key_ciphertext)===input.api_key,503,'已有密钥无法读取，请核对加密主密钥');
    else await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest) VALUES($1,$2,$3,$4,$5,$6)',[id,input.name,endpoint,sealKey(input.api_key),'••••'+input.api_key.slice(-4),digest(input.api_key)]);
    await db.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,$2,$2,'text','configured') ON CONFLICT(credential_id,model_id) DO NOTHING",[id,input.model_id]);
    await validateSelection({credential_id:id,model_id:input.model_id},'text',db);
    if(!defaults.routes.text){
      await db.query("UPDATE model_settings SET routes=jsonb_set(routes,'{text}',$1::jsonb),revision=revision+1 WHERE singleton=true",[JSON.stringify({credential_id:id,model_id:input.model_id})]);
      await db.query("UPDATE groups SET revision=revision+1 WHERE model_routes->'text'->>'mode'='inherit'");
      await audit('operator','model.existing_credential_imported',id,{},db);
    }
    return id;
  });
}
