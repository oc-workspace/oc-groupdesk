// Called only by restore.sh while all application writers are stopped.
import {controlPool} from '../server/db.js';
import {sqlIdentifier} from '../server/bot-provisioning.js';
import {openControlSecret} from '../server/bot-secrets.js';
import {legacyBotId} from '../server/bot-context.js';
if(process.env.GROUPDESK_RESTORE_MODE!=='1')throw Error('Use restore.sh with explicit replacement mode');
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
try{
 const rows=(await controlPool.query("SELECT * FROM managed_bots WHERE (to_jsonb(managed_bots)->>'storage_purged_at') IS NULL AND database_state IN ('legacy','ready')")).rows;
 for(const row of rows){
  if(!row.db_role)continue;
  if(!/^gdr_[a-f0-9]{32}$/.test(row.db_role)||row.id!==legacyBotId&&!/^gdb_[a-f0-9]{32}$/.test(row.db_name))throw Error('Invalid restore database binding');
  const password=openControlSecret(row.db_password_ciphertext);
  const exists=(await controlPool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[row.db_role])).rowCount;
  await controlPool.query(`${exists?'ALTER':'CREATE'} ROLE ${sqlIdentifier(row.db_role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${literal(password)}`);
  if(row.id!==legacyBotId){
   if(!(await controlPool.query('SELECT 1 FROM pg_database WHERE datname=$1',[row.db_name])).rowCount)await controlPool.query(`CREATE DATABASE ${sqlIdentifier(row.db_name)} OWNER ${sqlIdentifier(row.db_role)} TEMPLATE template0`);
   await controlPool.query(`REVOKE ALL ON DATABASE ${sqlIdentifier(row.db_name)} FROM PUBLIC`);
  }
 }
 const controlName=(await controlPool.query('SELECT current_database() name')).rows[0].name;
 await controlPool.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${sqlIdentifier(controlName)} FROM PUBLIC`);
 await controlPool.query('DELETE FROM managed_bot_switch');
 if((await controlPool.query("SELECT to_regclass('public.managed_deletion_cleanups') name")).rows[0].name)await controlPool.query("UPDATE managed_deletion_cleanups SET status='failed',error='从备份恢复，需管理员重新预览并确认清理',updated_at=now() WHERE status IN ('queued','processing')");
 await controlPool.query("UPDATE managed_bots SET state='paused',revision=revision+1,runtime_status='{}',runtime_seen_at=NULL,stopped_revision=NULL WHERE state<>'archived'");
 console.log('Robot database identities prepared; all restored robots remain paused.');
}finally{await controlPool.end();}
