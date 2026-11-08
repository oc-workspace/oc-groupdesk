import {keyFeatures} from '../shared/key-management.js';
import {ensureVaultCredential,syncAliases,keyForAlias,authorizedKey,botPrincipal,refreshVaultCatalog} from './key-vault.js';
import {proxyRoute} from './model-proxy.js';
import {controlPool} from './db.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {pool,transaction,audit} from './db.js';
import {requireCondition,HttpError,digest} from './security.js';
import {sealKey,openKey,baseUrl,fetchCatalog,type ClientType} from './model-security.js';
import {parseCatalog,inferCapability} from './model-catalog.js';
import {modelStageIds,type ModelStage} from '../shared/model-stages.js';
export {parseCatalog,inferCapability} from './model-catalog.js';
export const clientType=z.enum(['openai','openai_responses','gemini']);

export const modelId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,199}$/,'模型 ID 格式无效');
export const keyValue=z.string().regex(/^[!-~]{8,500}$/,'API Key 应为不含空白的密钥');
export const selection=z.object({credential_id:z.uuid(),model_id:modelId});
export const groupRoute=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('inherit')}),z.object({mode:z.literal('disabled')}),
  selection.extend({mode:z.literal('custom')})
]);
export const stageRoute=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('inherit')}).strict(),selection.extend({mode:z.literal('custom')}).strict()
]);
const stageFields=Object.fromEntries(modelStageIds.map(id=>[id,stageRoute])) as Record<ModelStage,typeof stageRoute>;
const defaultStageFields=Object.fromEntries(modelStageIds.map(id=>[id,selection.nullable()])) as Record<ModelStage,z.ZodNullable<typeof selection>>;
export const groupRoutes=z.object({text:groupRoute,image:groupRoute,stages:z.object(stageFields).partial().strict().optional()});
export const defaultRoutes=z.object({onboarding:selection.nullable().optional(),text:selection.nullable(),image:selection.nullable(),stages:z.object(defaultStageFields).partial().strict().optional()});
export type Routes=z.infer<typeof groupRoutes>;
type Db=Pick<pg.PoolClient,'query'>;
export async function modelOverview(db:Db=pool){
  for(const c of (await db.query('SELECT * FROM model_credentials WHERE vault_key_id IS NULL')).rows)await ensureVaultCredential(c);
  await syncAliases();
  const owner=await botPrincipal();
  const available=(await controlPool.query("SELECT k.id FROM managed_model_keys k WHERE NOT k.archived AND (k.owner_user_id=$1 OR k.scope='site' AND EXISTS(SELECT 1 FROM managed_model_grants g WHERE g.key_id=k.id AND g.user_id=$1 AND g.enabled AND g.expires_at>now() AND (cardinality(g.bot_ids)=0 OR $2=ANY(g.bot_ids))))",[owner,(await import('./key-vault.js')).botId()])).rows.map(k=>k.id);
  const credentials=(await db.query('SELECT id,vault_key_id,name,base_url,client_type,key_hint,enabled,revision,catalog_synced_at,catalog_error FROM model_credentials ORDER BY created_at,id')).rows;
  const models=(await db.query('SELECT credential_id,model_id,display_name,capability,source,listed FROM credential_models ORDER BY model_id')).rows;
  const grants=(await controlPool.query('SELECT key_id,model_ids,features FROM managed_model_grants WHERE user_id=$1 AND enabled AND expires_at>now()',[owner])).rows;const owned=(await controlPool.query('SELECT id FROM managed_model_keys WHERE owner_user_id=$1',[owner])).rows.map(k=>k.id);
  return {credentials:credentials.filter(c=>available.includes(c.vault_key_id)).map(c=>({...c,allowed_features:owned.includes(c.vault_key_id)?Object.keys(keyFeatures):grants.find(g=>g.key_id===c.vault_key_id)?.features||[],models:models.filter(m=>m.credential_id===c.id&&(owned.includes(c.vault_key_id)||grants.find(g=>g.key_id===c.vault_key_id)?.model_ids.includes(m.model_id)))})),defaults:(await db.query('SELECT revision,routes FROM model_settings WHERE singleton=true')).rows[0]};
}
export async function validateSelection(route:z.infer<typeof selection>|null,kind:'text'|'image',db:Db=pool){
  if(!route)return;
  const alias=(await db.query('SELECT vault_key_id FROM model_credentials WHERE id=$1',[route.credential_id])).rows[0];
  if(alias?.vault_key_id){const k=await keyForAlias(route.credential_id,db),owner=await botPrincipal();
  if(k.owner_user_id!==owner){const g=(await controlPool.query('SELECT * FROM managed_model_grants WHERE key_id=$1 AND user_id=$2 AND enabled AND expires_at>now()',[k.id,owner])).rows[0];requireCondition(k.scope==='site'&&g&&g.model_ids.includes(route.model_id)&&(!g.bot_ids.length||g.bot_ids.includes((await import('./key-vault.js')).botId())),403,'此 Key 或模型未获授权');}}
  const row=(await db.query('SELECT c.enabled,m.capability FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id WHERE c.id=$1 AND m.model_id=$2',[route.credential_id,route.model_id])).rows[0];
  requireCondition(row?.enabled,400,'请选择已启用的 API Key 和已登记模型');
  requireCondition(row.capability===kind,400,'所选模型的功能类型不匹配');
}
export async function validateRoutes(routes:Routes,db:Db){
  for(const kind of ['text','image'] as const)if(routes[kind].mode==='custom')await validateSelection(routes[kind] as z.infer<typeof selection>,kind,db);
  for(const stage of modelStageIds){const route=routes.stages?.[stage];if(route?.mode==='custom')await validateSelection(route,'text',db);}
}
export function configuredModelRoutes(routes:Routes,defaults:z.infer<typeof defaultRoutes>){
  const base=(kind:'text'|'image')=>{
    const configured=routes[kind],selected=configured.mode==='custom'?configured:configured.mode==='inherit'?defaults[kind]:null;
    const source=configured.mode==='disabled'?'disabled':selected?(configured.mode==='inherit'?'default':'group'):kind==='text'&&configured.mode==='inherit'?'legacy':'disabled';
    return {source,selection:selected?{credential_id:selected.credential_id,model_id:selected.model_id}:null};
  };
  const text=base('text'),image=base('image');
  const stages=Object.fromEntries(modelStageIds.map(stage=>{
    const configured=routes.stages?.[stage],global=defaults.stages?.[stage];
    return [stage,text.source==='disabled'?text:configured?.mode==='custom'?{source:'group_stage',selection:{credential_id:configured.credential_id,model_id:configured.model_id}}:global?{source:'default_stage',selection:global}:text];
  })) as Record<ModelStage,ReturnType<typeof base>>;
  return {text,image,stages};
}
export async function effectiveModelRoutes(group:{model_routes:Routes},db:Db=pool){
  const defaults=(await db.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes;
  const configured=configuredModelRoutes(group.model_routes,defaults);
  async function resolve(value:{source:string;selection:z.infer<typeof selection>|null},kind:'text'|'image'){
    const {selection:route}=value,source=value.source==='legacy'?'disabled':value.source;
    const row=route?(await db.query('SELECT c.id credential_id,c.name,c.enabled,c.revision credential_revision,c.client_type,m.model_id,m.capability FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id WHERE c.id=$1 AND m.model_id=$2',[route.credential_id,route.model_id])).rows[0]:null;
    return {source,...(row||{}),available:!!row?.enabled&&row.capability===kind};
  }
  const stages=Object.fromEntries(await Promise.all(modelStageIds.map(async stage=>[stage,await resolve(configured.stages[stage],'text')])));
  return {text:await resolve(configured.text,'text'),image:await resolve(configured.image,'image'),stages};
}
export function hasStageRouting(routes:{stages:Record<string,{source:string}>}){return Object.values(routes.stages).some(r=>['group_stage','default_stage'].includes(r.source));}
async function privateRoute(route:any,groupId:string,stage='chat'){
  if(route.source==='legacy')return null;
  requireCondition(route.source!=='disabled'&&route.available,409,'本群模型已停用或不可用');
  return proxyRoute(route,groupId,stage);
}
export async function privateStageRoutes(group:{id:string;model_routes:Routes},db:Db=pool){
 const routes=await effectiveModelRoutes(group,db);return Object.fromEntries(await Promise.all(modelStageIds.filter(stage=>stage!=='summary').map(async stage=>[stage,routes.stages[stage].available?await privateRoute(routes.stages[stage],group.id,stage):null])));
}
export async function privateTextRoute(group:{id:string;model_routes:Routes},db:Db=pool){const routes=await effectiveModelRoutes(group,db);return privateRoute(routes.text,group.id);}
export async function createCredential(input:{name:string;base_url:string;api_key:string;client_type?:ClientType},actor:string){
  keyValue.parse(input.api_key);
  const credentialId=randomUUID(),endpoint=baseUrl(input.base_url),cipher=sealKey(input.api_key),hint='••••••'+input.api_key.slice(-6);
  await transaction(async db=>{
    await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,client_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[credentialId,input.name,endpoint,cipher,hint,digest(input.api_key),clientType.parse(input.client_type||'openai')]);
    await audit(actor,'model.credential_created',credentialId,{},db);
  });await ensureVaultCredential((await pool.query('SELECT * FROM model_credentials WHERE id=$1',[credentialId])).rows[0]);return credentialId;
}
export async function refreshCatalog(credentialId:string,actor:string,fetcher=fetchCatalog){return refreshVaultCatalog(credentialId,fetcher);}

