// Restore-only: old host credentials and queued destructive work must not resume.
import {controlPool} from '../server/db.js';
if(process.env.GROUPDESK_RESTORE_MODE!=='1')throw Error('Use explicit restore mode');
try{
 if((await controlPool.query("SELECT to_regclass('public.managed_runtime_hosts') name")).rows[0].name){
  await controlPool.query("UPDATE managed_runtime_hosts SET enabled=false,token_hash=NULL,permit_ciphertext=NULL,last_seen_at=NULL");
  await controlPool.query("UPDATE managed_runtime_jobs SET status='cancelled',error='从备份恢复，主机需重新接入；清理任务须重新预览并确认',lease_token=NULL,lease_until=NULL,finished_at=now() WHERE status IN ('queued','preparing','executing')");
 }
 if((await controlPool.query("SELECT to_regclass('public.managed_bot_purges') name")).rows[0].name)await controlPool.query("UPDATE managed_bot_purges SET status='cancelled',error='从备份恢复，彻底清理需重新预览确认',finished_at=now(),updated_at=now() WHERE status IN ('queued','processing','failed')");
 console.log('Restored runtime hosts disabled; pending maintenance cancelled.');
}finally{await controlPool.end();}
