export const conversationDefaults={enabled:false,banter_replies:false,frequency:'low' as 'low'|'normal'|'high',instructions:''};
export const toneNames={serious:'认真讨论',playful:'玩笑 / 接梗',mixed:'认真与玩笑混合',uncertain:'暂不确定'};
export type Tone=keyof typeof toneNames;
export type ConversationPolicy=typeof conversationDefaults;
export function conversationGuide(p:ConversationPolicy){
 if(!p.enabled)return '';
 return ['先结合最近上下文区分认真提问、熟人调侃、二者混合和无法确定。分类是语气判断，不是事实核查或对成员的评价。',
  '认真问题认真答；玩笑里有实质问题，先答问题再轻接一句。证据不足不要自信下结论，可温和追问。有人说停止、澄清或表达不适，立即停梗。',
  p.banter_replies?`允许按当前Persona接梗、捧哏；频率倾向=${({low:'少量，通常旁听，避免连续接梗',normal:'适量，有自然接话点才回应',high:'较积极，但不抢话、不逐条回复'} as const)[p.frequency]}。不强行纠正明显反讽；不把玩笑存成人物事实，不编造关系、私事或指控，不起哄围攻。`:'识别玩笑作为理解语境的辅助，不主动接梗或捧哏；有实质问题仍正常回答。',
  '所有语言、身份、话题、知识权限、发言频率和预算门控继续优先；本设置不授权范围外的实质咨询。',
  p.instructions?'管理员补充的语气规则：'+p.instructions:''].filter(Boolean).join('\n');
}
export function textMatchesAny(text:string,terms:string[]){
 const normalized=text.normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015]/g,'-');
 return !terms.length||terms.some(term=>{
  const t=term.normalize('NFKC').trim().toLowerCase().replace(/[\u2010-\u2015]/g,'-');
  if(!t)return false;
  const escaped=t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  return new RegExp((/^[a-z0-9]/.test(t)?'(?<![a-z0-9_])':'')+escaped+(/[a-z0-9]$/.test(t)?'(?![a-z0-9_])':''),'u').test(normalized);
 });
}
