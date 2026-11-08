import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {controlPool,controlTransaction,pool,audit} from './db.js';
import {botStorage,legacyBotId} from './bot-context.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {currentUserId,userStorage} from './user-context.js';
import {sealControlSecret,openControlSecret} from './bot-secrets.js';
import {openKey,baseUrl,fetchCatalog} from './model-security.js';
import {parseCatalog} from './model-catalog.js';
import {requireCondition,digest} from './security.js';
import {keyFeatures} from '../shared/key-management.js';
export const features=Object.keys(keyFeatures);
export const limitsSchema=z.object({daily_requests:z.number().int().min(1).max(10000000).nullable(),monthly_requests:z.number().int().min(1).max(100000000).nullable(),daily_tokens:z.number().int().min(1).max(1e12).nullable(),monthly_tokens:z.number().int().min(1).max(1e12).nullable(),daily_cost:z.number().min(.000001).max(1e9).nullable(),monthly_cost:z.number().min(.000001).max(1e9).nullable(),concurrency:z.number().int().min(1).max(32),alert_percent:z.number().int().min(1).max(99).default(80)}).strict();
export const emptyLimits=()=>({daily_requests:null,monthly_requests:null,daily_tokens:null,monthly_tokens:null,daily_cost:null,monthly_cost:null,concurrency:4,alert_percent:80});
export const pricesSchema=z.record(z.string().min(1).max(200),z.object({input:z.number().min(0).max(1e6),output:z.number().min(0).max(1e6),cached:z.number().min(0).max(1e6).optional()}).strict());
export const botId=()=>botStorage.getStore()?.id||legacyBotId;
export async function botPrincipal(){let bot=await botRecord(botId());requireCondition(bot,404,'机器人已删除或不存在');if(!bot.owner_user_id){const fallback=(await controlPool.query("SELECT id FROM admins WHERE deleted_at IS NULL AND role='super_admin' AND status='active' ORDER BY created_at,id LIMIT 1")).rows[0];requireCondition(fallback,409,'机器人尚未分配所有人');bot={...bot,owner_user_id:fallback.id};}requireCondition(bot?.owner_user_id,409,'机器人尚未分配所有人');const user=(await controlPool.query("SELECT id FROM admins WHERE deleted_at IS NULL AND id=$1 AND status='active'",[bot.owner_user_id])).rows[0];requireCondition(user,403,'机器人所有人未通过审核或已停用');return user.id as string;}
export function publicKey(k:any,userId=currentUserId()){
 const {secret_ciphertext,key_digest,...safe}=k;return {...safe,key_hint:k.key_hint,is_owner:k.owner_user_id===userId,can_reveal:k.owner_user_id===userId};
}
export async function ensureVaultCredential(c:any){
 if(c.vault_key_id)return (await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[c.vault_key_id])).rows[0];
 const owner=await botPrincipal(),clear=openKey(c.key_ciphertext),actor=currentUserId()||owner;
 const models=(await pool.query('SELECT model_id,display_name,capability,source,listed FROM credential_models WHERE credential_id=$1',[c.id])).rows;
 const key=await controlTransaction(async db=>{
  const k=(await db.query("INSERT INTO managed_model_keys(id,owner_user_id,created_by_user_id,name,scope,base_url,client_type,secret_ciphertext,key_digest,key_hint,enabled,revision,models,catalog_synced_at,catalog_error) VALUES($1,$2,$3,$4,'private',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(owner_user_id,base_url,key_digest,client_type) DO UPDATE SET models=(SELECT COALESCE(jsonb_agg(v),'[]') FROM (SELECT DISTINCT ON(v->>'model_id') v FROM jsonb_array_elements(managed_model_keys.models||excluded.models) v ORDER BY v->>'model_id',v->>'source') s) RETURNING *",[randomUUID(),owner,actor,c.name,c.base_url,c.client_type,sealControlSecret(clear),digest(clear),'••••••'+clear.slice(-6),c.enabled,c.revision,JSON.stringify(models),c.catalog_synced_at,c.catalog_error])).rows[0];return k;
 });
 await pool.query("UPDATE model_credentials SET vault_key_id=$2,key_ciphertext='vault:v1',key_hint=$3 WHERE id=$1 AND vault_key_id IS NULL",[c.id,key.id,key.key_hint]);return key;
}
export async function initializeKeyVault(){for(const b of (await controlPool.query("SELECT id FROM managed_bots WHERE deleted_at IS NULL AND database_state IN('legacy','ready')")).rows)await withBot(b.id,async()=>{for(const c of (await pool.query('SELECT * FROM model_credentials WHERE vault_key_id IS NULL')).rows)await ensureVaultCredential(c);});}
export async function syncAliases(){
 const owner=await botPrincipal();
 const keys=(await controlPool.query("SELECT k.* FROM managed_model_keys k WHERE NOT k.archived AND (k.owner_user_id=$1 OR k.scope='site' AND EXISTS(SELECT 1 FROM managed_model_grants g WHERE g.key_id=k.id AND g.user_id=$1 AND g.enabled AND g.expires_at>now() AND (cardinality(g.bot_ids)=0 OR $2=ANY(g.bot_ids))))",[owner,botId()])).rows;
 for(const k of keys){
  let alias=(await pool.query('SELECT id FROM model_credentials WHERE vault_key_id=$1',[k.id])).rows[0];
  if(!alias){const id=randomUUID();alias=(await pool.query("INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,enabled,client_type,vault_key_id,revision) VALUES($1,$2,$3,'vault:v1',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",[id,k.name+' · '+k.id.slice(0,6),k.base_url,k.key_hint,k.key_digest,k.enabled,k.client_type,k.id,k.revision])).rows[0];}
  if(!alias)continue;
  await pool.query('UPDATE model_credentials SET base_url=$2,client_type=$3,key_hint=$4,enabled=$5,catalog_synced_at=$6,catalog_error=$7,key_digest=$8 WHERE id=$1',[alias.id,k.base_url,k.client_type,k.key_hint,k.enabled,k.catalog_synced_at,k.catalog_error,k.key_digest]);

  for(const m of k.models)await pool.query('INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(credential_id,model_id) DO UPDATE SET display_name=excluded.display_name,capability=excluded.capability,source=excluded.source,listed=excluded.listed',[alias.id,m.model_id,m.display_name||m.model_id,m.capability,m.source||'manual',!!m.listed]);
 }
}
export async function keyForAlias(id:string,db:Pick<typeof pool,'query'>=pool){const c=(await db.query('SELECT * FROM model_credentials WHERE id=$1',[id])).rows[0];requireCondition(c,404,'API Key 不存在');return await ensureVaultCredential(c);}
export async function authorizedKey(id:string,model:string,feature:string,groupId?:string){
 const k=await keyForAlias(id),userId=await botPrincipal();requireCondition(k?.enabled&&!k.archived,403,'API Key 已停用');
 requireCondition(k.models.some((m:any)=>m.model_id===model),403,'模型未登记');
 let grant:any=null;
 if(k.owner_user_id!==userId){
  requireCondition(k.scope==='site',403,'此 Key 属于其他用户，不能使用');
  grant=(await controlPool.query('SELECT * FROM managed_model_grants WHERE key_id=$1 AND user_id=$2 AND enabled AND expires_at>now()',[k.id,userId])).rows[0];
  requireCondition(grant&&(!grant.bot_ids.length||grant.bot_ids.includes(botId()))&&(!grant.group_ids.length||!!groupId&&grant.group_ids.includes(groupId))&&grant.model_ids.includes(model)&&grant.features.includes(feature),403,'公用 Key 未获授权、已过期或超出授权范围');
 }
 return {key:k,grant,userId};
}
export async function updateKeyAliases(k:any){
 for(const b of (await controlPool.query("SELECT id FROM managed_bots WHERE deleted_at IS NULL AND database_state IN('legacy','ready')")).rows)await withBot(b.id,async()=>{
  const aliases=(await pool.query("UPDATE model_credentials c SET base_url=$2,client_type=$3,enabled=$4,revision=revision+1,key_hint=$5,key_digest=$6,name=CASE WHEN EXISTS(SELECT 1 FROM model_credentials n WHERE n.id<>c.id AND n.name=$7) THEN $7||' · '||left(c.vault_key_id::text,6) ELSE $7 END WHERE vault_key_id=$1 RETURNING id",[k.id,k.base_url,k.client_type,k.enabled&&!k.archived,k.key_hint,k.key_digest,k.name])).rows;
  if(aliases.length){await syncAliases();const ids=aliases.map(a=>a.id),defaults=(await pool.query('SELECT routes FROM model_settings')).rows[0].routes;const {configuredModelRoutes}=await import('./models.js');const groups=(await pool.query('SELECT id,model_routes FROM groups WHERE deleted_at IS NULL')).rows;const affected=groups.filter(g=>{const routes=configuredModelRoutes(g.model_routes,defaults);return [routes.text,routes.image,...Object.values(routes.stages)].some((r:any)=>ids.includes(r.selection?.credential_id));}).map(g=>g.id);await pool.query("UPDATE groups g SET revision=revision+1 WHERE id=ANY($1::uuid[]) OR EXISTS(SELECT 1 FROM group_interactions b WHERE b.group_id=g.id AND b.config->'model_route'->>'credential_id'=ANY($2::text[])) OR EXISTS(SELECT 1 FROM summary_settings s WHERE s.group_id=g.id AND s.config->'model_route'->>'credential_id'=ANY($2::text[]))",[affected,ids]);}
 });
}
export async function refreshVaultCatalog(id:string,fetcher=fetchCatalog){
 const k=await keyForAlias(id),u=userStorage.getStore();requireCondition(!u||u.id===k.owner_user_id||u.role==='super_admin',403,'无权维护该 Key');
 try{const models=parseCatalog(await fetcher(k.base_url,openControlSecret(k.secret_ciphertext),k.client_type),k.client_type).map(m=>({model_id:m.id,display_name:m.name,capability:m.capability,source:'catalog',listed:true}));
  const retained=k.models.filter((m:any)=>m.source!=='catalog'&&!models.some(n=>n.model_id===m.model_id));
  await controlPool.query('UPDATE managed_model_keys SET models=$2,catalog_synced_at=now(),catalog_error=NULL WHERE id=$1 AND revision=$3',[k.id,JSON.stringify([...models,...retained]),k.revision]);await syncAliases();return {count:models.length};
 }catch{await controlPool.query("UPDATE managed_model_keys SET catalog_error='目录查询失败，已保留原目录' WHERE id=$1",[k.id]);throw new (await import('./security.js')).HttpError(502,'目录查询失败，已保留原目录');}
}
export type CallScope={feature:string;groupId?:string};
export async function reserveUsage(id:string,model:string,scope:CallScope,inputBytes:number,outputLimit:number){
 const a=await authorizedKey(id,model,scope.feature,scope.groupId),tokens=Math.ceil(inputBytes*2)+outputLimit+2048;
 const price=a.key.prices[model],money=price?(tokens*(Math.max(price.input,price.output,price.cached||0))):null;
 const usage=await controlTransaction(async db=>{
  const live=(await db.query('SELECT * FROM managed_model_keys WHERE id=$1 FOR UPDATE',[a.key.id])).rows[0];
  requireCondition(live?.enabled&&!live.archived&&live.revision===a.key.revision,409,'Key 已更新，请重试');
  const principal=(await db.query("SELECT b.owner_user_id FROM managed_bots b JOIN admins u ON u.id=b.owner_user_id AND b.deleted_at IS NULL WHERE b.id=$1 AND u.deleted_at IS NULL AND u.status='active' FOR SHARE OF b",[botId()])).rows[0];requireCondition(principal?.owner_user_id===a.userId,403,'机器人归属或用户准入已变化');
  let liveGrant:any=null;
  if(live.owner_user_id!==a.userId){liveGrant=(await db.query('SELECT * FROM managed_model_grants WHERE key_id=$1 AND user_id=$2 AND enabled AND expires_at>now()',[live.id,a.userId])).rows[0];requireCondition(live.scope==='site'&&liveGrant&&(!liveGrant.bot_ids.length||liveGrant.bot_ids.includes(botId()))&&(!liveGrant.group_ids.length||!!scope.groupId&&liveGrant.group_ids.includes(scope.groupId))&&liveGrant.model_ids.includes(model)&&liveGrant.features.includes(scope.feature),403,'公用 Key 授权已变化');}
  const fresh={key:live,grant:liveGrant};
  await db.query("UPDATE managed_model_usage SET status='unknown',error_code='interrupted',finished_at=now() WHERE status='reserved' AND created_at<now()-interval '20 minutes'");
  const checks=[{limits:{...emptyLimits(),...fresh.key.limits},all:true},{limits:fresh.grant?.limits,all:false}].filter(c=>c.limits);
  for(const check of checks){
   const l=check.limits;requireCondition(!(l.daily_cost||l.monthly_cost)||price,409,'此模型尚未配置价格，不能用于费用预算');
   const rows=(await db.query("SELECT count(*) FILTER(WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore')::int dr,count(*)::int mr,COALESCE(sum(CASE WHEN created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore' THEN COALESCE(input_tokens+output_tokens,reserved_tokens) ELSE 0 END),0) dt,COALESCE(sum(COALESCE(input_tokens+output_tokens,reserved_tokens)),0) mt,COALESCE(sum(CASE WHEN created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore' THEN COALESCE(cost,reserved_cost) ELSE 0 END),0) dc,COALESCE(sum(COALESCE(cost,reserved_cost)),0) mc,count(*) FILTER(WHERE status='reserved')::int active FROM managed_model_usage WHERE key_id=$1 AND ($2::boolean OR user_id=$3) AND status!='failed' AND created_at >= date_trunc('month',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore'",[a.key.id,check.all,a.userId])).rows[0];
   if(l.daily_cost||l.monthly_cost){const missing=(await db.query("SELECT count(*) FILTER(WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore')::int pending_day,count(*)::int pending_month FROM managed_model_usage WHERE key_id=$1 AND ($2::boolean OR user_id=$3) AND status!='failed' AND cost IS NULL AND reserved_cost IS NULL AND created_at >= date_trunc('month',now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore'",[a.key.id,check.all,a.userId])).rows[0];requireCondition(!(l.daily_cost&&missing.pending_day||l.monthly_cost&&missing.pending_month),409,'历史用量尚未定价或核对，请先核对账本再使用费用预算');}
   for(const [limit,used,add] of [['daily_requests','dr',1],['monthly_requests','mr',1],['daily_tokens','dt',tokens],['monthly_tokens','mt',tokens],['daily_cost','dc',money===null?0:money/1e6],['monthly_cost','mc',money===null?0:money/1e6],['concurrency','active',1]] as const)requireCondition(l[limit]==null||(Number(rows[used])/(limit.endsWith('cost')?1e6:1))+add<=l[limit],429,'Key 的'+limit+'额度不足，请申请调整或使用自己的 Key');
  }
  const usageId=randomUUID();await db.query("INSERT INTO managed_model_usage(id,key_id,user_id,actor_user_id,bot_id,group_id,feature,model_id,currency,grant_id,reserved_tokens,reserved_cost,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved')",[usageId,a.key.id,a.userId,currentUserId(),botId(),scope.groupId||null,scope.feature,model,a.key.currency,a.grant?.id||null,tokens,money]);return usageId;
 });return {...a,id:usage,price};
}
export function parseUsage(value:any){
 const u=value?.usageMetadata||value?.usage||value?.response?.usage;if(!u)return null;
 const input=u.promptTokenCount??u.input_tokens??u.prompt_tokens,output=u.candidatesTokenCount!=null?Number(u.candidatesTokenCount)+Number(u.thoughtsTokenCount||0):u.output_tokens??u.completion_tokens,cached=u.cachedContentTokenCount??u.input_tokens_details?.cached_tokens??u.prompt_tokens_details?.cached_tokens??0;
 if(![input,output,cached].every(v=>Number.isSafeInteger(v)&&v>=0)||cached>input)return null;
 return {input,output,cached};
}
export async function settleUsage(reservation:any,value:any,dispatched:boolean,error?:string){
 const u=parseUsage(value),p=reservation.price;
 const cost=u&&p?Math.max(0,u.input-u.cached)*p.input+u.cached*(p.cached??p.input)+u.output*p.output:null;
 await controlPool.query("UPDATE managed_model_usage SET input_tokens=$2,output_tokens=$3,cached_tokens=$4,cost=$5,status=$6,dispatched=$7,error_code=$8,finished_at=now() WHERE id=$1 AND status='reserved'",[reservation.id,u?.input??null,u?.output??null,u?.cached??null,cost,u?'completed':dispatched?'unknown':'failed',dispatched,error||null]);
}
