import {executeKeyCall} from './model-proxy.js';
import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {baseUrl,publicAddress,openKey,type ClientType} from './model-security.js';
import {requireCondition,HttpError} from './security.js';
export type GenerationOptions={feature?:string;groupId?:string;timeoutMs?:number;maxOutputTokens?:number;signal?:AbortSignal;lowThinking?:boolean;jsonOutput?:boolean};
export function generationRequest(c:{base_url:string;client_type:ClientType},model:string,system:string,input:string,options:GenerationOptions={}){
 const base=baseUrl(c.base_url),output=options.maxOutputTokens||8192;
 if(c.client_type==='gemini'){
  const prefix=/\/v\d+(?:alpha|beta)?\d*$/.test(new URL(base).pathname)?base:base+'/v1beta';
  return {url:new URL(prefix+'/models/'+encodeURIComponent(model)+':generateContent'),body:{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{maxOutputTokens:output,...(options.jsonOutput?{responseMimeType:'application/json'}:{}),...(options.lowThinking&&model==='gemini-3.8-flash'?{thinkingConfig:{thinkingLevel:'LOW',includeThoughts:false}}:{})}}};
 }
 if(c.client_type==='openai_responses')return {url:new URL(base+'/responses'),body:{model,store:false,stream:false,instructions:system,input,max_output_tokens:output}};
 return {url:new URL(base+'/chat/completions'),body:{model,store:false,stream:false,messages:[{role:'system',content:system},{role:'user',content:input}],max_tokens:output}};
}
export function generationText(value:any,protocol:ClientType){
 const text=protocol==='gemini'?value?.candidates?.[0]?.content?.parts?.filter((p:any)=>!p.thought).map((p:any)=>p.text||'').join(''):
  protocol==='openai_responses'?value?.output?.filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content||[]).filter((p:any)=>p.type==='output_text').map((p:any)=>p.text).join(''):value?.choices?.[0]?.message?.content;
 requireCondition(typeof text==='string'&&text.trim(),502,'模型未返回可用内容');
 return text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/,'$1').replace(/^---\n[\s\S]*?\n---\n/,'').trim();
}
export async function callTextModel(c:any,model:string,system:string,input:string,options:GenerationOptions={}){
 options.signal?.throwIfAborted();const {body}=generationRequest(c,model,system,input,options);
 const result=await executeKeyCall(c.id,model,{feature:options.feature||'chat',groupId:options.groupId},body,options.timeoutMs||120000,options.signal);
 try{return JSON.parse(result.text);}catch{throw new HttpError(502,'模型返回格式无效');}
}