export async function importExistingCredential(input:{name:string;base_url:string;api_key:string;model_id:string}){
  keyValue.parse(input.api_key);modelId.parse(input.model_id);
  const endpoint=baseUrl(input.base_url);
  return transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(78511943)');
    const existing=(await db.query('SELECT id,key_ciphertext FROM model_credentials WHERE base_url=$1 AND key_digest=$2',[endpoint,digest(input.api_key)])).rows[0];
    const defaults=(await db.query('SELECT routes FROM model_settings WHERE singleton=true FOR UPDATE')).rows[0];
    requireCondition(!defaults.routes.text||(defaults.routes.text.credential_id===existing?.id&&defaults.routes.text.model_id===input.model_id),409,'已有默认文字模型，请在后台明确修改，导入不会覆盖');
    const id=existing?.id||randomUUID();
    if(existing)requireCondition((existing.key_ciphertext==='vault:v1'?(await import('./bot-secrets.js')).openControlSecret((await keyForAlias(existing.id,db)).secret_ciphertext):openKey(existing.key_ciphertext))===input.api_key,503,'已有密钥无法读取，请核对加密主密钥');
    else await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest) VALUES($1,$2,$3,$4,$5,$6)',[id,input.name,endpoint,sealKey(input.api_key),'••••••'+input.api_key.slice(-6),digest(input.api_key)]);
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
