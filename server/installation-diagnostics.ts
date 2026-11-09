import type express from 'express';
import {z} from 'zod';
import {rateLimit} from 'express-rate-limit';
import {createHash,randomUUID} from 'node:crypto';
import {controlPool,controlTransaction,audit} from './db.js';
import {accessibleBot} from './user-access.js';
import {allowed,type SessionUser} from '../shared/user-permissions.js';
import {installationReportBatch,installationReportSchema,readingModes,type InstallationReport} from '../shared/installation-diagnostics.js';
import {digest,requireCondition} from './security.js';
import {isSelfDeployment} from '../shared/computer-onboarding.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,Object.keys(value as object).sort())).digest('hex');
export async function installationSummary(id:string){
 const p=(await controlPool.query('SELECT reading_mode,reported_method,reported_source,reported_at FROM managed_bot_installation_preferences WHERE bot_id=$1',[id])).rows[0];
 return {reading_mode:p?.reading_mode||'auto',reported_method:p?.reported_method||'unknown',reported_source:p?.reported_source||null,reported_at:p?.reported_at||null,report_count:(await controlPool.query('SELECT count(*)::int n FROM managed_bot_installation_events WHERE bot_id=$1',[id])).rows[0].n};
}
async function saveReports(id:string,events:InstallationReport[],source:'owner_upload'|'paired_device'|'site',actor:string,db:any){
 if(events.some(event=>event.used_method!=='unknown')){
  const authorized=(await db.query('SELECT 1 FROM managed_bot_onboarding f JOIN managed_bots b ON b.id=f.bot_id WHERE b.id=$1 AND f.requested_wechat_id=b.wechat_id AND f.account_confirmed_at IS NOT NULL AND f.account_confirmed_by=b.owner_user_id AND f.reader_authorized_at IS NOT NULL AND f.reader_authorized_by=b.owner_user_id',[id])).rowCount;
  requireCondition(authorized,409,'请先在第2步确认登录和读取授权，再提交实际读取成功报告');
 }
 for(const event of events){
  const old=(await db.query('SELECT details FROM managed_bot_installation_events WHERE bot_id=$1 AND report_id=$2',[id,event.report_id])).rows[0];
  requireCondition(!old||hash(old.details)===hash(event),409,'报告编号已存在但内容不同，请重新生成报告');
  if(old)continue;
  await db.query('INSERT INTO managed_bot_installation_events(bot_id,report_id,source,details) VALUES($1,$2,$3,$4)',[id,event.report_id,source,event]);
  if(event.phase==='verify'&&event.outcome==='success'&&event.used_method!=='unknown')await db.query(`INSERT INTO managed_bot_installation_preferences(bot_id,reading_mode,reported_method,reported_source,reported_at) VALUES($1,'auto',$2,$3,now()) ON CONFLICT(bot_id) DO UPDATE SET reported_method=$2,reported_source=$3,reported_at=now()`,[id,event.used_method,source]);
 }
 // Bounded diagnostic history. No raw stdout, chat, paths, tokens or arbitrary notes are accepted.
 await db.query('DELETE FROM managed_bot_installation_events WHERE bot_id=$1 AND report_id IN(SELECT report_id FROM managed_bot_installation_events WHERE bot_id=$1 ORDER BY event_seq DESC OFFSET 50)',[id]);
 await audit(actor,'bot.installation_reports_received',id,{source,count:events.length},db);
}
export function registerInstallationDeviceReports(app:express.Express){
 app.post('/api/device-onboarding/report',rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-7',legacyHeaders:false}),async(req,res)=>{
  const match=/^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(req.headers.authorization||'');requireCondition(match,401,'设备身份验证失败');
  const body=z.object({bot_id:z.uuid(),instance_id:z.uuid(),report:installationReportBatch}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const b=(await db.query("SELECT b.*,a.status owner_status,a.permissions owner_permissions,a.role owner_role FROM managed_bots b JOIN admins a ON a.id=b.owner_user_id JOIN managed_bot_adapters x ON x.bot_id=b.id WHERE x.token_hash=$1 AND b.id=$2 AND b.deleted_at IS NULL AND a.deleted_at IS NULL FOR UPDATE OF b",[digest(match![1]),body.bot_id])).rows[0];
   requireCondition(b&&b.owner_status==='active'&&allowed({role:b.owner_role,permissions:b.owner_permissions},'bots.manage')&&['active','paused','pausing'].includes(b.state)&&b.runtime_instance_id===body.instance_id,403,'设备不属于此机器人、权限已撤销或状态已变化');
   await saveReports(b.id,body.report.events,'paired_device','device',db);
  });res.json({ok:true});
 });
}
export function registerInstallationAdmin(app:express.Express,reporter:(id:string,user:SessionUser)=>Promise<unknown>){
 app.get('/api/bots/:id/onboarding/installation-log',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);
  res.json({summary:await installationSummary(id),events:(await controlPool.query('SELECT report_id,received_at,source,details FROM managed_bot_installation_events WHERE bot_id=$1 ORDER BY event_seq DESC LIMIT 50',[id])).rows});
 });
 app.put('/api/bots/:id/onboarding/reading-mode',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);
  const body=z.object({revision:z.number().int().positive(),reading_mode:z.enum(readingModes)}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0],f=(await db.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];
   requireCondition(b?.owner_user_id===req.admin!.id&&allowed(req.admin!,'bots.manage'),403,'请由机器人所有人在本人账号选择');
   requireCondition(f&&f.revision===body.revision,409,'接入任务已变化，请刷新');
   requireCondition(isSelfDeployment(f)&&b.state==='paused'&&!b.runtime_instance_id&&!b.account_fingerprint&&!f.environment_prepared_at&&!f.account_confirmed_at&&!f.reader_authorized_at,409,'已有环境或设备已绑定，不能直接切换读取方式；请先安排迁移核对');
   await db.query('INSERT INTO managed_bot_installation_preferences(bot_id,reading_mode,updated_by_user_id) VALUES($1,$2,$3) ON CONFLICT(bot_id) DO UPDATE SET reading_mode=$2,updated_by_user_id=$3,updated_at=now()',[id,body.reading_mode,req.admin!.id]);
   await db.query('UPDATE managed_bot_onboarding SET revision=revision+1,updated_at=now() WHERE bot_id=$1',[id]);
   await saveReports(id,[installationReportSchema.parse({contract:1,report_id:randomUUID(),generated_at:new Date().toISOString(),phase:'plan',outcome:'planned',reading_mode:body.reading_mode,selected_method:body.reading_mode==='gui'?'gui':'unknown',used_method:'unknown',platform:'unknown',arch:'unknown',wechat_version:'unknown',compatibility:'unknown',failure_code:'none'})],'site',req.admin!.username,db);
   await audit(req.admin!.username,'bot.reading_mode_selected',id,{reading_mode:body.reading_mode},db);
  });res.json(await reporter(id,req.admin!));
 });
 app.post('/api/bots/:id/onboarding/installation-log',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);const report=installationReportBatch.parse(req.body);
  await controlTransaction(async db=>{
   const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
   requireCondition(b?.owner_user_id===req.admin!.id&&allowed(req.admin!,'bots.manage'),403,'只能由机器人所有人上传自己的安装报告');
   requireCondition(b.state!=='archived',409,'机器人已归档');await saveReports(id,report.events,'owner_upload',req.admin!.username,db);
  });res.json({ok:true,summary:await installationSummary(id)});
 });
}
