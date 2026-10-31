import pg from 'pg';
export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, max:8, connectionTimeoutMillis:5000, statement_timeout:15000});
pool.on('error',()=>console.error('database_pool_error'));
export async function transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try {await client.query('BEGIN'); const value=await fn(client); await client.query('COMMIT'); return value;}
  catch(error){await client.query('ROLLBACK'); throw error;} finally{client.release();}
}
export async function audit(actor:string,action:string,target:string|null=null,details:object={},db:Pick<pg.PoolClient,'query'>=pool){
  await db.query('INSERT INTO audit_logs(actor,action,target,details) VALUES($1,$2,$3,$4)',[actor,action,target,JSON.stringify(details)]);
}
