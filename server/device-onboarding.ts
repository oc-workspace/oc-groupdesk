import type express from 'express';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {controlPool,controlTransaction,pool,audit} from './db.js';
import {accessibleBot} from './user-access.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {allowed} from '../shared/user-permissions.js';
import {digest,token,requireCondition} from './security.js';
import {selection,validateSelection} from './models.js';
import {authorizedKey} from './key-vault.js';
import {callTextModel,generationText} from './model-generation.js';
import {installationPrompt,installationContract} from '../shared/installation-guide.js';
import {onboardingReport} from './bot-onboarding.js';
const os=z.enum(['unknown','linux','windows','macos']);
const revision=z.number().int().positive();
const task=async(id:string)=>{const f=(await controlPool.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1',[id])).rows[0];requireCondition(f,404,'尚未开始接入');return f;};
function manage(req:express.Request){requireCondition(allowed(req.admin!,'bots.manage')||allowed(req.admin!,'bots.create'),403,'没有机器人接入权限');}
const site=()=>new URL(process.env.PUBLIC_ORIGIN||'http://localhost:3110').origin;
function selfDesktop(value:string){
 if(!value)return '';let u:URL;try{u=new URL(value);}catch{requireCondition(false,400,'登录入口地址格式无效');throw Error('unreachable');}
 requireCondition(!u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>=1024&&Number(u.port)<=65535),400,'使用 HTTPS 或本设备 127.0.0.1 登录入口，不包含密码或令牌');return u.href;
}
export function registerDevicePairing(app:express.Express){
 app.post('/api/device-onboarding/pair',rateLimit({windowMs:60000,limit:8,standardHeaders:'draft-7',legacyHeaders:false}),async(req,res)=>{
  const body=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),bot_id:z.uuid(),instance_id:z.uuid(),detected_os:os}).strict().parse(req.body),value=token();
  const paired=await controlTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(78511966)');
   const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[body.bot_id])).rows[0];
   const p=(await db.query('SELECT * FROM managed_bot_device_pairings WHERE code_hash=$1 FOR UPDATE',[digest(body.code)])).rows[0];
   const f=(await db.query('SELECT deployment_mode FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[body.bot_id])).rows[0];
   const u=b?(await db.query("SELECT * FROM admins WHERE id=$1 AND deleted_at IS NULL AND status='active'",[b.owner_user_id])).rows[0]:null;
   requireCondition(b&&u&&allowed(u,'bots.manage')&&b.state==='paused'&&b.database_state==='ready'&&!b.runtime_instance_id&&!b.account_fingerprint&&f?.deployment_mode==='self_hosted'&&p&&p.bot_id===b.id&&p.owner_user_id===u.id&&!p.consumed_at&&new Date(p.expires_at).getTime()>Date.now(),409,'配对码无效、已过期/使用，或机器人状态已变化');
   requireCondition(!(await db.query('SELECT 1 FROM managed_bot_adapters WHERE bot_id=$1',[b.id])).rowCount,409,'已有设备接入凭据，请勿重复配对');
   await db.query("INSERT INTO managed_bot_adapters(token_hash,bot_id,name,group_external_ids) VALUES($1,$2,'self-device','[]')",[digest(value),b.id]);
   await db.query('UPDATE managed_bots SET runtime_instance_id=$2,revision=revision+1 WHERE id=$1',[b.id,body.instance_id]);
   await db.query('UPDATE managed_bot_onboarding SET device_os=$2,revision=revision+1,updated_at=now() WHERE bot_id=$1',[b.id,body.detected_os]);
   await db.query('UPDATE managed_bot_device_pairings SET consumed_at=now(),instance_id=$2 WHERE code_hash=$1',[p.code_hash,body.instance_id]);
   await withBot(b.id,async()=>{await pool.query("INSERT INTO runtime_adapters(token_hash,name,group_external_ids) VALUES($1,'self-device','[]') ON CONFLICT(token_hash) DO NOTHING",[digest(value)]);});
   await audit('device','bot.device_paired',b.id,{instance_id:body.instance_id},db);return {wechat_id:b.wechat_id};
  });
  res.json({contract:1,bot_id:body.bot_id,wechat_id:paired.wechat_id,runtime_instance_id:body.instance_id,url:site(),token:value,groups:{},needs_account_setup:true});
 });
}
export function registerDeviceOnboarding(app:express.Express,caller=callTextModel){
 app.put('/api/bots/:id/onboarding/deployment',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);manage(req);
  const body=z.object({revision,deployment_mode:z.enum(['hosted','self_hosted']),device_kind:z.enum(['computer','server'])}).strict().parse(req.body);
  await controlTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(78511966)');
   const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0],f=(await db.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];
   requireCondition(b&&f&&(b.owner_user_id===req.admin!.id||req.admin!.role==='super_admin'),404,'机器人不存在或无权访问');requireCondition(f.revision===body.revision,409,'接入任务已变化，请刷新');
   const changed=(f.deployment_mode||'hosted')!==body.deployment_mode||f.device_kind!==body.device_kind;
   const paired=(await db.query('SELECT 1 FROM managed_bot_device_pairings WHERE bot_id=$1 AND consumed_at IS NOT NULL',[id])).rowCount;
   requireCondition(!changed||b.state==='paused'&&!f.environment_prepared_at&&!f.account_confirmed_at&&!f.reader_authorized_at&&!b.runtime_instance_id&&!b.account_fingerprint&&!paired,409,'运行环境或账号已接入，不能直接更换部署方式；请联系管理员安排迁移');
   await db.query("UPDATE managed_bot_onboarding SET deployment_mode=$3,device_kind=$4,installation_plan=CASE WHEN device_kind<>$4 THEN '' ELSE installation_plan END,installation_plan_at=CASE WHEN device_kind<>$4 THEN NULL ELSE installation_plan_at END,revision=revision+1,updated_at=now() WHERE bot_id=$1 AND revision=$2",[id,body.revision,body.deployment_mode,body.device_kind]);
   if(changed)await db.query('DELETE FROM managed_bot_device_pairings WHERE bot_id=$1 AND consumed_at IS NULL',[id]);
   await audit(req.admin!.username,'bot.deployment_selected',id,{mode:body.deployment_mode,device_kind:body.device_kind},db);
  });res.json(await onboardingReport(id,req.admin!.id,req.admin!.role==='super_admin'));
 });
 app.get('/api/bots/:id/onboarding/install-prompt',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=await accessibleBot(req.admin!,id),f=await task(id);
  res.json({prompt:installationPrompt(b,f.device_os,site(),f.device_kind),contract:1});
 });
 app.get('/api/bots/:id/onboarding/device-tool',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);await task(id);
  const script=await readFile(new URL('../integration/maibot/bots/device_setup.py',import.meta.url),'utf8');
  res.type('text/x-python').attachment('groupdesk-device-setup.py').send(script);
 });
 app.post('/api/bots/:id/onboarding/install-assist',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);manage(req);requireCondition(allowed(req.admin!,'models.manage'),403,'没有模型与 Key 管理权限');
  const body=selection.extend({revision,question:z.string().trim().max(3000),confirmed:z.literal(true)}).strict().parse(req.body),f=await task(id);
  requireCondition(f.deployment_mode==='self_hosted'&&f.revision===body.revision,409,'请先保存自部署方式并刷新任务');
  requireCondition(!/(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password|密钥|密码)\s*[:=：]\s*\S{8,})/i.test(body.question),400,'请勿把 Key、密码或令牌写入需求；在 Key 管理或本地工具安全设置填写');
  const controller=new AbortController(),close=()=>{if(!res.writableEnded)controller.abort();};res.on('close',close);
  try{
   const result=await withBot(id,async()=>{
    await validateSelection(body,'text');await authorizedKey(body.credential_id,body.model_id,'installation');
    const c=(await pool.query('SELECT id,base_url,client_type,revision,enabled FROM model_credentials WHERE id=$1',[body.credential_id])).rows[0];
    const b=await botRecord(id);requireCondition(b&&b.owner_user_id===(await accessibleBot(req.admin!,id)).owner_user_id,409,'机器人归属已变化');
    const response=await caller(c,body.model_id,installationContract,JSON.stringify({request:body.question||'请用非技术用户能理解的方式说明下一步',device_os:f.device_os,guide:installationPrompt(b,f.device_os,site(),f.device_kind)}),{feature:'installation',timeoutMs:95000,maxOutputTokens:4000,signal:controller.signal,lowThinking:true});
    controller.signal.throwIfAborted();await authorizedKey(body.credential_id,body.model_id,'installation');
    const text=generationText(response,c.client_type).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[已隐藏疑似密钥]');requireCondition(text.length<=18000,502,'安装建议过长，请缩短需求后重试');return text;
   });
   await controlTransaction(async db=>{
    const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];requireCondition(b&&(b.owner_user_id===req.admin!.id||req.admin!.role==='super_admin'),409,'机器人归属已变化，未保存建议');
    const saved=await db.query("UPDATE managed_bot_onboarding SET installation_plan=$3,installation_plan_at=now(),installation_model=$4,revision=revision+1,updated_at=now() WHERE bot_id=$1 AND revision=$2 AND deployment_mode='self_hosted' RETURNING bot_id",[id,body.revision,result,{credential_id:body.credential_id,model_id:body.model_id}]);requireCondition(saved.rowCount,409,'生成期间接入任务已变化，未覆盖新设置，请刷新');await audit(req.admin!.username,'bot.installation_advice_generated',id,{credential_id:body.credential_id,model_id:body.model_id,question_sha256:digest(body.question)},db);
   });if(!controller.signal.aborted)res.json(await onboardingReport(id,req.admin!.id,req.admin!.role==='super_admin'));
  }catch(e){if(!controller.signal.aborted)throw e;}finally{res.off('close',close);}
 });
 app.post('/api/bots/:id/onboarding/pair-code',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);manage(req);const body=z.object({revision}).strict().parse(req.body),code=token();
  await controlTransaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(78511966)');const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0],f=(await db.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];
   requireCondition(b&&b.owner_user_id===req.admin!.id,403,'只能由机器人所有人生成设备配对码');requireCondition(allowed(req.admin!,'bots.manage')&&b.state==='paused'&&!b.runtime_instance_id&&!b.account_fingerprint&&f?.deployment_mode==='self_hosted'&&f.revision===body.revision,409,'请先保存自部署方式；已绑定设备不能重复配对');
   requireCondition(!(await db.query('SELECT 1 FROM managed_bot_adapters WHERE bot_id=$1',[id])).rowCount,409,'已有接入凭据，请联系管理员核对，不能覆盖');
   await db.query('DELETE FROM managed_bot_device_pairings WHERE bot_id=$1 AND consumed_at IS NULL',[id]);await db.query("INSERT INTO managed_bot_device_pairings(code_hash,bot_id,owner_user_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[digest(code),id,b.owner_user_id]);await audit(req.admin!.username,'bot.pair_code_created',id,{},db);
  });res.json({code,expires_in:600,display_once:true});
 });
 app.post('/api/bots/:id/onboarding/self-environment',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);manage(req);const body=z.object({revision,desktop_url:z.string().max(500),prepared:z.literal(true)}).strict().parse(req.body),url=selfDesktop(body.desktop_url);
  await controlTransaction(async db=>{
   const b=(await db.query('SELECT * FROM managed_bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0],f=(await db.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];requireCondition(b&&b.owner_user_id===req.admin!.id,403,'只能由机器人所有人确认自己的设备');
   requireCondition(b.state==='paused'&&f?.deployment_mode==='self_hosted'&&f.revision===body.revision&&(await db.query('SELECT 1 FROM managed_bot_device_pairings WHERE bot_id=$1 AND consumed_at IS NOT NULL AND instance_id=$2',[id,b.runtime_instance_id])).rowCount,409,'请先完成当前设备配对，刷新后再确认');
   await db.query('UPDATE managed_bot_onboarding SET environment_prepared_at=now(),environment_prepared_by=$2,desktop_url=$3,revision=revision+1,updated_at=now() WHERE bot_id=$1',[id,req.admin!.id,url]);await audit(req.admin!.username,'bot.self_environment_declared',id,{},db);
  });res.json(await onboardingReport(id,req.admin!.id,false));
 });
}
