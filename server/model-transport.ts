import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {publicAddress,baseUrl} from './model-security.js';
import {requireCondition,HttpError} from './security.js';
export type ModelTransport=(url:URL,key:string,protocol:string,body:any,timeout:number,signal?:AbortSignal,onDispatch?:()=>Promise<void>,hooks?:{start:(type:string)=>void;chunk:(data:Buffer)=>void})=>Promise<{text:string;contentType:string}>;
export const modelTransport:ModelTransport=async(url,key,protocol,body,timeout,signal,onDispatch,hooks)=>{
 baseUrl(url.origin);const addresses=await lookup(url.hostname,{all:true});requireCondition(addresses.length&&addresses.every(a=>publicAddress(a.address)),400,'模型服务地址不可用');signal?.throwIfAborted();const payload=JSON.stringify(body);await onDispatch?.();
 return new Promise((resolve,reject)=>{
  const r=request(url,{method:'POST',signal,family:addresses[0].family,lookup:((_h:unknown,_o:unknown,cb:Function)=>cb(null,addresses[0].address,addresses[0].family)) as any,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...(protocol==='gemini'?{'x-goog-api-key':key}:{Authorization:'Bearer '+key})}},res=>{
   if(res.statusCode!==200){res.resume();reject(new HttpError(502,'模型请求失败（HTTP '+res.statusCode+'）'));return;}
   hooks?.start(String(res.headers['content-type']||'application/json'));const parts:Buffer[]=[];let bytes=0;res.on('data',(p:Buffer)=>{bytes+=p.length;if(bytes>8*1024*1024)r.destroy(new Error('limit'));else{parts.push(p);hooks?.chunk(p);}});res.on('error',()=>reject(new HttpError(502,'模型连接中断')));res.on('end',()=>resolve({text:Buffer.concat(parts).toString(),contentType:String(res.headers['content-type']||'application/json')}));
  });const timer=setTimeout(()=>r.destroy(new Error('timeout')),timeout);r.on('close',()=>clearTimeout(timer));r.on('error',()=>reject(new HttpError(502,'模型连接失败或超时')));r.end(payload);
 });
};
