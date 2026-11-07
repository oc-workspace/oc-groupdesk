import {accessibleBot,superAdmin} from './user-access.js';
import {allowed} from '../shared/user-permissions.js';
import type express from 'express';
import {z} from 'zod';
import {controlPool,controlTransaction,audit,pool} from './db.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {createBot} from './bot-provisioning.js';
import {requestPause,requestActivation,archiveBot} from './bot-lifecycle.js';
import {token,digest,requireCondition} from './security.js';
const metadata=z.object({name:z.string().trim().min(1).max(80),wechat_id:z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.\-]+$/),host_label:z.string().trim().max(100).default('rococo-root2'),notes:z.string().max(1000).default('')}).strict();
const publicFields='id,name,wechat_id,host_label,notes,state,database_state,revision,activation_generation,runtime_status,runtime_seen_at,stopped_revision,pause_requested_at,error,created_at';
export function registerBotAdmin(app:express.Express){
 app.get('/api/bots',async(req,res)=>{
  const rows=(await controlPool.query('SELECT '+publicFields+',owner_user_id,created_by_user_id FROM managed_bots WHERE ($1::boolean OR owner_user_id=$2) ORDER BY created_at,id',[req.admin!.role==='super_admin',req.admin!.id])).rows;
  for(const row of rows){row.group_count=null;if(['legacy','ready'].includes(row.database_state))try{row.group_count=await withBot(row.id,async()=>(await pool.query('SELECT count(*)::int n FROM groups')).rows[0].n);}catch{row.workspace_unavailable=true;}}
  res.json({bots:rows,switch:req.admin!.role==='super_admin'?(await controlPool.query('SELECT target_id,requested_at FROM managed_bot_switch WHERE singleton=true')).rows[0]||null:null});
 });
 app.post('/api/bots',async(req,res)=>{requireCondition(allowed(req.admin!,'bots.create'),403,'没有创建机器人的权限');const input=metadata.parse(req.body),id=await createBot(input,req.admin!.username);await controlPool.query('UPDATE managed_bots SET owner_user_id=$2,created_by_user_id=$2 WHERE id=$1',[id,req.admin!.id]);res.status(201).json({id});});
 app.put('/api/bots/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.manage'),403,'没有管理机器人的权限');const body=metadata.extend({revision:z.number().int().positive()}).parse(req.body);
  const result=await controlPool.query('UPDATE managed_bots SET name=$2,wechat_id=$3,host_label=$4,notes=$5,revision=revision+1 WHERE id=$1 AND revision=$6 AND (wechat_id=$3 OR (state=\'paused\' AND account_fingerprint IS NULL)) AND (state=\'paused\' OR host_label=$4) RETURNING id',[id,body.name,body.wechat_id,body.host_label,body.notes,body.revision]);
  requireCondition(result.rowCount,409,'状态已变化；更换微信账号或服务器前请先暂停并确认');await audit(req.admin!.username,'bot.metadata_updated',id,{},controlPool);res.json({ok:true});
 });
 for(const action of ['pause','activate','archive','restore'] as const)app.post('/api/bots/:id/'+action,async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.manage'),403,'没有管理机器人的权限');const body=z.object({revision:z.number().int().positive()}).strict().parse(req.body);
  if(action==='activate')superAdmin(req.admin!);if(action==='pause')await requestPause(id,body.revision,req.admin!.username);else if(action==='activate')await requestActivation(id,body.revision,req.admin!.username);else await archiveBot(id,body.revision,action==='archive',req.admin!.username);
  res.json({ok:true,pending:['pause','activate'].includes(action)});
 });
 app.post('/api/bots/:id/connection-token',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.manage'),403,'没有管理机器人的权限');const body=z.object({revision:z.number().int().positive()}).strict().parse(req.body),value=token(),hash=digest(value);
  await controlTransaction(async db=>{const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 FOR UPDATE',[id])).rows[0];requireCondition(b?.state==='paused'&&b.revision===body.revision&&b.database_state==='ready',409,'请先准备好停用状态的独立业务空间');
   await db.query('DELETE FROM managed_bot_adapters WHERE bot_id=$1',[id]);await db.query('INSERT INTO managed_bot_adapters(token_hash,bot_id,name,group_external_ids) VALUES($1,$2,$3,\'[]\')',[hash,id,'adapter-'+id]);
   await db.query('UPDATE managed_bots SET runtime_instance_id=NULL,runtime_status=\'{}\',runtime_seen_at=NULL,stopped_revision=NULL,revision=revision+1 WHERE id=$1',[id]);await audit(req.admin!.username,'bot.connection_token_rotated',id,{},db);
  });
  await withBot(id,async()=>{await pool.query('DELETE FROM runtime_adapters');await pool.query("INSERT INTO runtime_adapters(token_hash,name,group_external_ids) VALUES($1,$2,'[]')",[hash,'adapter-'+id]);});
  res.json({bot_id:id,token:value,display_once:true});
 });
 app.get('/api/bots/:id/connection',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);const row=await botRecord(id);requireCondition(row,404,'机器人不存在');
  const groups=['legacy','ready'].includes(row.database_state)?await withBot(id,async()=>(await pool.query('SELECT id,name,external_id,created_by_user_id FROM groups ORDER BY created_at')).rows):[];
  const adapters=(await controlPool.query('SELECT name,group_external_ids FROM managed_bot_adapters WHERE bot_id=$1 ORDER BY created_at',[id])).rows;
  res.json({bot_id:id,wechat_id:row.wechat_id,groups,adapters,identity_bound:!!row.account_fingerprint});
 });
 app.put('/api/bots/:id/connection-groups',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.manage'),403,'没有管理机器人的权限');const body=z.object({external_ids:z.array(z.string().min(1).max(200)).max(100)}).strict().parse(req.body);
  requireCondition(new Set(body.external_ids).size===body.external_ids.length,400,'群标识不能重复');const row=await botRecord(id);requireCondition(row&&row.state==='paused',409,'修改接入白名单前请先暂停');
  const n=await withBot(id,async()=>(await pool.query('SELECT count(*)::int n FROM groups WHERE external_id=ANY($1::text[])',[body.external_ids])).rows[0].n);requireCondition(n===body.external_ids.length,400,'白名单只能选择本机器人已绑定的群');
  const adapters=(await controlPool.query('SELECT token_hash FROM managed_bot_adapters WHERE bot_id=$1',[id])).rows;requireCondition(adapters.length===1,409,'请先生成独立接入凭据');
  await controlPool.query('UPDATE managed_bot_adapters SET group_external_ids=$2 WHERE bot_id=$1',[id,JSON.stringify(body.external_ids)]);
  await withBot(id,async()=>{await pool.query('UPDATE runtime_adapters SET group_external_ids=$1',[JSON.stringify(body.external_ids)]);});await audit(req.admin!.username,'bot.connection_groups_updated',id,{},controlPool);res.json({ok:true});
 });
}
