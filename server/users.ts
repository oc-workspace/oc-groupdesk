import type express from 'express';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {controlPool,controlTransaction,audit} from './db.js';
import {digest,token,secureEqual,requireCondition,HttpError} from './security.js';
import {sealControlSecret,openControlSecret} from './bot-secrets.js';
import {superAdmin} from './user-access.js';
import {permissionLabels} from '../shared/user-permissions.js';
const fields='id,username,display_name,github_id,github_login,role,status,permissions,revision,created_at';
const origin=()=>new URL(process.env.PUBLIC_ORIGIN||'http://localhost:3110').origin;
export const githubCallback=()=>origin()+'/api/auth/github/callback';
export type GithubRequest=(url:string,body?:Record<string,string>,accessToken?:string)=>Promise<any>;
export const githubRequest:GithubRequest=async(url,body,accessToken)=>{
 requireCondition(['https://github.com/login/oauth/access_token','https://api.github.com/user'].includes(url),400,'不支持的 GitHub 地址');
 try{const r=await fetch(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','User-Agent':'GroupDesk',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(accessToken?{Authorization:'Bearer '+accessToken}:{})},body:body?new URLSearchParams(body):undefined});
  requireCondition(r.ok,502,'GitHub 登录暂时不可用，请稍后重试');const text=await r.text();requireCondition(text.length<1000000,502,'GitHub 响应无效');return JSON.parse(text);
 }catch{throw new HttpError(502,'GitHub 登录暂时不可用，请稍后重试');}
};
export async function createUserSession(id:string,res:express.Response){
 const session=token(),csrf=token();await controlPool.query("INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),id,csrf]);
 res.cookie('groupdesk_session',session,{httpOnly:true,secure:process.env.COOKIE_SECURE!=='false',sameSite:'lax',maxAge:12*3600000,path:'/'});return csrf;
}
export function registerGithubAuth(app:express.Express,request:GithubRequest=githubRequest){
 app.get('/api/auth/providers',async(_req,res)=>{const c=(await controlPool.query('SELECT enabled,client_id,secret_ciphertext IS NOT NULL AS configured FROM managed_github_settings')).rows[0];res.json({github:!!(c?.enabled&&c.client_id&&c.configured)});});
 app.get('/api/auth/github/start',async(_req,res)=>{
  const c=(await controlPool.query('SELECT * FROM managed_github_settings')).rows[0];requireCondition(c?.enabled&&c.client_id&&c.secret_ciphertext,503,'GitHub 登录尚未配置，请联系总管理员');
  const state=token(),browser=token(),verifier=token();await controlPool.query("DELETE FROM managed_oauth_states WHERE expires_at<now()");
  await controlPool.query("INSERT INTO managed_oauth_states VALUES($1,$2,$3,$4,now()+interval '10 minutes')",[digest(state),digest(browser),sealControlSecret(verifier),c.revision]);
  res.cookie('groupdesk_oauth',browser,{httpOnly:true,secure:process.env.COOKIE_SECURE!=='false',sameSite:'lax',maxAge:600000,path:'/api/auth/github'});
  const url=new URL('https://github.com/login/oauth/authorize');url.search=new URLSearchParams({client_id:c.client_id,redirect_uri:githubCallback(),state,scope:'',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',allow_signup:'false'}).toString();res.redirect(url.href);
 });
 app.get('/api/auth/github/callback',async(req,res)=>{
  res.setHeader('Referrer-Policy','no-referrer');res.clearCookie('groupdesk_oauth',{path:'/api/auth/github'});
  try{
   const b=z.object({code:z.string().min(1).max(1000),state:z.string().min(20).max(200)}).parse(req.query),browser=req.cookies.groupdesk_oauth;
   requireCondition(typeof browser==='string'&&browser.length>=20,403,'登录校验已过期，请重试');
   const state=(await controlPool.query('DELETE FROM managed_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',[digest(b.state),digest(browser)])).rows[0];requireCondition(state,403,'登录校验已过期，请重试');
   const c=(await controlPool.query('SELECT * FROM managed_github_settings')).rows[0];requireCondition(c?.enabled&&c.revision===state.settings_revision,409,'登录配置已改变，请重试');
   const auth=await request('https://github.com/login/oauth/access_token',{client_id:c.client_id,client_secret:openControlSecret(c.secret_ciphertext),code:b.code,redirect_uri:githubCallback(),code_verifier:openControlSecret(state.verifier_ciphertext)});
   requireCondition(typeof auth.access_token==='string'&&auth.access_token.length>10,502,'GitHub 授权失败');
   const profile=await request('https://api.github.com/user',undefined,auth.access_token);
   requireCondition(Number.isSafeInteger(profile.id)&&profile.id>0&&typeof profile.login==='string'&&/^[a-z0-9-]{1,100}$/i.test(profile.login),502,'GitHub 账号信息无效');
   const user=await controlTransaction(async db=>{
    const live=(await db.query('SELECT enabled,revision FROM managed_github_settings FOR SHARE')).rows[0];requireCondition(live.enabled&&live.revision===c.revision,409,'登录配置已改变，请重试');
    const id=randomUUID(),github=String(profile.id),name=typeof profile.name==='string'?profile.name.slice(0,120):profile.login;
    const result=(await db.query("INSERT INTO admins(id,username,password_hash,github_id,github_login,display_name,role,permissions,status) VALUES($1,$2,'!github-only',$3,$4,$5,'user','{}',$6) ON CONFLICT(github_id) DO UPDATE SET github_login=excluded.github_login,display_name=excluded.display_name RETURNING "+fields,[id,'github:'+github,github,profile.login,name,c.registration_mode==='review'?'pending':'active'])).rows[0];
    requireCondition(result.status!=='disabled',403,'账号已停用，请联系总管理员');await audit(result.username,'auth.github_login',result.id,{},db);return result;
   });
   if(user.status==='pending'){res.redirect(origin()+'/?login_error=pending');return;}await createUserSession(user.id,res);res.redirect(origin()+'/');
  }catch{res.redirect(origin()+'/?login_error=github');}
 });
}
export function registerUserAdmin(app:express.Express){
 app.get('/api/users',async(req,res)=>{superAdmin(req.admin!);res.json({users:(await controlPool.query('SELECT '+fields+' FROM admins ORDER BY created_at,id')).rows,permissions:permissionLabels});});
 app.put('/api/users/:id/access',async(req,res)=>{
  superAdmin(req.admin!);const id=z.uuid().parse(req.params.id),b=z.object({role:z.enum(['super_admin','user']),status:z.enum(['active','disabled','pending']),permissions:z.record(z.string(),z.boolean()).refine(p=>Object.keys(p).every(k=>Object.hasOwn(permissionLabels,k)),'未知权限'),revision:z.number().int().positive()}).strict().parse(req.body);
  await controlTransaction(async db=>{
   const all=(await db.query('SELECT id,role,status,revision FROM admins ORDER BY id FOR UPDATE')).rows,current=all.find(u=>u.id===id);requireCondition(current&&current.revision===b.revision,409,'用户已变化，请刷新');
   requireCondition(b.role==='super_admin'&&b.status==='active'||all.some(u=>u.id!==id&&u.role==='super_admin'&&u.status==='active'),409,'必须保留至少一名可登录的总管理员');
   await db.query('UPDATE admins SET role=$2,status=$3,permissions=$4,revision=revision+1 WHERE id=$1',[id,b.role,b.status,b.permissions]);await db.query('DELETE FROM sessions WHERE admin_id=$1',[id]);await audit(req.admin!.username,'user.access_updated',id,{role:b.role,status:b.status,permissions:b.permissions},db);
  });res.json({ok:true});
 });
 app.get('/api/users/github-settings',async(req,res)=>{superAdmin(req.admin!);const c=(await controlPool.query('SELECT client_id,enabled,registration_mode,revision,secret_ciphertext IS NOT NULL AS has_secret FROM managed_github_settings')).rows[0];res.json({...c,callback_url:githubCallback(),registration_url:'https://github.com/settings/applications/new'});});
 app.put('/api/users/github-settings',async(req,res)=>{
  superAdmin(req.admin!);const b=z.object({client_id:z.string().trim().max(200),client_secret:z.string().trim().max(500).optional(),enabled:z.boolean(),registration_mode:z.enum(['auto','review']),revision:z.number().int().positive()}).strict().parse(req.body);
  await controlTransaction(async db=>{const c=(await db.query('SELECT * FROM managed_github_settings FOR UPDATE')).rows[0];requireCondition(c.revision===b.revision,409,'配置已变化，请刷新');
   requireCondition(c.client_id===b.client_id||!!b.client_secret,400,'更换 Client ID 时请同时填写对应 Secret');requireCondition(!b.enabled||b.client_id&&(b.client_secret||c.secret_ciphertext),400,'请先填写 Client ID 与 Secret');
   await db.query('UPDATE managed_github_settings SET client_id=$1,secret_ciphertext=COALESCE($2,secret_ciphertext),enabled=$3,registration_mode=$4,revision=revision+1',[b.client_id,b.client_secret?sealControlSecret(b.client_secret):null,b.enabled,b.registration_mode]);await db.query('DELETE FROM managed_oauth_states');await audit(req.admin!.username,'auth.github_settings_updated',null,{enabled:b.enabled},db);
  });res.json({ok:true});
 });
 app.put('/api/users/bot-owner/:id',async(req,res)=>{
  superAdmin(req.admin!);const id=z.uuid().parse(req.params.id),b=z.object({owner_user_id:z.uuid()}).strict().parse(req.body);
  await controlTransaction(async db=>{requireCondition((await db.query("SELECT 1 FROM admins WHERE id=$1 AND status='active'",[b.owner_user_id])).rowCount,400,'请选择有效用户');requireCondition((await db.query('UPDATE managed_bots SET owner_user_id=$2 WHERE id=$1 RETURNING id',[id,b.owner_user_id])).rowCount,404,'机器人不存在');await audit(req.admin!.username,'bot.owner_changed',id,{owner_user_id:b.owner_user_id},db);});res.json({ok:true});
 });
}
