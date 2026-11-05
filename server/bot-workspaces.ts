import pg from 'pg';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {controlPool,trackBusinessPool} from './db.js';
import {botStorage,legacyBotId,type BotScope} from './bot-context.js';
import {openControlSecret} from './bot-secrets.js';
import {requireCondition} from './security.js';
const pools=new Map<string,{signature:string;scope:BotScope}>();
export async function botRecord(id:string){return (await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[id])).rows[0];}
export async function botScope(id:string){
 const row=await botRecord(id);requireCondition(row,404,'机器人不存在');requireCondition(['legacy','ready'].includes(row.database_state),409,'机器人业务空间尚未就绪');
 const base=resolve(process.env.DATA_DIR||'data');
 if(id===legacyBotId&&!row.db_role){requireCondition(row.database_state==='legacy',503,'原机器人业务绑定异常');return {id,pool:controlPool,dataDirectory:base,modelKey:process.env.MODEL_ENCRYPTION_KEY||''};}
 requireCondition((id===legacyBotId||/^[a-f0-9]{32}$/.test(row.data_namespace)&&/^gdb_[a-f0-9]{32}$/.test(row.db_name))&&/^gdr_[a-f0-9]{32}$/.test(row.db_role),503,'机器人存储绑定异常');
 const signature=row.db_password_ciphertext+row.model_key_ciphertext,cached=pools.get(id);if(cached&&cached.signature===signature)return cached.scope;
 const url=new URL(process.env.DATABASE_URL!);url.username=row.db_role;url.password=openControlSecret(row.db_password_ciphertext);url.pathname='/'+row.db_name;
 const p=trackBusinessPool(new pg.Pool({connectionString:url.href,max:4,connectionTimeoutMillis:5000,statement_timeout:15000}));
 const scope={id,pool:p,dataDirectory:id===legacyBotId?base:resolve(base,'bots',row.data_namespace),modelKey:id===legacyBotId?process.env.MODEL_ENCRYPTION_KEY||'':openControlSecret(row.model_key_ciphertext)};
 if(cached)throw new Error('Business database credential rotation requires a controlled process restart');
 pools.set(id,{signature,scope});return scope;
}
export async function withBot<T>(id:string,fn:()=>Promise<T>){return botStorage.run(await botScope(id),fn);}
export async function requireCurrentBotActive(){
 const id=botStorage.getStore()?.id||legacyBotId,row=await botRecord(id);
 requireCondition(row?.state==='active',409,'机器人已暂停或正在切换');return row;
}
export async function listedWorkspaces(activeOnly=false){return (await controlPool.query("SELECT id FROM managed_bots WHERE database_state IN ('legacy','ready') AND state<> 'archived'"+(activeOnly?" AND state='active'":"")+' ORDER BY created_at,id')).rows;}
export async function forWorkspaces<T>(activeOnly:boolean,fn:()=>Promise<T>){let worked=false;for(const row of await listedWorkspaces(activeOnly)){try{const result=await withBot(row.id,fn);worked=!!result||worked;}catch{console.error('bot_worker_retry',row.id);}}return worked;}
export async function ensureAdminAlias(admin:{id:string;username:string}){
 if((botStorage.getStore()?.id||legacyBotId)===legacyBotId)return;
 const pool=botStorage.getStore()!.pool;
 await pool.query("INSERT INTO admins(id,username,password_hash) VALUES($1,$2,'!managed-control-plane-only') ON CONFLICT(id) DO UPDATE SET username=excluded.username",[admin.id,admin.username]);
}
export async function prepareDataRoot(id:string){const scope=await botScope(id);await mkdir(scope.dataDirectory,{recursive:true,mode:0o700});return scope;}
