import type express from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {accessibleBot,superAdmin} from './user-access.js';
import {allowed} from '../shared/user-permissions.js';
import {requireCondition} from './security.js';

const id=z.uuid();
const kind=z.enum(['host_move','same_host_upgrade','connection_config']);
const host=z.enum(['rococo-root','rococo-root2','rpi-groupdesk-01']);
const checks=z.object({source_stopped:z.boolean(),data_verified:z.boolean(),target_ready:z.boolean(),identity_verified:z.boolean(),reader_verified:z.boolean(),reply_still_paused:z.boolean()}).strict();

export function registerBotDeploymentChanges(app:express.Express){
 app.get('/api/bot-deployment-hosts',async(req,res)=>{
  requireCondition(allowed(req.admin!,'bots.manage'),403,'没有机器人管理权限');
  const hosts=(await controlPool.query("SELECT id,name FROM managed_runtime_hosts WHERE id<>'rococo-root' ORDER BY id")).rows;
  res.json({hosts});
 });
 app.get('/api/bots/:id/deployment-changes',async(req,res)=>{
  const botId=id.parse(req.params.id);const bot=await accessibleBot(req.admin!,botId);
  const rows=(await controlPool.query('SELECT id,bot_id,source_host_id,target_host_id,kind,state,reason,verification,created_at,approved_at,completed_at FROM managed_bot_deployment_changes WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 30',[botId])).rows;
  res.json({changes:rows,current_host_id:bot.runtime_host_id||null});
 });
 app.post('/api/bots/:id/deployment-changes',async(req,res)=>{
  const botId=id.parse(req.params.id);await accessibleBot(req.admin!,botId);
  requireCondition(allowed(req.admin!,'bots.manage'),403,'没有机器人管理权限');
  const body=z.object({kind,target_host_id:host,reason:z.string().trim().min(10).max(1000),revision:z.number().int().positive()}).strict().parse(req.body);
  const changeId=randomUUID();
  await controlTransaction(async db=>{
   const bot=(await db.query('SELECT state,revision,runtime_host_id,owner_user_id FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[botId])).rows[0];
   requireCondition(bot&&(req.admin!.role==='super_admin'||bot.owner_user_id===req.admin!.id),404,'机器人不存在或无权访问');
   requireCondition(bot.state==='paused'&&bot.revision===body.revision,409,'请先暂停机器人并刷新版本');
   requireCondition(body.kind==='host_move' ? bot.runtime_host_id!==body.target_host_id : bot.runtime_host_id===body.target_host_id,409,'变更类型与目标主机不匹配');
   requireCondition((await db.query('SELECT 1 FROM managed_runtime_hosts WHERE id=$1',[body.target_host_id])).rowCount,400,'目标主机尚未登记');
   requireCondition(!(await db.query("SELECT 1 FROM managed_bot_deployment_changes WHERE bot_id=$1 AND state IN ('requested','approved','verifying')",[botId])).rowCount,409,'已有未完成的部署变更');
   await db.query("INSERT INTO managed_bot_deployment_changes(id,bot_id,source_host_id,target_host_id,kind,state,reason,expected_bot_revision,requested_by) VALUES($1,$2,$3,$4,$5,'requested',$6,$7,$8)",[changeId,botId,bot.runtime_host_id,body.target_host_id,body.kind,body.reason,body.revision,req.admin!.id]);
   await audit(req.admin!.username,'bot.deployment_change_requested',botId,{change_id:changeId,kind:body.kind,source:bot.runtime_host_id,target:body.target_host_id},db);
  });res.status(201).json({id:changeId,state:'requested'});
 });
 app.post('/api/bots/:id/deployment-changes/:change/approve',async(req,res)=>{
  superAdmin(req.admin!);const botId=id.parse(req.params.id),changeId=id.parse(req.params.change);z.object({}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const row=(await db.query("SELECT c.*,b.state bot_state,b.revision bot_revision FROM managed_bot_deployment_changes c JOIN managed_bots b ON b.id=c.bot_id WHERE c.id=$1 AND c.bot_id=$2 FOR UPDATE OF c",[changeId,botId])).rows[0];
   requireCondition(row&&row.state==='requested'&&row.bot_state==='paused'&&row.bot_revision===row.expected_bot_revision,409,'变更或机器人状态已变化');
   await db.query("UPDATE managed_bot_deployment_changes SET state='approved',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1",[changeId,req.admin!.id]);
   await audit(req.admin!.username,'bot.deployment_change_approved',botId,{change_id:changeId},db);
  });res.json({ok:true,state:'approved'});
 });
 app.post('/api/bots/:id/deployment-changes/:change/verify',async(req,res)=>{
  superAdmin(req.admin!);const botId=id.parse(req.params.id),changeId=id.parse(req.params.change),body=checks.parse(req.body);
  requireCondition(Object.values(body).every(Boolean),409,'请完成所有现场核验');
  await controlTransaction(async db=>{
   const row=(await db.query("SELECT c.*,b.state bot_state,b.revision bot_revision FROM managed_bot_deployment_changes c JOIN managed_bots b ON b.id=c.bot_id WHERE c.id=$1 AND c.bot_id=$2 FOR UPDATE OF c",[changeId,botId])).rows[0];
   requireCondition(row&&row.state==='approved'&&row.bot_state==='paused'&&row.bot_revision===row.expected_bot_revision,409,'变更或机器人状态已变化');
   const target=(await db.query('SELECT enabled,last_seen_at FROM managed_runtime_hosts WHERE id=$1',[row.target_host_id])).rows[0];
   requireCondition(target?.enabled&&target.last_seen_at&&Date.now()-new Date(target.last_seen_at).getTime()<180000,409,'目标主机代理未在线');
   const snapshot=(await db.query('SELECT report,created_at FROM managed_runtime_snapshots WHERE host_id=$1 ORDER BY created_at DESC LIMIT 1',[row.target_host_id])).rows[0];
   requireCondition(snapshot&&Date.now()-new Date(snapshot.created_at).getTime()<15*60000&&snapshot.report?.bots?.some((b:any)=>b.bot_id===botId&&!b.blocked?.length),409,'目标主机缺少近期且无阻断的机器人盘点');
   if(row.source_host_id&&row.source_host_id!==row.target_host_id){
    const source=(await db.query('SELECT enabled FROM managed_runtime_hosts WHERE id=$1',[row.source_host_id])).rows[0];
    if(source?.enabled){const old=(await db.query('SELECT report,created_at FROM managed_runtime_snapshots WHERE host_id=$1 ORDER BY created_at DESC LIMIT 1',[row.source_host_id])).rows[0];requireCondition(old&&Date.now()-new Date(old.created_at).getTime()<15*60000&&!old.report?.bots?.some((b:any)=>b.bot_id===botId&&b.containers?.some((c:any)=>c.running)),409,'源主机仍有运行容器或缺少近期停止盘点');}
   }
   await db.query("UPDATE managed_bot_deployment_changes SET state='verifying',verification=$2,updated_at=now() WHERE id=$1",[changeId,body]);
   await audit(req.admin!.username,'bot.deployment_change_verified',botId,{change_id:changeId,checks:body},db);
  });res.json({ok:true,state:'verifying'});
 });
 app.post('/api/bots/:id/deployment-changes/:change/complete',async(req,res)=>{
  superAdmin(req.admin!);const botId=id.parse(req.params.id),changeId=id.parse(req.params.change);z.object({}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const row=(await db.query("SELECT c.*,b.state bot_state,b.revision bot_revision,b.account_fingerprint,b.runtime_status,b.runtime_seen_at FROM managed_bot_deployment_changes c JOIN managed_bots b ON b.id=c.bot_id WHERE c.id=$1 AND c.bot_id=$2 FOR UPDATE OF c",[changeId,botId])).rows[0];
   requireCondition(row&&row.state==='verifying'&&row.bot_state==='paused'&&row.bot_revision===row.expected_bot_revision,409,'变更或机器人状态已变化');
   if(row.account_fingerprint){const s=row.runtime_status||{};requireCondition(row.runtime_seen_at&&Date.now()-new Date(row.runtime_seen_at).getTime()<90000&&s.wechat_connected===true&&s.reader_connected===true&&s.maibot_connected===true&&s.local_ready===true,409,'微信、Reader 或 MaiBot 运行状态尚未通过现场确认');}
   const target=(await db.query('SELECT enabled,last_seen_at FROM managed_runtime_hosts WHERE id=$1',[row.target_host_id])).rows[0];
   requireCondition(target?.enabled&&target.last_seen_at&&Date.now()-new Date(target.last_seen_at).getTime()<180000,409,'目标主机代理未在线');
   await db.query('UPDATE managed_bots SET runtime_host_id=$2,host_label=$2,revision=revision+1 WHERE id=$1',[botId,row.target_host_id]);
   await db.query("UPDATE managed_bot_deployment_changes SET state='completed',completed_by=$2,completed_at=now(),updated_at=now() WHERE id=$1",[changeId,req.admin!.id]);
   await audit(req.admin!.username,'bot.deployment_change_completed',botId,{change_id:changeId,source:row.source_host_id,target:row.target_host_id},db);
  });res.json({ok:true,state:'completed'});
 });
 app.post('/api/bots/:id/deployment-changes/:change/cancel',async(req,res)=>{
  superAdmin(req.admin!);const botId=id.parse(req.params.id),changeId=id.parse(req.params.change);z.object({}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const row=(await db.query("UPDATE managed_bot_deployment_changes SET state='cancelled',updated_at=now() WHERE id=$1 AND bot_id=$2 AND state IN ('requested','approved','verifying') RETURNING id",[changeId,botId])).rows[0];
   requireCondition(row,409,'变更已结束');await audit(req.admin!.username,'bot.deployment_change_cancelled',botId,{change_id:changeId},db);
  });res.json({ok:true,state:'cancelled'});
 });
}
