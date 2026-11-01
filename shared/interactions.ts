export type InteractionKind='daily_checkin'|'custom_reply';
export type InteractionCommandSet={checkin:string[];balance:string[];catalog:string[];redeem:string[]};
export type InteractionCommands=Record<string,InteractionCommandSet>;
export const defaultInteractionId='baac9e5f-0cbe-4ab2-aadb-69d77e81ba6b';
export const interactionCommands:InteractionCommands={
 'zh-CN':{checkin:['摸鱼','签到'],balance:['积分','余额','我的token'],catalog:['奖品','兑换列表','兑换','可以兑换啥','可以兑换什么','我可以兑换什么','我想兑换东西','可以换啥','奖品是什么','现在能兑换什么'],redeem:['兑换']},
 en:{checkin:['check in','checkin','daily checkin','slack off'],balance:['balance','my tokens'],catalog:['prizes','rewards','reward list','what can I redeem','what rewards are available'],redeem:['redeem']},
 ja:{checkin:['チェックイン'],balance:['残高'],catalog:['景品','交換リスト'],redeem:['交換']},
 ko:{checkin:['출석'],balance:['잔액'],catalog:['상품 목록'],redeem:['교환']},
 fr:{checkin:['pointage'],balance:['mon solde'],catalog:['liste des récompenses'],redeem:['échanger']},
 es:{checkin:['fichar'],balance:['mi saldo'],catalog:['lista de premios'],redeem:['canjear']},
 de:{checkin:['einchecken'],balance:['mein guthaben'],catalog:['prämienliste'],redeem:['einlösen']}
};
export const interactionSettingsDefaults={timezone:'Asia/Singapore',daily_checkin_limit:1,daily_reply_limit:1000,minute_reply_limit:20,ai_daily_limit:20,member_cooldown_seconds:3,ai_timeout_seconds:90,bot_aliases:['小T','GT 小跟班','GT小跟班','AI的小跟班','bot']};
export const interactionBindingDefaults={enabled:false,reward_min:1,reward_max:100,require_mention:false,language_mode:'follow' as 'follow'|'group',model_route:{mode:'inherit' as const},reply_instructions:'',fixed_reply:''};
export function normalizeInteractionText(value:string){return value.normalize('NFKC').trim().replace(/\s+/gu,' ').replace(/[?!！？。.!]+$/gu,'').trim().toLowerCase();}
export function interactionCommand(text:string,commands:InteractionCommands,aliases:string[]=[],mentioned=false,requireMention=false){
 let value=text.normalize('NFKC').trim();
 for(const alias of [...aliases].sort((a,b)=>b.length-a.length)){
  const escaped=alias.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp('^@?'+escaped+'(?:[\\s,，:：]+|(?=[\\p{Script=Han}]))','iu');
  if(re.test(value)){value=value.replace(re,'').trim();mentioned=true;break;}
 }
 if(requireMention&&!mentioned)return null;
 value=normalizeInteractionText(value);
 for(const [locale,set] of Object.entries(commands)){
  for(const prefix of set.redeem){
   const normalized=normalizeInteractionText(prefix);
   if(value.startsWith(normalized)){
    const tail=value.slice(normalized.length);if(/[a-z0-9]$/.test(normalized)&&tail&&!/^\s/.test(tail))continue;
    const suffix=tail.trim();
    if(/^[a-z0-9][a-z0-9_-]{0,15}$/i.test(suffix))return {action:'redeem' as const,locale,prize_code:suffix.toUpperCase()};
    if(suffix)return {action:'catalog' as const,locale,prize_code:null};
   }
  }
  for(const action of ['checkin','balance','catalog'] as const)if(set[action].some(t=>normalizeInteractionText(t)===value))return {action,locale,prize_code:null};
 }
 return null;
}
