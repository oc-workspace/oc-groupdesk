// Restore-only verification and replay protection. Never contacts models or runtime agents.
import {controlPool,closeBusinessPools,pool} from '../server/db.js';
import {openControlSecret} from '../server/bot-secrets.js';
import {withBot} from '../server/bot-workspaces.js';
import {migrate} from '../server/migrate.js';
let decrypted=0;
try{
 // Do not migrate yet: raw table fingerprints are checked by the caller first.
 for(const table of ['managed_model_keys','managed_bots']){
  if(!(await controlPool.query("SELECT to_regclass('public."+table+"') name")).rows[0].name)continue;
  for(const row of (await controlPool.query('SELECT * FROM '+table)).rows){
   for(const field of table==='managed_model_keys'?['secret_ciphertext']:['db_password_ciphertext','model_key_ciphertext'])if(row[field]){openControlSecret(row[field]);decrypted++;}
  }
 }
 await migrate();
 await controlPool.query('DELETE FROM sessions');
 await controlPool.query("UPDATE managed_bot_device_pairings SET consumed_at=COALESCE(consumed_at,now())");
 await controlPool.query("UPDATE managed_bot_onboarding SET environment_prepared_at=NULL,environment_prepared_by=NULL,desktop_url='',account_confirmed_at=NULL,account_confirmed_by=NULL,reader_authorized_at=NULL,reader_authorized_by=NULL,completed_at=NULL,revision=revision+1,updated_at=now()");
 await controlPool.query("UPDATE managed_bot_migration_launches SET state='attention',activation_generation=NULL,updated_at=now() WHERE state IN ('requested','running')");
 await controlPool.query("UPDATE managed_bot_deployment_changes SET state='cancelled',reason=reason||' [Restored: re-confirm deployment]',updated_at=now() WHERE state IN ('requested','approved','verifying')");
 await controlPool.query('DELETE FROM managed_bot_switch');
 await controlPool.query("UPDATE managed_runtime_hosts SET enabled=false,can_cleanup=false,token_hash=NULL,permit_ciphertext=NULL,last_seen_at=NULL");
 await controlPool.query("UPDATE managed_runtime_jobs SET status='cancelled',error='Restored: review and re-enrol before use',lease_token=NULL,lease_until=NULL,finished_at=now() WHERE status IN ('queued','preparing','executing')");
 await controlPool.query("UPDATE managed_bot_purges SET status='cancelled',error='Restored: requires a new preview',finished_at=now(),updated_at=now() WHERE status IN ('queued','processing','failed')");
 await controlPool.query("UPDATE managed_deletion_cleanups SET status='failed',error='Restored: requires a new preview',updated_at=now() WHERE status IN ('queued','processing')");
 await controlPool.query("UPDATE managed_bots SET state=CASE WHEN state='archived' THEN 'archived' ELSE 'paused' END,revision=revision+1,activation_generation=activation_generation+1,runtime_instance_id=NULL,runtime_seen_at=NULL,runtime_status='{}',stopped_revision=NULL");
 await controlPool.query('DELETE FROM managed_bot_adapters');
 await controlPool.query('DELETE FROM runtime_adapters');
 for(const bot of (await controlPool.query("SELECT id FROM managed_bots WHERE deleted_at IS NULL AND database_state IN ('legacy','ready')")).rows){
  await withBot(bot.id,async()=>{
   await migrate({controlPlane:false,bootstrapAdmin:false});
   await pool.query('DELETE FROM runtime_adapters');
   for(const table of ['persona_jobs','conversation_jobs'])await pool.query("UPDATE "+table+" SET status='failed',error='Restored: unfinished model task requires explicit retry',finished_at=now() WHERE status IN ('pending','processing')");
   await pool.query("UPDATE documents SET status='failed',error='Restored: please retry indexing' WHERE status IN ('pending','processing')");
   await pool.query("UPDATE interaction_templates SET status='cancelled',error='Restored: model task cancelled',updated_at=now() WHERE status IN ('pending','processing')");
   await pool.query("UPDATE group_onboarding_jobs SET status='cancelled',error_code='restore_cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status IN ('queued','working')");
   await pool.query('UPDATE summary_schedules SET enabled=false');
   await pool.query("UPDATE summary_jobs SET status='cancelled',error='Restored: pending publication cancelled',source_token=NULL,delivery_token=NULL,lease_until=NULL WHERE status NOT IN ('completed','failed','cancelled','sent')");
   await pool.query("UPDATE interaction_events SET delivery_status='expired' WHERE delivery_status IN ('waiting','reserved')");
  });
 }
 console.log(JSON.stringify({control_secrets_decryptable:decrypted,robots_paused:true,runtime_tokens_invalidated:true}));
}finally{await closeBusinessPools();await controlPool.end();}
