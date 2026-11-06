import {readFileSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import {get} from 'node:https';
import {posix} from 'node:path';
import {publicAddress} from './model-security.js';
import {digest,HttpError,requireCondition} from './security.js';

export const personaResourceCatalog=JSON.parse(readFileSync(new URL('../catalog/persona-resources.json',import.meta.url),'utf8')) as {
 source:string;commit:string;license:string;reviewed_at:string;entries:{id:string;name:string;url:string;repository:string;description:string;category:string;resource_type:string;family:string|null}[]
};
export type ResourceFile={path:string;content:string;sha256:string};
export type ResourceSnapshot={resource_id:string;repository:string;commit:string;path:string;sha256:string;files:ResourceFile[];choices:string[];omitted:string[];license:string;fetched_at:string};
export type PublicTextReader=(url:URL,maximum:number)=>Promise<string>;
export function safeSourcePath(path:string){return path.length<=500&&!path.startsWith('/')&&!path.includes('\\')&&!/[\x00-\x1f\x7f]/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..');}
export function sourceUrlAllowed(url:URL){return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&!url.hash&&['api.github.com','raw.githubusercontent.com'].includes(url.hostname);}
export const readPublicText:PublicTextReader=async(url,maximum)=>{
 requireCondition(sourceUrlAllowed(url),400,'仅支持资源目录中的公开 GitHub 文本');
 const addresses=await lookup(url.hostname,{all:true});
 requireCondition(addresses.length&&addresses.every(a=>publicAddress(a.address)),502,'资源域名未解析到公网');
 return new Promise((resolve,reject)=>{
  const fail=(message:string)=>reject(new HttpError(502,message));
  const request=get(url,{headers:{Accept:'application/vnd.github+json','User-Agent':'GroupDesk-Persona-Library'},family:addresses[0].family,
   lookup:((_h:unknown,_o:unknown,cb:Function)=>cb(null,addresses[0].address,addresses[0].family)) as any},response=>{
   if(response.statusCode!==200){response.resume();fail(response.statusCode===403||response.statusCode===429?'GitHub 暂时限流，请稍后重试':'公开资源读取失败（HTTP '+response.statusCode+'），未改动现有人设');return;}
   const parts:Buffer[]=[];let size=0;
   response.on('data',(part:Buffer)=>{size+=part.length;if(size>maximum){fail('资源超过单次读取上限，请在来源查看完整资料');request.destroy();}else parts.push(part);});
   response.on('error',()=>fail('资源连接中断，请重试'));
   response.on('end',()=>{try{const value=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));requireCondition(!value.includes('\0'),502,'资源不是文本文件');resolve(value);}catch{fail('资源不是有效 UTF-8 文本');}});
  });
  const timer=setTimeout(()=>request.destroy(new Error('timeout')),20000);request.on('close',()=>clearTimeout(timer));request.on('error',()=>fail('资源连接失败或超时，请稍后重试'));
 });
};
export async function fetchResourceSnapshot(id:string,requestedPath?:string,read:PublicTextReader=readPublicText):Promise<ResourceSnapshot>{
 const entry=personaResourceCatalog.entries.find(e=>e.id===id);requireCondition(entry,404,'资源不在当前目录中');
 requireCondition(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(entry.repository),400,'资源仓库地址无效');
 const api='https://api.github.com/repos/'+entry.repository;
 const metadata=JSON.parse(await read(new URL(api),100000));
 const commit=JSON.parse(await read(new URL(api+'/commits/'+encodeURIComponent(metadata.default_branch)),100000)).sha;
 requireCondition(/^[a-f0-9]{40}$/.test(commit),502,'无法确认来源版本');
 const tree=JSON.parse(await read(new URL(api+'/git/trees/'+commit+'?recursive=1'),2000000));
 requireCondition(Array.isArray(tree.tree)&&!tree.truncated,502,'来源文件目录不完整，请在 GitHub 查看或导出后上传');
 const files=tree.tree.filter((f:any)=>f.type==='blob'&&f.mode==='100644'&&typeof f.path==='string'&&safeSourcePath(f.path)) as {path:string;size:number}[];
 const skills=files.filter(f=>/(^|\/)SKILL\.md$/i.test(f.path)).map(f=>f.path).sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
 const readme=files.find(f=>/^readme\.md$/i.test(f.path))?.path;
 const choices=skills.length?skills:(readme?[readme]:[]);
 requireCondition(choices.length&&choices.length<=100,400,'没有可导入的 SKILL.md/README.md，或候选过多；请在来源选择后上传');
 const path=requestedPath||choices[0];requireCondition(choices.includes(path),400,'请选择来源目录内的 Skill 文件');
 const dir=posix.dirname(path),prefix=dir==='.'?'':dir+'/';
 const companion=files.filter(f=>f.path!==path&&((f.path.startsWith(prefix+'references/')&&/\.(md|txt)$/i.test(f.path))||/^(license|copying|notice)(\.[a-z]+)?$/i.test(posix.basename(f.path))&&(posix.dirname(f.path)===dir||!f.path.includes('/'))));
 companion.sort((a,b)=>Number(!/license|copying|notice/i.test(a.path))-Number(!/license|copying|notice/i.test(b.path))||a.path.localeCompare(b.path));
 const candidates=[files.find(f=>f.path===path)!,...companion];const included:ResourceFile[]=[],omitted:string[]=[];let total=0;
 for(const file of candidates){
  if(included.length>=20||file.size>120000||total+file.size>180000){if(file.path===path)throw new HttpError(400,'主 Skill 超过 120 KB，请先手动整理后上传');omitted.push(file.path);continue;}
  const content=await read(new URL('https://raw.githubusercontent.com/'+entry.repository+'/'+commit+'/'+file.path.split('/').map(encodeURIComponent).join('/')),120000);
  total+=Buffer.byteLength(content);requireCondition(total<=180000,502,'资料总量超过读取上限');included.push({path:file.path,content,sha256:digest(content)});
 }
 return {resource_id:id,repository:entry.repository,commit,path,files:included,choices,omitted,
  sha256:digest(JSON.stringify(included.map(f=>[f.path,f.sha256]))),license:metadata.license?.spdx_id||'未声明',fetched_at:new Date().toISOString()};
}
