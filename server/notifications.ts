import type express from 'express';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition,HttpError} from './security.js';
import {openKey,sealKey} from './model-security.js';
const bodySchema=z.object({adapter_name:z.string().trim().min(1).max(80),recipient_wechat_id:z.string().trim().min(3).max(80),sendkey:z.string().regex(/^SCT[A-Za-z0-9_-]{10,200}$/).optional(),enabled:z.boolean(),binding_confirmed:z.boolean(),revision:z.number().int().min(0)}).strict();
export async function verifyWechatNotification(key:string,fetcher=fetch){
 requireCondition(/^SCT[A-Za-z0-9_-]{10,200}$/.test(key),400,'SendKey格式不正确');
 try{
  const response=await fetcher('https://sctapi.ftqq.com/'+key+'.send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({title:'GT小跟班通知验证',desp:'这是独立微信告警通道的配置验证。微信退出登录、需要扫码或手机确认时，将通过这个通道通知你。常规巡检每小时一次，相同故障不重复提醒。'})});
  requireCondition(response.ok,502,'微信通知服务暂时不可用');
  const data=await response.json();requireCondition(data.code===0,502,'微信通知请求未受理，请检查SendKey、微信接收通道与额度');
 }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'微信通知请求失败，请稍后重试');}
}
export function registerNotificationAdmin(app:express.Express){
 app.get('/api/notifications/wechat',async(_req,res)=>{
  const rows=(await pool.query('SELECT a.name adapter_name,n.recipient_wechat_id,n.enabled,n.binding_confirmed,n.revision,(n.key_ciphertext IS NOT NULL) key_configured FROM runtime_adapters a LEFT JOIN runtime_notifications n ON n.adapter_token_hash=a.token_hash ORDER BY a.name')).rows;
  res.json(rows.map(r=>({...r,revision:r.revision||0})));
 });
 app.put('/api/notifications/wechat',async(req,res)=>{
  const b=bodySchema.parse(req.body);
  await transaction(async db=>{
   await db.query("SELECT pg_advisory_xact_lock(78511944)");
   const adapters=(await db.query('SELECT token_hash FROM runtime_adapters WHERE name=$1',[b.adapter_name])).rows;
   requireCondition(adapters.length===1,400,'请选择唯一的机器人连接');
   const tokenHash=adapters[0].token_hash;
   const old=(await db.query('SELECT * FROM runtime_notifications WHERE adapter_token_hash=$1 FOR UPDATE',[tokenHash])).rows[0];
   requireCondition((old?.revision||0)===b.revision,409,'通知配置已更新，请刷新后重试');
   requireCondition(!b.enabled||b.binding_confirmed,400,'请确认已使用接收方微信完成独立通知绑定');
   const cipher=b.sendkey?sealKey(b.sendkey):old?.key_ciphertext||null;
   requireCondition(!b.enabled||cipher,400,'请填写Server酱Turbo SendKey');
   await db.query('INSERT INTO runtime_notifications(adapter_token_hash,recipient_wechat_id,key_ciphertext,enabled,binding_confirmed,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(adapter_token_hash) DO UPDATE SET recipient_wechat_id=excluded.recipient_wechat_id,key_ciphertext=excluded.key_ciphertext,enabled=excluded.enabled,binding_confirmed=excluded.binding_confirmed,revision=excluded.revision',[tokenHash,b.recipient_wechat_id,cipher,b.enabled,b.binding_confirmed,(old?.revision||0)+1]);
   await audit(req.admin!.username,'notification.wechat_updated',null,{adapter_name:b.adapter_name,enabled:b.enabled},db);
  });res.json({ok:true});
 });
 app.post('/api/notifications/wechat/test',async(req,res)=>{
  const {adapter_name}=z.object({adapter_name:z.string().min(1).max(80)}).strict().parse(req.body);
  const rows=(await pool.query('SELECT n.* FROM runtime_notifications n JOIN runtime_adapters a ON a.token_hash=n.adapter_token_hash WHERE a.name=$1',[adapter_name])).rows;
  requireCondition(rows.length===1&&rows[0].enabled&&rows[0].binding_confirmed&&rows[0].key_ciphertext,409,'请先保存已完成绑定的微信告警配置');
  await verifyWechatNotification(openKey(rows[0].key_ciphertext));
  await audit(req.admin!.username,'notification.wechat_test_requested',null,{adapter_name});
  res.json({ok:true,accepted:true});
 });
}
export function registerNotificationRuntime(app:express.Express){
 app.get('/api/runtime/notification',async(req,res)=>{
  const bearer=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const row=(await pool.query('SELECT * FROM runtime_notifications WHERE adapter_token_hash=$1',[digest(bearer)])).rows[0];
  const configured=!!(row?.enabled&&row?.binding_confirmed&&row?.key_ciphertext);
  res.json({configured,channel:'serverchan',recipient_wechat_id:row?.recipient_wechat_id||null,...(configured?{sendkey:openKey(row.key_ciphertext)}:{})});
 });
}
