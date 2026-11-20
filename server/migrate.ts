import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pool,transaction} from './db.js';
import {passwordHash} from './security.js';
import {summaryTemplateFile,fullSummaryInstructions} from './summaries/templates.js';
import {catalog} from './policies.js';
import {defaultInteractionId,interactionCommands} from '../shared/interactions.js';

export async function migrate(options:{controlPlane?:boolean;bootstrapAdmin?:boolean}={}){
  await transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(78511942)");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const adoptLegacy=options.controlPlane!==false&&(await db.query("SELECT to_regclass('public.groups') IS NOT NULL AND to_regclass('public.managed_bots') IS NULL AS needed")).rows[0].needed;
    const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
    for(const name of files){
      if(options.controlPlane===false&&name.endsWith('_bot_control.sql'))continue;
      if((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount)continue;
      await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
    }
    if(adoptLegacy&&(await db.query('SELECT 1 FROM groups LIMIT 1')).rowCount){
      await db.query("INSERT INTO managed_bots(id,name,wechat_id,state,database_state) VALUES('00000000-0000-4000-8000-000000000001','Existing workspace','legacy-unconfigured','paused','legacy') ON CONFLICT DO NOTHING");
      await db.query("INSERT INTO managed_bot_adapters(token_hash,bot_id,name,group_external_ids) SELECT token_hash,'00000000-0000-4000-8000-000000000001',name,group_external_ids FROM runtime_adapters ON CONFLICT DO NOTHING");
    }
    for(const [slug,name] of [['comprehensive','综合版'],['technical','技术职场版'],['ranking','发言排名版'],['entertainment','娱乐排名版'],['news','资讯排名版']]){
      const current=(await db.query('SELECT instructions FROM summary_templates WHERE slug=$1',[slug])).rows[0];
      const instructions=current?fullSummaryInstructions(slug,current.instructions):await readFile(summaryTemplateFile(slug),'utf8');
      await db.query('INSERT INTO summary_templates(slug,name,instructions) VALUES($1,$2,$3) ON CONFLICT(slug) DO UPDATE SET instructions=excluded.instructions,revision=summary_templates.revision+1 WHERE summary_templates.instructions IS DISTINCT FROM excluded.instructions',[slug,name,instructions]);
    }
    if(options.bootstrapAdmin!==false&&!(await db.query('SELECT 1 FROM admins LIMIT 1')).rowCount){
      const password=process.env.ADMIN_PASSWORD;
      if(!password||password.length<16)throw new Error('ADMIN_PASSWORD must contain at least 16 characters for initial setup');
      await db.query("INSERT INTO admins(id,username,password_hash,role) VALUES($1,$2,$3,'super_admin')",[randomUUID(),process.env.ADMIN_USERNAME||'admin',passwordHash(password)]);

    }
    await db.query("INSERT INTO interaction_definitions(id,builtin_key,name,kind,description,instructions,commands) VALUES($1,'daily-moyu-v1','每日摸鱼','daily_checkin','每日签到摸鱼，获得娱乐积分 token，支持余额与兑换列表。','简短、机智、有分寸；奖品未定时可找群主商量，不自行承诺奖品或发放。',$2) ON CONFLICT(builtin_key) DO NOTHING",[defaultInteractionId,interactionCommands]);
    if(process.env.GROUPDESK_IMPORT_BUILTIN_TOPICS==='1'&&!(await db.query("SELECT 1 FROM catalog_imports WHERE name='builtin-v1'")).rowCount){
      for(const item of await catalog()){
        const existing=(await db.query('SELECT id FROM topics WHERE name=$1',[item.name])).rows[0];
        if(existing)await db.query('UPDATE topics SET policy=$1,catalog_key=$2,catalog_version=$3,catalog_hash=$4 WHERE id=$5',[item.policy,item.key,item.version,item.hash,existing.id]);
        else await db.query('INSERT INTO topics(id,name,description,instructions,color,policy,catalog_key,catalog_version,catalog_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),item.name,item.description,item.instructions,item.color,item.policy,item.key,item.version,item.hash]);
      }
      await db.query("INSERT INTO catalog_imports(name) VALUES('builtin-v1')");
    }
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  await migrate();await pool.end();console.log('Migrations complete');
}
