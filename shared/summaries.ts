import {z} from 'zod';
export const summaryZones=['Asia/Shanghai','Asia/Singapore','UTC'] as const;
export const summaryConfig=z.object({enabled:z.boolean().default(false),timezone:z.enum(summaryZones).default('Asia/Shanghai'),template:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).default('comprehensive'),language:z.enum(['group','zh-CN','en','ja']).default('group'),model_route:z.discriminatedUnion('mode',[z.object({mode:z.literal('inherit')}),z.object({mode:z.literal('custom'),credential_id:z.uuid(),model_id:z.string().min(1).max(200)})]).default({mode:'inherit'}),instructions:z.string().max(2000).default('')});
export const summaryDefaults=()=>summaryConfig.parse({});
export const windowSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('previous_day')}),z.object({kind:z.literal('today')}),z.object({kind:z.literal('last_24h')}),
 z.object({kind:z.literal('day'),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}),
 z.object({kind:z.literal('custom'),start:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),end:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)})]);
export const scheduleSchema=z.object({kind:z.enum(['daily','once']),at:z.string(),window:windowSchema}).superRefine((v,c)=>{
 if(v.kind==='daily'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at))c.addIssue({code:'custom',message:'每日时间需要HH:mm',path:['at']});
 if(v.kind==='once'&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v.at))c.addIssue({code:'custom',message:'预约需要日期和时分',path:['at']});
});
export function localDate(now:number,zone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).filter(x=>['year','month','day'].includes(x.type)).sort((a,b)=>['year','month','day'].indexOf(a.type)-['year','month','day'].indexOf(b.type)).map(x=>x.value).join('-');}
export function shiftDay(day:string,n:number){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function instant(value:string,zone:string){
 if(!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error('日期和时间格式无效');
 const offset=zone==='UTC'?'Z':'+08:00';const n=Date.parse(value+':00'+offset);
 if(!Number.isFinite(n)||localDate(n,zone)!==value.slice(0,10))throw new Error('日期不存在');return n;
}
export function resolveWindow(input:unknown,zone:string,now:number){
 const w=windowSchema.parse(input),day=localDate(now,zone);let start:number,end:number;
 if(w.kind==='custom'){start=instant(w.start,zone);end=instant(w.end,zone);}
 else if(w.kind==='last_24h'){start=now-86400000;end=now;}
 else if(w.kind==='today'){start=instant(day+'T00:00',zone);end=now;}
 else{const d=w.kind==='day'?w.date:shiftDay(day,-1);start=instant(d+'T00:00',zone);end=instant(shiftDay(d,1)+'T00:00',zone);}
 if(end<=start||end-start>31*86400000)throw new Error('总结范围须大于0且不超过31天');
 if(end>now)throw new Error('总结时间段尚未结束，请调整范围或预约在结束后执行');
 return {start:new Date(start).toISOString(),end:new Date(end).toISOString()};
}
export function nextOccurrence(input:unknown,zone:string,now:number){
 const s=scheduleSchema.parse(input);
 if(s.kind==='once'){const n=instant(s.at,zone);if(n<=now)throw new Error('预约时间需要晚于当前时间');return new Date(n).toISOString();}
 const d=localDate(now,zone),candidate=instant(d+'T'+s.at,zone);
 return new Date(candidate>now?candidate:instant(shiftDay(d,1)+'T'+s.at,zone)).toISOString();
}
export const jobLabels:Record<string,string>={waiting_source:'等待服务器取数',reading:'正在读取存档',queued:'等待模型',generating:'正在生成',preview:'预览待发布',delivery_ready:'等待发群',delivering:'正在发群',sent:'已发送',failed:'失败',uncertain:'发送待人工核实',cancelled:'已取消'};
