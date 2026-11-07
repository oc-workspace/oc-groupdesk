import type express from 'express';
import {z} from 'zod';
import {sealControlSecret,openControlSecret} from './bot-secrets.js';
import {botId,keyForAlias,authorizedKey,reserveUsage,settleUsage,parseUsage,type CallScope} from './key-vault.js';
import {botStorage} from './bot-context.js';
import {botRecord,botScope} from './bot-workspaces.js';
import {pool,controlPool} from './db.js';
import {requireCondition} from './security.js';
import {modelTransport,type ModelTransport} from './model-transport.js';
export function upstreamUrl(base:string,protocol:string,model:string,stream=false){
 if(protocol==='gemini'){const prefix=/\/v\d+(?:alpha|beta)?\d*$/.test(new URL(base).pathname)?base:base+'/v1beta';return new URL(prefix+'/models/'+encodeURIComponent(model)+(stream?':streamGenerateContent?alt=sse':':generateContent'));}
 return new URL(base+(protocol==='openai_responses'?'/responses':'/chat/completions'));
}
export function responseUsage(text:string){try{return JSON.parse(text);}catch{let usage:any=null;for(const line of text.split('\n'))if(line.startsWith('data:'))try{const obj=JSON.parse(line.slice(5));if(parseUsage(obj))usage=obj;}catch{}return usage;}}
export function outputLimit(body:any,protocol:string){const n=protocol==='gemini'?body.generationConfig?.maxOutputTokens:body.max_output_tokens??body.max_completion_tokens??body.max_tokens;requireCondition(n==null||Number.isSafeInteger(n)&&n>=1&&n<=32768,400,'单次输出上限须为1—32768 token');const limit=n??8192;if(protocol==='gemini')body.generationConfig={...body.generationConfig,maxOutputTokens:limit};else if(protocol==='openai_responses'){body.max_output_tokens=limit;delete body.max_tokens;delete body.max_completion_tokens;}else if(body.max_completion_tokens!=null){body.max_completion_tokens=limit;delete body.max_tokens;delete body.max_output_tokens;}else{body.max_tokens=limit;delete body.max_output_tokens;}return limit;}
export async function executeKeyCall(alias:string,model:string,scope:CallScope,body:any,timeout=310000,signal?:AbortSignal,transport:ModelTransport=modelTransport){
 const c=await keyForAlias(alias),stream=body.stream===true||body.__gemini_stream===true;delete body.__gemini_stream;const limit=outputLimit(body,c.client_type);if(c.client_type!=='gemini')body.store=false;
 requireCondition(!body.background,400,'不支持后台脱离请求执行');
 requireCondition((body.n==null||body.n===1)&&(body.generationConfig?.candidateCount==null||body.generationConfig.candidateCount===1),400,'每次仅生成一个结果');
 const bytes=Buffer.byteLength(JSON.stringify(body));requireCondition(bytes<=1024*1024,400,'模型请求过大');
 if(c.scope==='site'){const text=JSON.stringify(body);requireCondition(!/"(?:inlineData|fileData|image_url|input_image|input_audio|input_file|video_url)"/.test(text),400,'公用 Key 暂只接受可计量的文字请求；多媒体请使用私有 Key');requireCondition(!body.tools||Array.isArray(body.tools)&&body.tools.every((t:any)=>c.client_type==='gemini'?Object.keys(t).every(key=>key==='functionDeclarations')&&Array.isArray(t.functionDeclarations):t.type==='function'),400,'公用 Key 未开放服务商额外付费工具');}
 const reservation=await reserveUsage(alias,model,scope,bytes,limit);let dispatched=false;
 try{
  const result=await transport(upstreamUrl(c.base_url,c.client_type,model,stream),openControlSecret(c.secret_ciphertext),c.client_type,body,timeout,signal,async()=>{await controlPool.query('UPDATE managed_model_usage SET dispatched=true WHERE id=$1',[reservation.id]);dispatched=true;});
  await settleUsage(reservation,responseUsage(result.text),true);return result;
 }catch(e){await settleUsage(reservation,null,dispatched,'request_failed');throw e;}
}
export async function proxyRoute(route:any,groupId:string,stage='chat'){
 await authorizedKey(route.credential_id,route.model_id,'chat',groupId);const g=(await pool.query('SELECT revision FROM groups WHERE id=$1',[groupId])).rows[0];
 const key=await keyForAlias(route.credential_id),permit=sealControlSecret(JSON.stringify({bot:botId(),group:groupId,revision:g.revision,alias:route.credential_id,key:key.id,key_revision:key.revision,model:route.model_id,stage,expires:Date.now()+75000}));
 const origin=new URL(process.env.PUBLIC_ORIGIN||'http://localhost:3110').origin;
 return {...route,base_url:origin+'/api/model-proxy'+(key.client_type==='gemini'?'':'/v1'),api_key:permit,client_type:key.client_type};
}
export function registerModelProxy(app:express.Express,transport:ModelTransport=modelTransport){
 app.post('/api/model-proxy/*path',async(req,res)=>{
  let p:any;try{const auth=(req.headers['x-goog-api-key']||String(req.headers.authorization||'').replace(/^Bearer /,'')).toString();requireCondition(auth.length<5000,401,'模型调用凭据无效');p=JSON.parse(openControlSecret(auth));}catch{requireCondition(false,401,'模型调用凭据无效');}
  const s=z.object({bot:z.uuid(),group:z.uuid(),revision:z.number(),alias:z.uuid(),key:z.uuid(),key_revision:z.number(),model:z.string(),stage:z.string(),expires:z.number()}).strict().parse(p);requireCondition(s.expires>Date.now()&&s.expires<Date.now()+80000,401,'模型调用租约已过期');
  const b=await botRecord(s.bot);requireCondition(b?.state==='active',403,'机器人已暂停');
  await botStorage.run(await botScope(s.bot),async()=>{
   const g=(await pool.query('SELECT revision,enabled FROM groups WHERE id=$1',[s.group])).rows[0];requireCondition(g?.enabled&&g.revision===s.revision,409,'群配置已变化');
   const k=await keyForAlias(s.alias);requireCondition(k.id===s.key&&k.revision===s.key_revision,409,'Key 已更新');
   const path=req.path.slice('/api/model-proxy'.length);let streaming=false;
   if(k.client_type==='gemini'){const gen='/v1beta/models/'+encodeURIComponent(s.model);requireCondition([gen+':generateContent',gen+':streamGenerateContent'].includes(path),403,'模型接口与授权不符');streaming=path.endsWith(':streamGenerateContent');}
   else{requireCondition(path===(k.client_type==='openai_responses'?'/v1/responses':'/v1/chat/completions')&&req.body.model===s.model,403,'模型接口与授权不符');}
   const body={...req.body};if(streaming)body.__gemini_stream=true;
   const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
   const forward:ModelTransport=(url,key,protocol,payload,timeout,signal,dispatch)=>transport(url,key,protocol,payload,timeout,signal,dispatch,{start:type=>{res.type(type.includes('text/event-stream')?'text/event-stream':'application/json');res.flushHeaders();},chunk:chunk=>{if(!res.destroyed)res.write(chunk);}});
   try{const result=await executeKeyCall(s.alias,s.model,{feature:'chat',groupId:s.group},body,600000,controller.signal,forward);if(res.headersSent)res.end();else{res.type(result.contentType.includes('text/event-stream')?'text/event-stream':'application/json');res.send(result.text);}}catch(e){if(res.headersSent){res.destroy();return;}throw e;}
  });
 });
}
