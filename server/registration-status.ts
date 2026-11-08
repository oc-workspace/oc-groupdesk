import type express from 'express';
import {z} from 'zod';
import {controlPool} from './db.js';
import {sealControlSecret,openControlSecret} from './bot-secrets.js';

const cookieName='groupdesk_registration';
const lifetime=7*24*60*60*1000;
const receiptSchema=z.object({purpose:z.literal('github-registration-status'),userId:z.uuid(),expiresAt:z.number().int().positive()}).strict();
const options=()=>({httpOnly:true,secure:process.env.COOKIE_SECURE!=='false',sameSite:'lax' as const,path:'/api/auth'});
export function clearRegistrationReceipt(res:express.Response){res.clearCookie(cookieName,options());}
export function setRegistrationReceipt(res:express.Response,userId:string){
 res.cookie(cookieName,sealControlSecret(JSON.stringify({purpose:'github-registration-status',userId,expiresAt:Date.now()+lifetime})),{...options(),maxAge:lifetime});
}
export function registerRegistrationStatus(app:express.Express){
 app.get('/api/auth/registration-status',async(req,res)=>{
  const raw=req.cookies[cookieName];
  if(typeof raw!=='string')return res.json({status:'unverified'});
  let receipt:z.infer<typeof receiptSchema>;
  try{
   if(raw.length>2000)throw Error('Invalid receipt');
   receipt=receiptSchema.parse(JSON.parse(openControlSecret(raw)));
   if(receipt.expiresAt<=Date.now()||receipt.expiresAt>Date.now()+lifetime)throw Error('Expired receipt');
  }catch{clearRegistrationReceipt(res);return res.json({status:'unverified'});}
  // This receipt only authorizes a minimal status lookup, never a login or business access.
  const user=(await controlPool.query('SELECT status,deleted_at FROM admins WHERE id=$1',[receipt.userId])).rows[0];
  if(!user||user.deleted_at){clearRegistrationReceipt(res);return res.json({status:'unavailable'});}
  return res.json({status:({pending:'pending',active:'approved',disabled:'disabled'} as Record<string,string>)[user.status]||'unavailable'});
 });
}
