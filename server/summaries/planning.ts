import {summaryMemberName} from '../../shared/summary-member-names.js';
import {requireCondition} from '../security.js';
export type SummaryMessage={seq:number;sender:string|null;text:string;at:string;time_kind:'original'|'capture';fragment?:string};
export function compactMessages(messages:SummaryMessage[],zone:string){
 const format=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,dateStyle:'short',timeStyle:'short'}),names:(string|null)[]=[],indices=new Map<string|null,number>();
 const rows=messages.map(m=>{if(!indices.has(m.sender)){indices.set(m.sender,names.length);names.push(m.sender);}return [m.seq,indices.get(m.sender),m.time_kind==='original'?format.format(new Date(m.at)):null,m.text,m.fragment||null];});
 return {columns:['source_id','sender_index','sent_time','text','fragment'],senders:names.map(name=>name===null?null:summaryMemberName(name)),messages:rows,
  source_notes:'sender_index refers to senders. A null sender means the nickname was not available; explicitly disclose this when attributing. sent_time is already local to timezone. A null sent_time means original speaking time unavailable: never replace it with capture time. Fragment labels split one original message without changing its source_id. Repeated source_ids near chunk boundaries are context, not additional messages.'};
}
export function materialInput(job:any,messages:SummaryMessage[]){return JSON.stringify({group:job.group_name||job.external_id,start:job.window_start,end:job.window_end,timezone:job.config.timezone,...compactMessages(messages,job.config.timezone)});}
function fragments(messages:SummaryMessage[],budget:number){
 const maximum=Math.floor(budget/3),result:SummaryMessage[]=[];
 for(const m of messages){
  if(m.text.length<=maximum){result.push(m);continue;}
  const parts:string[]=[];let current='';for(const c of m.text){if(current.length+c.length>maximum){parts.push(current);current='';}current+=c;}if(current)parts.push(current);
  parts.forEach((text,i)=>result.push({...m,text,fragment:`${i+1}/${parts.length}`}));
 }return result;
}
export function modelChunks(job:any,messages:SummaryMessage[],budget:number){
 const expanded=fragments(messages,budget),chunks:SummaryMessage[][]=[];let current:SummaryMessage[]=[],size=materialInput(job,[]).length+256,names=new Set<string|null>();
 const base=size;
 for(const message of expanded){
  const cost=JSON.stringify([message.seq,20000,'0000-00-00 00:00',message.text,message.fragment||null]).length+2;
  let extra=names.has(message.sender)?0:JSON.stringify(message.sender===null?null:summaryMemberName(message.sender)).length+1;
  if(current.length&&size+cost+extra>budget){chunks.push(current);current=[];size=base;names=new Set();extra=JSON.stringify(message.sender===null?null:summaryMemberName(message.sender)).length+1;}
  requireCondition(size+cost+extra<=budget,400,'单条消息无法放入模型材料预算，请增大预算');
  current.push(message);names.add(message.sender);size+=cost+extra;
 }
 if(current.length)chunks.push(current);
 requireCondition(chunks.length<=64,400,'本时段需要超过64个模型分段，请缩短范围或提高单次材料预算');
 // Small boundary context helps resolve pronouns and continuations. Source IDs
 // stay unchanged, and counts/rankings always use the original source once.
 return chunks.map((chunk,i)=>{const overlap=i?chunks[i-1].slice(-3):[];const candidate=[...overlap,...chunk];return materialInput(job,candidate).length<=budget?candidate:chunk;});
}
export function noteInput(job:any,notes:string[],stage='final'){return JSON.stringify({group:job.group_name||job.external_id,start:job.window_start,end:job.window_end,timezone:job.config.timezone,stage,notes});}
export function noteGroups(job:any,notes:string[],budget:number){
 const groups:string[][]=[];let current:string[]=[],size=noteInput(job,[], 'reduce').length;
 for(const note of notes){const cost=JSON.stringify(note).length+1;requireCondition(cost+noteInput(job,[],'reduce').length<=budget,502,'分段归纳超过材料预算');if(current.length&&size+cost>budget){groups.push(current);current=[];size=noteInput(job,[],'reduce').length;}current.push(note);size+=cost;}
 if(current.length)groups.push(current);return groups;
}
