import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {baseUrl,publicAddress,openKey,type ClientType} from './model-security.js';
import {requireCondition,HttpError} from './security.js';
export type GenerationOptions={timeoutMs?:number;maxOutputTokens?:number;signal?:AbortSignal;lowThinking?:boolean};
export function generationRequest(c:{base_url:string;client_type:ClientType},model:string,system:string,input:string,options:GenerationOptions={}){
 const base=baseUrl(c.base_url),output=options.maxOutputTokens||8192;
 if(c.client_type==='gemini'){
  const prefix=/\/v\d+(?:alpha|beta)?\d*$/.test(new URL(base).pathname)?base:base+'/v1beta';
  return {url:new URL(prefix+'/models/'+encodeURIComponent(model)+':generateContent'),body:{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{maxOutputTokens:output,...(options.lowThinking&&model==='gemini-3.8-flash'?{thinkingConfig:{thinkingLevel:'LOW',includeThoughts:false}}:{})}}};
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
 options.signal?.throwIfAborted();
 const {url,body}=generationRequest(c,model,system,input,options),addresses=await lookup(url.hostname,{all:true});
 options.signal?.throwIfAborted();
 requireCondition(addresses.length&&addresses.every(a=>publicAddress(a.address)),400,'模型服务地址不可用');
 const key=openKey(c.key_ciphertext),payload=JSON.stringify(body);
 return new Promise<unknown>((resolve,reject)=>{
  const req=request(url,{method:'POST',family:addresses[0].family,signal:options.signal,
   lookup:((_h:unknown,_o:unknown,cb:Function)=>cb(null,addresses[0].address,addresses[0].family)) as any,
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...(c.client_type==='gemini'?{'x-goog-api-key':key}:{Authorization:'Bearer '+key})}},res=>{
    if(res.statusCode!==200){res.resume();reject(new HttpError(502,'模型请求失败（HTTP '+res.statusCode+'），请核对 Key/模型后重新生成'));return;}
    const parts:Buffer[]=[];let bytes=0;
    res.on('data',(p:Buffer)=>{bytes+=p.length;if(bytes>2*1024*1024)req.destroy(new Error('response_limit'));else parts.push(p);});
    res.on('error',()=>reject(new HttpError(502,'模型连接中断，请重新生成')));
    res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString()));}catch{reject(new HttpError(502,'模型返回格式无效'));}});
   });
  const timeout=setTimeout(()=>req.destroy(new Error('timeout')),options.timeoutMs||120000);req.on('close',()=>clearTimeout(timeout));
  req.on('error',()=>reject(new HttpError(502,'模型连接失败或超时，请重新生成')));req.end(payload);
 });
}
