import type express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,audit} from '../db.js';
import {requireCondition} from '../security.js';
import {definitionSchema,settingsSchema,bindingSchema,prizeSchema,settingsDefault} from './schema.js';
import {groupForInteraction,interactionSettings,interactionBindings,interactionPrizes,validateInteractionBindings,interactionDay} from './config.js';
import {reviewRedemption} from './service.js';
const uuid=(v:unknown)=>z.uuid().parse(v);
async function lockDefinitionGroups(id:string,db:any){return (await db.query("SELECT g.id FROM groups g WHERE EXISTS(SELECT 1 FROM group_interactions b WHERE b.group_id=g.id AND b.definition_id=$1 AND (b.config->>'enabled')::boolean) ORDER BY g.id FOR UPDATE",[id])).rows;}
export function registerInteractionAdmin(app:express.Express){
 app.get('/api/interactions',async(_req,res)=>{
  const groups=(await pool.query('SELECT id,name,enabled,revision,applied_revision,bot_seen_at FROM groups ORDER BY created_at,id')).rows;
  for(const group of groups){group.settings=await interactionSettings(group.id);group.bindings=await interactionBindings(group.id);group.prizes=await interactionPrizes(group.id);const day=interactionDay(Date.now(),group.settings.timezone);group.usage=(await pool.query('SELECT replies,ai_calls FROM interaction_daily_usage WHERE group_id=$1 AND day_key=$2',[group.id,day])).rows[0]||{replies:0,ai_calls:0};}
  res.json({definitions:(await pool.query('SELECT * FROM interaction_definitions ORDER BY created_at,id')).rows,groups,templates:(await pool.query('SELECT cache_key,group_id,binding_id,locale,outcome,status,model_id,error,updated_at FROM interaction_templates ORDER BY updated_at DESC LIMIT 100')).rows});
 });
 app.post('/api/interactions/definitions',async(req,res)=>{
  const body=definitionSchema.parse(req.body),id=randomUUID();await transaction(async db=>{await db.query('INSERT INTO interaction_definitions(id,name,kind,description,instructions,commands) VALUES($1,$2,$3,$4,$5,$6)',[id,body.name,body.kind,body.description,body.instructions,body.commands]);await audit(req.admin!.username,'interaction.definition_created',id,{kind:body.kind},db);});res.status(201).json({id});
 });
 app.put('/api/interactions/definitions/:id',async(req,res)=>{
  const id=uuid(req.params.id),body=definitionSchema.safeExtend({revision:z.number().int().positive()}).parse(req.body);
  await transaction(async db=>{const old=(await db.query('SELECT * FROM interaction_definitions WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(old&&old.revision===body.revision,409,'互动模板已变化，请重新载入');requireCondition(old.kind===body.kind,400,'已有互动不能变更处理类型，请另建模板');const groups=await lockDefinitionGroups(id,db);
   await db.query('UPDATE interaction_definitions SET name=$2,description=$3,instructions=$4,commands=$5,revision=revision+1 WHERE id=$1',[id,body.name,body.description,body.instructions,body.commands]);for(const g of groups){await validateInteractionBindings(g.id,db);await db.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[g.id]);}await audit(req.admin!.username,'interaction.definition_updated',id,{},db);
  });res.json({ok:true});
 });
 app.post('/api/interactions/definitions/:id/archive',async(req,res)=>{
  const id=uuid(req.params.id),body=z.object({revision:z.number().int().positive(),archived:z.boolean()}).strict().parse(req.body);
  await transaction(async db=>{const old=(await db.query('SELECT revision FROM interaction_definitions WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(old?.revision===body.revision,409,'互动模板已变化');const groups=await lockDefinitionGroups(id,db);await db.query('UPDATE interaction_definitions SET archived=$2,revision=revision+1 WHERE id=$1',[id,body.archived]);for(const g of groups){await validateInteractionBindings(g.id,db);await db.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[g.id]);}await audit(req.admin!.username,'interaction.definition_archived',id,{archived:body.archived},db);});res.json({ok:true});
 });
 app.put('/api/interactions/groups/:id',async(req,res)=>{
  const id=uuid(req.params.id),body=z.object({revision:z.number().int().positive(),settings:settingsSchema,bindings:z.array(z.object({definition_id:z.uuid(),config:bindingSchema}).strict()).max(50)}).strict().parse(req.body);
  requireCondition(new Set(body.bindings.map(b=>b.definition_id)).size===body.bindings.length,400,'互动选择重复');
  await transaction(async db=>{const group=await groupForInteraction(id,db,true);requireCondition(group.revision===body.revision,409,'群配置已更新，请重新载入');
   await db.query('INSERT INTO interaction_settings(group_id,settings) VALUES($1,$2) ON CONFLICT(group_id) DO UPDATE SET settings=excluded.settings',[id,body.settings]);
   await db.query("UPDATE group_interactions SET config=jsonb_set(config,'{enabled}','false') WHERE group_id=$1",[id]);
   for(const b of body.bindings){requireCondition((await db.query('SELECT 1 FROM interaction_definitions WHERE id=$1',[b.definition_id])).rowCount,400,'互动模板不存在');await db.query('INSERT INTO group_interactions(id,group_id,definition_id,config) VALUES($1,$2,$3,$4) ON CONFLICT(group_id,definition_id) DO UPDATE SET config=excluded.config',[randomUUID(),id,b.definition_id,b.config]);}
   await validateInteractionBindings(id,db);await db.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[id]);await audit(req.admin!.username,'interaction.group_configured',id,{enabled:body.bindings.filter(b=>b.config.enabled).length},db);
  });res.json({ok:true});
 });
 app.post('/api/interactions/groups/:id/prizes',async(req,res)=>{
  const groupId=uuid(req.params.id),body=prizeSchema.extend({group_revision:z.number().int().positive()}).parse(req.body),id=randomUUID();
  await transaction(async db=>{const group=await groupForInteraction(groupId,db,true);requireCondition(group.revision===body.group_revision,409,'群配置已更新，请重新载入');await db.query('INSERT INTO interaction_prizes(id,group_id,code,name,description,cost,stock,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,groupId,body.code,body.name,body.description,body.cost,body.stock,body.enabled]);requireCondition((await db.query('SELECT count(*)::int count FROM interaction_prizes WHERE group_id=$1 AND enabled',[groupId])).rows[0].count<=10,400,'每群最多启用10项奖品');await db.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[groupId]);await audit(req.admin!.username,'interaction.prize_created',id,{group_id:groupId},db);});res.status(201).json({id});
 });
 app.put('/api/interactions/prizes/:id',async(req,res)=>{
  const id=uuid(req.params.id),body=prizeSchema.extend({group_revision:z.number().int().positive(),revision:z.number().int().positive()}).parse(req.body);
  await transaction(async db=>{const found=(await db.query('SELECT group_id FROM interaction_prizes WHERE id=$1',[id])).rows[0];requireCondition(found,404,'奖品不存在');const group=await groupForInteraction(found.group_id,db,true);requireCondition(group.revision===body.group_revision,409,'群配置已更新');const old=(await db.query('SELECT * FROM interaction_prizes WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(old.revision===body.revision,409,'奖品配置已更新');requireCondition(old.code===body.code,400,'奖品编号创建后不能修改');
   await db.query('UPDATE interaction_prizes SET name=$2,description=$3,cost=$4,stock=$5,enabled=$6,revision=revision+1 WHERE id=$1',[id,body.name,body.description,body.cost,body.stock,body.enabled]);requireCondition((await db.query('SELECT count(*)::int count FROM interaction_prizes WHERE group_id=$1 AND enabled',[group.id])).rows[0].count<=10,400,'每群最多启用10项奖品');await db.query('UPDATE groups SET revision=revision+1 WHERE id=$1',[group.id]);await audit(req.admin!.username,'interaction.prize_updated',id,{},db);
  });res.json({ok:true});
 });
 app.get('/api/interactions/groups/:id/records',async(req,res)=>{
  const id=uuid(req.params.id),query=z.string().max(100).parse(req.query.query||'');await groupForInteraction(id);
  const wallets=(await pool.query('SELECT * FROM interaction_wallets WHERE group_id=$1 AND ($2=\'\' OR strpos(lower(display_name),lower($2))>0) ORDER BY balance DESC,actor_key LIMIT 100',[id,query])).rows;
  const orders=(await pool.query('SELECT r.*,w.display_name,w.identity_kind FROM interaction_redemptions r JOIN interaction_wallets w ON w.group_id=r.group_id AND w.actor_key=r.actor_key WHERE r.group_id=$1 ORDER BY r.created_at DESC LIMIT 100',[id])).rows;
  const events=(await pool.query('SELECT e.id,e.outcome,e.locale,e.source_id,CASE WHEN e.delivery_status=\'waiting\' AND e.expires_at<now() THEN \'expired\' ELSE e.delivery_status END delivery_status,e.created_at,w.display_name FROM interaction_events e JOIN interaction_wallets w ON w.group_id=e.group_id AND w.actor_key=e.actor_key WHERE e.group_id=$1 ORDER BY e.created_at DESC LIMIT 100',[id])).rows;
  res.json({wallets,orders,events,ledger:(await pool.query('SELECT l.*,w.display_name FROM interaction_ledger l JOIN interaction_wallets w ON w.group_id=l.group_id AND w.actor_key=l.actor_key WHERE l.group_id=$1 ORDER BY l.id DESC LIMIT 100',[id])).rows});
 });
 app.post('/api/interactions/redemptions/:id/review',async(req,res)=>{const body=z.object({action:z.enum(['approve','fulfill','reject','cancel']),note:z.string().trim().max(300)}).strict().parse(req.body);res.json(await reviewRedemption(uuid(req.params.id),body.action,body.note,req.admin!.username));});
 app.post('/api/interactions/groups/:id/adjust',async(req,res)=>{
  const id=uuid(req.params.id),body=z.object({actor_key:z.string().regex(/^[a-f0-9]{64}$/),delta:z.number().int().min(-100000000).max(100000000).refine(v=>v!==0),reason:z.string().trim().min(1).max(200),request_id:z.uuid()}).strict().parse(req.body);
  await transaction(async db=>{await groupForInteraction(id,db,true);const key='wallet-adjust:'+body.request_id,old=(await db.query('SELECT * FROM interaction_ledger WHERE idempotency_key=$1',[key])).rows[0];
   if(old){requireCondition(old.group_id===id&&old.actor_key===body.actor_key&&old.delta===body.delta&&old.reason==='admin_adjustment: '+body.reason,409,'调整请求标识已用于其他内容');return;}
   const wallet=(await db.query('SELECT * FROM interaction_wallets WHERE group_id=$1 AND actor_key=$2 FOR UPDATE',[id,body.actor_key])).rows[0];requireCondition(wallet,404,'积分账户不存在');requireCondition(wallet.balance+body.delta>=wallet.reserved&&wallet.balance+body.delta<=1000000000,400,'调整后余额不能低于预留积分或超过上限');
   await db.query('UPDATE interaction_wallets SET balance=balance+$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2',[id,body.actor_key,body.delta]);await db.query('INSERT INTO interaction_ledger(group_id,actor_key,delta,reason,actor,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)',[id,body.actor_key,body.delta,'admin_adjustment: '+body.reason,req.admin!.username,key]);await audit(req.admin!.username,'interaction.wallet_adjusted',id,{delta:body.delta,reason:body.reason},db);
  });res.json({ok:true});
 });
 app.post('/api/interactions/groups/:id/templates/retry',async(req,res)=>{const id=uuid(req.params.id);await groupForInteraction(id);await pool.query("UPDATE interaction_templates SET status='pending',error=NULL WHERE group_id=$1 AND status IN('failed','cancelled')",[id]);res.json({ok:true});});
}
