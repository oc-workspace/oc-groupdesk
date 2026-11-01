import {z} from 'zod';
import {groupRoute} from '../models.js';
import {languageCode} from '../policies.js';
import {interactionSettingsDefaults,interactionBindingDefaults,type InteractionCommands,normalizeInteractionText} from '../../shared/interactions.js';
const words=z.array(z.string().trim().min(1).max(120)).max(32);
export const commandsSchema=z.record(languageCode,z.object({checkin:words,balance:words,catalog:words,redeem:words}).strict()).superRefine((value,ctx)=>{
 const entries=Object.entries(value);if(!entries.length||entries.length>30||entries.flatMap(([,v])=>Object.values(v).flat()).length>256)ctx.addIssue({code:'custom',message:'触发词需包含1—30种语言，总计不超过256项'});
 const seen=new Set<string>(),actions=new Map<string,string>();
 for(const [,set] of entries)for(const action of ['checkin','balance','catalog','redeem'] as const)for(const text of set[action]){
  const key=normalizeInteractionText(text);if(!key||seen.has(action+':'+key))ctx.addIssue({code:'custom',message:'触发词为空或在不同语言中重复'});seen.add(action+':'+key);const previous=actions.get(key);if(previous&&previous!==action&&![previous,action].every(v=>v==='catalog'||v==='redeem'))ctx.addIssue({code:'custom',message:'同一触发词不能同时用于签到、余额等不同动作'});actions.set(key,action);
 }
});
export const definitionSchema=z.object({name:z.string().trim().min(1).max(100),kind:z.enum(['daily_checkin','custom_reply']),description:z.string().max(500),instructions:z.string().max(3000),commands:commandsSchema}).strict().superRefine((v,ctx)=>{
 if(!Object.values(v.commands).some(c=>c.checkin.length))ctx.addIssue({code:'custom',message:'至少填写一个签到或互动触发词'});
 if(v.kind==='custom_reply'&&Object.values(v.commands).some(c=>c.balance.length||c.catalog.length||c.redeem.length))ctx.addIssue({code:'custom',message:'自定义文字互动只使用触发词，积分和兑换命令请留空'});
});
export const settingsSchema=z.object({
 timezone:z.string().min(1).max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'时区无效'),
 daily_checkin_limit:z.number().int().min(1).max(10),daily_reply_limit:z.number().int().min(1).max(2000),minute_reply_limit:z.number().int().min(1).max(60),ai_daily_limit:z.number().int().min(0).max(200),
 member_cooldown_seconds:z.number().int().min(1).max(300),ai_timeout_seconds:z.number().int().min(10).max(120),bot_aliases:z.array(z.string().trim().min(1).max(80)).min(1).max(20)
}).strict();
export const bindingSchema=z.object({enabled:z.boolean(),reward_min:z.number().int().min(1).max(100000),reward_max:z.number().int().min(1).max(100000),require_mention:z.boolean(),language_mode:z.enum(['follow','group']),model_route:groupRoute,reply_instructions:z.string().max(3000),fixed_reply:z.string().max(500)}).strict().refine(v=>v.reward_max>=v.reward_min,'奖励最大值不能小于最小值');
export const prizeSchema=z.object({code:z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{0,15}$/),name:z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/),description:z.string().max(500),cost:z.number().int().min(1).max(1000000000),stock:z.number().int().min(0).max(1000000).nullable(),enabled:z.boolean()}).strict();
export type InteractionSettings=z.infer<typeof settingsSchema>;
export const settingsDefault=()=>structuredClone(interactionSettingsDefaults);
export const bindingDefault=()=>structuredClone(interactionBindingDefaults);
export function commandKeys(commands:InteractionCommands){return new Set(Object.values(commands).flatMap(s=>Object.values(s).flat()).map(normalizeInteractionText));}
