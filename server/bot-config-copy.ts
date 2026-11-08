import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,controlTransaction,audit} from './db.js';
import {withBot} from './bot-workspaces.js';
import {keyForAlias} from './key-vault.js';
import {requireCondition} from './security.js';

// Operator-only, explicitly requested configuration copy. No HTTP endpoint.
export function remapConfiguration(value:any,ids:Map<string,string>):any{
 if(typeof value==='string')return ids.get(value)||value;
 if(Array.isArray(value))return value.map(v=>remapConfiguration(v,ids));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remapConfiguration(v,ids)]));
 return value;
}
export async function copyBotConfiguration(source:string,target:string,sourceGroup:string,actor:string){
 z.uuid().parse(source);z.uuid().parse(target);z.uuid().parse(sourceGroup);
 requireCondition(source!==target,400,'源和目标机器人必须不同');
 return controlTransaction(async control=>{
  const bots=(await control.query('SELECT id,state,database_state FROM managed_bots WHERE deleted_at IS NULL AND id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[source,target]])).rows;
  requireCondition(bots.length===2&&bots.every(b=>['legacy','ready'].includes(b.database_state)),409,'机器人空间尚未就绪');
  requireCondition(bots.find(b=>b.id===target)?.state==='paused',409,'目标机器人必须暂停');
  const snapshot=await withBot(source,()=>transaction(async db=>{
   await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const group=(await db.query('SELECT * FROM groups WHERE deleted_at IS NULL AND id=$1',[sourceGroup])).rows[0];
   requireCondition(group,404,'源群不存在');
   const topics=(await db.query('SELECT * FROM topics ORDER BY id')).rows;
   const credentials=(await db.query('SELECT * FROM model_credentials ORDER BY id')).rows;
   for(const c of credentials){const key=await keyForAlias(c.id);c.vault_key_id=key.id;delete c.key_ciphertext;}
   return {group,topics,credentials,
    models:(await db.query('SELECT * FROM credential_models')).rows,
    defaults:(await db.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes,
    frequency:(await db.query('SELECT policy FROM workspace_reply_frequency WHERE id=1')).rows[0].policy,
    personas:(await db.query('SELECT * FROM personas p WHERE NOT archived AND EXISTS(SELECT 1 FROM persona_versions v WHERE v.persona_id=p.id)')).rows,
    versions:(await db.query('SELECT v.* FROM persona_versions v JOIN personas p ON p.id=v.persona_id WHERE NOT p.archived ORDER BY v.version')).rows,
    topicIds:(await db.query('SELECT topic_id FROM group_topics WHERE group_id=$1',[sourceGroup])).rows.map(r=>r.topic_id),
    features:(await db.query('SELECT * FROM group_persona_features WHERE group_id=$1 ORDER BY position',[sourceGroup])).rows};
  }));
  try{
   const result=await withBot(target,()=>transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(78511968)');
    const previous=(await db.query("SELECT details FROM audit_logs WHERE action='bot.configuration_copied' ORDER BY id DESC LIMIT 1")).rows[0];
    if(previous){requireCondition(previous.details.source===source&&previous.details.source_group===sourceGroup,409,'目标空间已有另一份复制记录');return previous.details.result;}
    const count=(await db.query('SELECT (SELECT count(*) FROM groups)+(SELECT count(*) FROM model_credentials)+(SELECT count(*) FROM personas)+(SELECT count(*) FROM persona_materials)+(SELECT count(*) FROM interaction_wallets) n')).rows[0].n;
    requireCondition(Number(count)===0,409,'目标空间已有业务数据，不自动覆盖');
    const targetTopics=(await db.query('SELECT id,catalog_key,name,revision FROM topics FOR UPDATE')).rows;
    requireCondition(targetTopics.every(t=>t.catalog_key&&t.revision===1),409,'目标话题已有人工修改，不自动覆盖');
    const ids=new Map<string,string>();
    for(const topic of snapshot.topics){
     const existing=targetTopics.find(t=>topic.catalog_key&&t.catalog_key===topic.catalog_key)||targetTopics.find(t=>t.name===topic.name);
     const id=existing?.id||randomUUID();ids.set(topic.id,id);
     if(existing)await db.query('UPDATE topics SET name=$2,description=$3,instructions=$4,color=$5,policy=$6,catalog_key=$7,catalog_version=$8,catalog_hash=$9,revision=1 WHERE id=$1',[id,topic.name,topic.description,topic.instructions,topic.color,topic.policy,topic.catalog_key,topic.catalog_version,topic.catalog_hash]);
     else await db.query('INSERT INTO topics(id,name,description,instructions,color,policy,catalog_key,catalog_version,catalog_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,topic.name,topic.description,topic.instructions,topic.color,topic.policy,topic.catalog_key,topic.catalog_version,topic.catalog_hash]);
    }
    for(const c of snapshot.credentials){
     const id=randomUUID();ids.set(c.id,id);
     await db.query('INSERT INTO model_credentials(id,name,base_url,key_ciphertext,key_hint,key_digest,enabled,client_type,catalog_synced_at,vault_key_id) VALUES($1,$2,$3,\'vault:v1\',$4,$5,$6,$7,$8,$9)',[id,c.name,c.base_url,c.key_hint,c.key_digest,c.enabled,c.client_type,c.catalog_synced_at,c.vault_key_id]);
    }
    for(const m of snapshot.models)await db.query('INSERT INTO credential_models(credential_id,model_id,display_name,capability,source,listed) VALUES($1,$2,$3,$4,$5,$6)',[ids.get(m.credential_id),m.model_id,m.display_name,m.capability,m.source,m.listed]);
    await db.query('UPDATE model_settings SET routes=$1,revision=revision+1 WHERE singleton=true',[remapConfiguration(snapshot.defaults,ids)]);
    await db.query('UPDATE workspace_reply_frequency SET policy=$1,revision=revision+1 WHERE id=1',[snapshot.frequency]);
    for(const p of snapshot.personas){
     const id=randomUUID();ids.set(p.id,id);
     const latest=snapshot.versions.filter(v=>v.persona_id===p.id).at(-1)!;
     await db.query('INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance,kind) VALUES($1,$2,$3,$4,$5,\'{}\',$6,$7,$8)',[id,p.name,p.skill_name,p.description,p.goal,latest.skill_md,{copied_from_bot:source,source_persona:p.id,materials_copied:false},p.kind]);
    }
    for(const v of snapshot.versions){
     const id=randomUUID();ids.set(v.id,id);
     await db.query('INSERT INTO persona_versions(id,persona_id,version,skill_md,sha256,provenance,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ids.get(v.persona_id),v.version,v.skill_md,v.sha256,{copied_from_bot:source,source_version:v.id,materials_copied:false},v.kind]);
    }
    const g=snapshot.group,id=randomUUID();
    requireCondition(!g.persona_version_id||ids.has(g.persona_version_id),409,'源群引用已归档Persona，需要先人工选择');
    // The physical chat ID belongs to the new WeChat account and must be bound later.
    await db.query('INSERT INTO groups(id,name,external_id,enabled,language,allow_language_override,interaction,policy,model_routes,persona_version_id,persona_follow_latest) VALUES($1,$2,NULL,false,$3,$4,$5,$6,$7,$8,$9)',[id,g.name,g.language,g.allow_language_override,g.interaction,g.policy,remapConfiguration(g.model_routes,ids),g.persona_version_id?ids.get(g.persona_version_id):null,g.persona_follow_latest]);
    for(const topic of snapshot.topicIds)await db.query('INSERT INTO group_topics(group_id,topic_id) VALUES($1,$2)',[id,ids.get(topic)]);
    for(const f of snapshot.features){requireCondition(ids.has(f.persona_id)&&ids.has(f.version_id),409,'源群特色Persona缺失');await db.query('INSERT INTO group_persona_features(group_id,persona_id,version_id,position,follow_latest) VALUES($1,$2,$3,$4,$5)',[id,ids.get(f.persona_id),ids.get(f.version_id),f.position,f.follow_latest]);}
    const result={group_id:id,group_name:g.name,groups:1,topics:snapshot.topics.length,credentials:snapshot.credentials.length,personas:snapshot.personas.length,published_versions:snapshot.versions.length,source_group_was_enabled:g.enabled,external_id_bound:false};
    await audit(actor,'bot.configuration_copied',target,{source,source_group:sourceGroup,result},db);
    return result;
   }));
   await audit(actor,'bot.configuration_copy_completed',target,{source,source_group:sourceGroup},control);
   return result;
  }finally{for(const credential of snapshot.credentials)credential.clearKey='';}
 });
}
