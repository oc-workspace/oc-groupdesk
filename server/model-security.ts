import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {get} from 'node:https';
import {isIP} from 'node:net';
import {HttpError,requireCondition} from './security.js';

function masterKey(){
  const value=process.env.MODEL_ENCRYPTION_KEY||'';
  requireCondition(/^[a-f0-9]{64}$/i.test(value),503,'模型密钥存储尚未初始化');
  return Buffer.from(value,'hex');
}
export function sealKey(value:string){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',masterKey(),iv);
  const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}
export function openKey(value:string){
  const [version,iv,tag,body]=value.split('.');
  requireCondition(version==='v1'&&!!body,503,'模型密钥无法读取');
  try{
    const decipher=createDecipheriv('aes-256-gcm',masterKey(),Buffer.from(iv,'base64url'));
    decipher.setAuthTag(Buffer.from(tag,'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8');
  }catch{throw new HttpError(503,'模型密钥无法读取');}
}
export function publicAddress(address:string){
  if(isIP(address)===6)return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0|1[0-9a-f]):/i.test(address)&&!/^2002:/i.test(address);
  if(isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,2,168].includes(b)||a===198&&[18,19,51].includes(b)||a===203&&b===0||a===100&&b>=64&&b<=127);
}
export function baseUrl(value:string){
  let url:URL;try{url=new URL(value);}catch{throw new HttpError(400,'请输入有效的 HTTPS API 地址');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  requireCondition(url.protocol==='https:'&&(!url.port||url.port==='443')&&!url.username&&!url.password&&!url.search&&!url.hash,400,'API 地址须为 HTTPS，且不能包含凭据、查询参数或自定义端口');
  requireCondition(host.includes('.')&&!host.endsWith('.local')&&!host.endsWith('.localhost')&&host!=='localhost'&&(!isIP(host)||publicAddress(host)),400,'API 地址必须指向公网服务');
  return url.href.replace(/\/+$/,'');
}
export type ClientType='openai'|'openai_responses'|'gemini';
export function catalogLocation(endpoint:string,protocol:ClientType='openai',pageToken?:string){
  const normalized=baseUrl(endpoint);
  const path=protocol==='gemini'&&!/\/v\d+(?:alpha|beta)?\d*$/.test(new URL(normalized).pathname)?normalized+'/v1beta':normalized;
  const url=new URL(path+'/models');
  if(protocol==='gemini'){
    url.searchParams.set('pageSize','1000');
    if(pageToken)url.searchParams.set('pageToken',pageToken);
  }
  return url;
}
async function requestCatalog(url:URL,key:string,protocol:ClientType):Promise<unknown>{
  const addresses=await lookup(url.hostname,{all:true});
  requireCondition(addresses.length&&addresses.every(r=>publicAddress(r.address)),400,'API 域名不能解析到内网或保留地址');
  return new Promise((resolve,reject)=>{
    const request=get(url,{
      headers:{...(protocol==='gemini'?{'x-goog-api-key':key}:{Authorization:'Bearer '+key}),Accept:'application/json'},family:addresses[0].family,
      lookup:((_host:unknown,_options:unknown,cb:Function)=>cb(null,addresses[0].address,addresses[0].family)) as any
    },response=>{
      if(response.statusCode!==200){response.resume();reject(new HttpError(502,'模型目录请求失败（HTTP '+response.statusCode+'），已保留原目录'));return;}
      const parts:Buffer[]=[];let length=0;
      response.on('data',(part:Buffer)=>{length+=part.length;if(length>2*1024*1024){request.destroy();reject(new HttpError(502,'模型目录过大，已保留原目录'));}else parts.push(part);});
      response.on('error',()=>reject(new HttpError(502,'模型目录连接中断，已保留原目录')));
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(new HttpError(502,'服务未返回有效模型目录，已保留原目录'));}});
    });
    const timeout=setTimeout(()=>request.destroy(new Error('timeout')),15000);
    request.on('close',()=>clearTimeout(timeout));
    request.on('error',()=>reject(new HttpError(502,'模型目录连接失败或超时，已保留原目录')));
  });
}
export async function fetchCatalog(endpoint:string,key:string,protocol:ClientType='openai'):Promise<unknown>{
  if(protocol!=='gemini')return requestCatalog(catalogLocation(endpoint,protocol),key,protocol);
  const models:unknown[]=[];const seen=new Set<string>();let token:string|undefined;
  for(let page=0;page<5;page++){
    const value=await requestCatalog(catalogLocation(endpoint,protocol,token),key,protocol) as {models?:unknown[];nextPageToken?:unknown};
    requireCondition(value&&Array.isArray(value.models),502,'服务未返回 Gemini 模型目录，已保留原目录');
    models.push(...value.models);requireCondition(models.length<=5000,502,'模型目录过大，已保留原目录');
    if(!value.nextPageToken)return {models};
    requireCondition(typeof value.nextPageToken==='string'&&value.nextPageToken.length<=2048&&!seen.has(value.nextPageToken),502,'模型目录分页无效，已保留原目录');
    seen.add(value.nextPageToken);token=value.nextPageToken;
  }
  throw new HttpError(502,'模型目录分页过多，已保留原目录');
}
