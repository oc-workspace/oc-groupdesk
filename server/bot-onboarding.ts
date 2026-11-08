import type express from 'express';
import {z} from 'zod';
import {controlPool,controlTransaction,pool,audit} from './db.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {accessibleBot,superAdmin} from './user-access.js';
import {allowed} from '../shared/user-permissions.js';
import {requireCondition,HttpError} from './security.js';
import {readyForActivation} from './bot-lifecycle.js';
import {validateSelection} from './models.js';
import {authorizedKey} from './key-vault.js';

export async function beginBotOnboarding(id:string,userId:string){
 const b=await botRecord(id);requireCondition(b&&b.state!=='archived',409,'请先恢复已归档机器人');
 await controlPool.query(`INSERT INTO managed_bot_onboarding(bot_id,requested_wechat_id,started_by_user_id) VALUES($1,$2,$3) ON CONFLICT(bot_id) DO NOTHING`,[id,b.wechat_id,userId]);
}
export async function botModelsReady(id:string){
 try{return await withBot(id,async()=>{
  const settings=(await pool.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0]?.routes;
  for(const stage of ['planner','replyer','fast_model','utils']){
   const route=settings?.stages?.[stage]||settings?.text;if(!route)return false;
   await validateSelection(route,'text');
   const key=(await pool.query('SELECT vault_key_id FROM model_credentials WHERE id=$1',[route.credential_id])).rows[0];
   if(!key?.vault_key_id)return false;
   await authorizedKey(route.credential_id,route.model_id,'chat');
  }
  return true;
 });}catch{return false;}
}
export async function onboardingReport(id:string,userId:string,admin:boolean){
 const b=await botRecord(id),f=(await controlPool.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1',[id])).rows[0];
 requireCondition(b&&f,404,'尚未开始接入，请先点击开始接入');
 const sameAccount=f.requested_wechat_id===b.wechat_id;
 const ownerConfirmed=sameAccount&&f.account_confirmed_by===b.owner_user_id&&!!f.account_confirmed_at;
 const authorized=ownerConfirmed&&f.reader_authorized_by===b.owner_user_id&&!!f.reader_authorized_at;
 const prepared=!!f.environment_prepared_at||!!b.runtime_instance_id;
 const fresh=!!b.runtime_seen_at&&Date.now()-new Date(b.runtime_seen_at).getTime()<90000;
 const runtime=!!b.account_fingerprint&&fresh&&b.runtime_status?.revision===b.revision&&b.runtime_status?.wechat_connected===true&&b.runtime_status?.reader_connected===true&&b.runtime_status?.maibot_connected===true&&b.runtime_status?.local_ready===true;
 const models=['legacy','ready'].includes(b.database_state)&&await botModelsReady(id);
 const groups=['legacy','ready'].includes(b.database_state)?await withBot(id,async()=>(await pool.query('SELECT count(*)::int n FROM groups WHERE deleted_at IS NULL AND external_id IS NOT NULL')).rows[0].n):0;
 const canActivate=b.state==='paused'&&prepared&&ownerConfirmed&&authorized&&models&&readyForActivation(b);
 const flags=[true,prepared,ownerConfirmed,authorized,runtime,models,!!f.completed_at||b.state==='active',groups>0];
 const names=['保存微信资料','准备独立运行环境','登录并确认微信账号','授权聊天读取','检查微信与机器人连接','配置 Key 与文字模型','启用机器人','查看微信群与继续接入'];
 const details=[
  '已保存 '+b.name+' · '+b.wechat_id,
  prepared?'运行环境已准备；真实在线情况在第5步单独核对。':'已提交接入申请，等待管理员按现有部署方式准备独立环境。',
  ownerConfirmed?'账号所有人已确认登录账号；系统连接情况仍需第5步核验。':prepared?'打开管理员提供的专属登录入口，用此微信扫码并完成手机确认。':'环境准备好后，这里会提供登录指引。',
  authorized?'已记录当前所有人的账号专属读取授权；不代表读取器已经连接。':'允许本账号的数据库读取、必要的受控启动取钥及加密保存，供此机器人的互动和总结使用。',
  runtime?'微信、读取器和MaiBot的当前版本上报正常。':'等待管理员完成首次群绑定、读取器与运行端配置，再核对真实上报；当前部署工具要求至少绑定一个群。过期或未连接不会标记通过。',
  models?'默认文字路由所需的模型已配置且 Key 权限校验通过；未消耗 token 试调用。':'请配置自己的 Key 或申请公用 Key 授权，再设置默认文字模型；可稍后在群内单独覆盖。',
  b.state==='active'?'机器人已启用。':f.completed_at?'首次接入已完成；当前状态以机器人卡片为准。':'每个用户当前最多启用一个；切换只暂停同一用户的原机器人，等待停止确认后再启用。',
  groups?'已有绑定的微信群。':'首次群绑定由管理员按现有部署流程配合完成；运行端连接后，可在这里管理已有群或继续接入更多群。'];
 const first=flags.slice(0,7).findIndex(v=>!v);
 return {bot_id:id,name:b.name,wechat_id:b.wechat_id,state:b.state,bot_revision:b.revision,revision:f.revision,created_at:f.created_at,completed_at:f.completed_at,
  desktop_url:prepared?f.desktop_url:'',desktop_is_local:!!f.desktop_url&&new URL(f.desktop_url).hostname==='127.0.0.1',
  account_confirmed:ownerConfirmed,reader_authorized:authorized,environment_prepared:prepared,runtime_ready:runtime,models_ready:models,can_activate:canActivate,
  can_confirm:userId===b.owner_user_id,can_prepare:admin,active_limit:1,switch_pending:!!(await controlPool.query('SELECT 1 FROM managed_bot_switch WHERE target_id=$1',[id])).rowCount,
  steps:names.map((name,i)=>({number:i+1,name,required:i<7,status:flags[i]?'complete':i===7?'optional':i===5?'available':i===first?'current':'waiting',detail:details[i]}))};
}
export async function requireOnboardingReady(id:string){
 const f=(await controlPool.query('SELECT 1 FROM managed_bot_onboarding WHERE bot_id=$1',[id])).rows[0];
 if(!f)return; // Existing connected robots retain their established lifecycle.
 const b=await botRecord(id),report=await onboardingReport(id,b.owner_user_id,false);
 requireCondition(report.can_activate,409,'请先完成接入向导中的账号确认、读取授权、连接检查和模型配置');
}
function desktopUrl(value:string){
 if(!value)return '';
 let u:URL;try{u=new URL(value);}catch{throw new HttpError(400,'登录入口地址格式无效');}
 requireCondition(!u.username&&!u.password&&!u.search&&!u.hash,400,'登录入口不能包含密码、令牌、查询参数或片段');
 requireCondition(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1'&&['18080','18180'].includes(u.port),400,'请使用HTTPS登录入口；原本机隧道仅允许18080或18180');
 return u.href;
}
export function registerBotOnboarding(app:express.Express){
 app.get('/api/bots/:id/onboarding',async(req,res)=>{const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);res.json(await onboardingReport(id,req.admin!.id,req.admin!.role==='super_admin'));});
 app.post('/api/bots/:id/onboarding',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.create')||allowed(req.admin!,'bots.manage'),403,'没有机器人接入权限');
  z.object({}).strict().parse(req.body);await beginBotOnboarding(id,req.admin!.id);await audit(req.admin!.username,'bot.onboarding_started',id,{},controlPool);res.json(await onboardingReport(id,req.admin!.id,req.admin!.role==='super_admin'));
 });
 app.put('/api/bots/:id/onboarding/environment',async(req,res)=>{
  superAdmin(req.admin!);const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);
  const body=z.object({revision:z.number().int().positive(),desktop_url:z.string().max(500),prepared:z.literal(true)}).strict().parse(req.body),url=desktopUrl(body.desktop_url);
  await controlTransaction(async db=>{const b=(await db.query('SELECT state FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(b&&b.state!=='archived',409,'机器人已归档');
   const saved=await db.query('UPDATE managed_bot_onboarding SET environment_prepared_at=now(),environment_prepared_by=$3,desktop_url=$4,revision=revision+1,updated_at=now() WHERE bot_id=$1 AND revision=$2 RETURNING bot_id',[id,body.revision,req.admin!.id,url]);requireCondition(saved.rowCount,409,'接入任务已更新，请刷新');await audit(req.admin!.username,'bot.onboarding_environment_prepared',id,{},db);});
  res.json(await onboardingReport(id,req.admin!.id,true));
 });
 for(const action of ['confirm-account','authorize-reader'] as const)app.post('/api/bots/:id/onboarding/'+action,async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await accessibleBot(req.admin!,id);requireCondition(allowed(req.admin!,'bots.create')||allowed(req.admin!,'bots.manage'),403,'没有机器人接入权限');
  const body=z.object({revision:z.number().int().positive(),wechat_id:z.string().max(80),confirmed:z.literal(true)}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const b=(await db.query('SELECT * FROM managed_bots WHERE deleted_at IS NULL AND id=$1 FOR UPDATE',[id])).rows[0];requireCondition(b&&b.state!=='archived'&&b.owner_user_id===req.admin!.id,403,'必须由机器人当前所有人确认');
   const f=(await db.query('SELECT * FROM managed_bot_onboarding WHERE bot_id=$1 FOR UPDATE',[id])).rows[0];requireCondition(f&&f.revision===body.revision&&f.requested_wechat_id===b.wechat_id&&body.wechat_id===b.wechat_id,409,'任务或微信账号已变化，请刷新后重新确认');
   requireCondition(f.environment_prepared_at||b.runtime_instance_id,409,'请先等待运行环境准备完成');
   if(action==='authorize-reader')requireCondition(f.account_confirmed_at&&f.account_confirmed_by===req.admin!.id,409,'请先登录并确认微信账号');
   const clause=action==='confirm-account'?'account_confirmed_at=now(),account_confirmed_by=$2':'reader_authorized_at=now(),reader_authorized_by=$2';
   await db.query('UPDATE managed_bot_onboarding SET '+clause+',revision=revision+1,updated_at=now() WHERE bot_id=$1',[id,req.admin!.id]);
   await audit(req.admin!.username,action==='confirm-account'?'bot.login_declared_by_owner':'bot.reader_authorized_by_owner',id,{wechat_id:b.wechat_id,scope:'own_account_database_only',purpose:'bot_and_summary',encrypted_persistence:action==='authorize-reader'},db);
  });res.json(await onboardingReport(id,req.admin!.id,req.admin!.role==='super_admin'));
 });
}
