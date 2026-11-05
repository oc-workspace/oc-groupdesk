import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {controlPool,controlTransaction,audit} from './db.js';
import {botStorage,legacyBotId} from './bot-context.js';
import {sealControlSecret} from './bot-secrets.js';
import {requireCondition} from './security.js';
export function sqlIdentifier(value:string){requireCondition(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value),503,'数据库标识无效');return '"'+value+'"';}
function quote(value:string){return "'"+value.replaceAll("'","''")+"'";}
export async function createBot(input:{name:string;wechat_id:string;host_label:string;notes:string},actor:string){
 const id=randomUUID(),namespace=id.replaceAll('-',''),database='gdb_'+namespace,role='gdr_'+namespace,password=randomBytes(32).toString('hex'),modelKey=randomBytes(32).toString('hex');
 const client=await controlPool.connect();let roleCreated=false,databaseCreated=false,inserted=false;
 try{
  await client.query('SELECT pg_advisory_lock(78511965)');
  await client.query("INSERT INTO managed_bots(id,name,wechat_id,host_label,notes,state,database_state,db_name,db_role,db_password_ciphertext,model_key_ciphertext,data_namespace) VALUES($1,$2,$3,$4,$5,'paused','provisioning',$6,$7,$8,$9,$10)",[id,input.name,input.wechat_id,input.host_label,input.notes,database,role,sealControlSecret(password),sealControlSecret(modelKey),namespace]);inserted=true;
  await client.query(`CREATE ROLE ${sqlIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${quote(password)}`);roleCreated=true;
  await client.query(`CREATE DATABASE ${sqlIdentifier(database)} OWNER ${sqlIdentifier(role)} TEMPLATE template0`);databaseCreated=true;
  await client.query(`REVOKE ALL ON DATABASE ${sqlIdentifier(database)} FROM PUBLIC`);
  const controlName=(await client.query('SELECT current_database() name')).rows[0].name;
  await client.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${sqlIdentifier(controlName)} FROM PUBLIC`);
  const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password;url.pathname='/'+database;
  const business=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:5000,statement_timeout:15000});
  const dir=resolve(process.env.DATA_DIR||'data','bots',namespace);
  try{
   await mkdir(dir,{recursive:true,mode:0o700});
   await botStorage.run({id,pool:business,dataDirectory:dir,modelKey},async()=>{const {migrate}=await import('./migrate.js');await migrate({controlPlane:false,bootstrapAdmin:false});});
  }finally{await business.end();}
  await client.query("UPDATE managed_bots SET database_state='ready' WHERE id=$1",[id]);
  await audit(actor,'bot.created',id,{isolated_database:true},controlPool);return id;
 }catch{
  if(inserted)await client.query("UPDATE managed_bots SET database_state='failed',error='业务空间初始化失败，请检查服务权限；未启用此机器人' WHERE id=$1",[id]);
  // Keep a failed registration visible. Newly created empty databases may be
  // investigated by the operator; never delete a database as error recovery.
  throw new Error('机器人业务空间初始化失败，已保持停用；请检查运行记录');
 }finally{await client.query('SELECT pg_advisory_unlock(78511965)');client.release();}
}
export async function ensureLegacyIsolation(){
 const row=(await controlPool.query('SELECT * FROM managed_bots WHERE id=$1',[legacyBotId])).rows[0];
 requireCondition(row?.database_state==='legacy',503,'原机器人业务空间缺失');
 const client=await controlPool.connect();
 try{
  await client.query('SELECT pg_advisory_lock(78511965)');
  let role=row.db_role;
  if(!role){
   role='gdr_'+legacyBotId.replaceAll('-','');const password=randomBytes(32).toString('hex');
   requireCondition(!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,503,'已有业务角色未绑定，请人工核对');
   await client.query(`CREATE ROLE ${sqlIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${quote(password)}`);
   const database=(await client.query('SELECT current_database() name')).rows[0].name;
   await client.query('UPDATE managed_bots SET db_name=$2,db_role=$3,db_password_ciphertext=$4 WHERE id=$1',[legacyBotId,database,role,sealControlSecret(password)]);
  }
  await client.query(`GRANT USAGE ON SCHEMA public TO ${sqlIdentifier(role)}`);
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('admins','sessions','schema_migrations') AND tablename NOT LIKE 'managed\\_%' ESCAPE '\\'")).rows;
  for(const table of tables)await client.query(`GRANT ALL ON TABLE public.${sqlIdentifier(table.tablename)} TO ${sqlIdentifier(role)}`);
  await client.query(`GRANT SELECT(id,username) ON admins TO ${sqlIdentifier(role)}`);
  const sequences=(await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
  for(const seq of sequences)await client.query(`GRANT USAGE,SELECT ON SEQUENCE public.${sqlIdentifier(seq.sequencename)} TO ${sqlIdentifier(role)}`);
  const database=(await client.query('SELECT current_database() name')).rows[0].name;
  await client.query(`GRANT CONNECT,TEMPORARY ON DATABASE ${sqlIdentifier(database)} TO ${sqlIdentifier(role)}`);
 }finally{await client.query('SELECT pg_advisory_unlock(78511965)');client.release();}
}
