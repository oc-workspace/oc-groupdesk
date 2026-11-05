import pg from 'pg';
import {botStorage} from './bot-context.js';
export const controlPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:5000,statement_timeout:15000});
controlPool.on('error',()=>console.error('database_pool_error'));
const businessPools=new Set<pg.Pool>();
export function trackBusinessPool(pool:pg.Pool){businessPools.add(pool);pool.on('error',()=>console.error('bot_database_pool_error'));return pool;}
let ending:Promise<void>|undefined;
export async function closeBusinessPools(){await Promise.all([...businessPools].map(p=>p.end()));businessPools.clear();}
export async function closePools(){ending??=(async()=>{await closeBusinessPools();await controlPool.end();})();return ending;}
// Existing business modules keep one import; each asynchronous request/job has
// its own connection pool, file root and encryption key. No global SET context.
export const pool=new Proxy(controlPool,{get(target,property){
 if(property==='end')return closePools;
 const selected=botStorage.getStore()?.pool||target;
 const value=Reflect.get(selected,property);return typeof value==='function'?value.bind(selected):value;
}}) as pg.Pool;
export async function transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function controlTransaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 const client=await controlPool.connect();
 try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function audit(actor:string,action:string,target:string|null=null,details:object={},db:Pick<pg.PoolClient,'query'>=pool){await db.query('INSERT INTO audit_logs(actor,action,target,details) VALUES($1,$2,$3,$4)',[actor,action,target,JSON.stringify(details)]);}
