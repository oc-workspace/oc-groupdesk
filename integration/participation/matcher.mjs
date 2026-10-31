// Pure, bounded policy preview; no model, network, chat storage or send API.
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function pattern(term){
 const body=term.trim().split(/[\s\-\u2010-\u2015]+/u).map(esc).join('[\\s\\-\\u2010-\\u2015]+');
 return new RegExp((/^[A-Za-z0-9_]/.test(term)?'(?<![A-Za-z0-9_])':'')+body+(/[A-Za-z0-9_]$/.test(term)?'(?![A-Za-z0-9_])':''),'giu');
}
export function authored(text){
 return text.normalize('NFKC').replace(/https?:\/\/\S+/gi,'').replace(/```[\s\S]*?(?:```|$)/g,'').split(/\n/).reduce((a,line)=>{
  if(a.stop)return a;if(/^\s*引用\s+.+?\s*的消息\s*[:：]/u.test(line)){a.stop=true;return a;}if(!/^\s*>/.test(line))a.lines.push(line);return a;
 },{lines:[],stop:false}).lines.join('\n').replace(/@[^\s,，:：]+\s*/gu,'').trim();
}
const has=(text,terms=[])=>terms.some(t=>pattern(t).test(text));
export function classify(policy,text,now,state=null){
 let visible=authored(text).slice(0,2000);
 if(/^[“"「][\s\S]*[”"」]$/u.test(visible))visible='';
 for(const term of policy.exclusions||[])visible=visible.replace(pattern(term),' ');
 const hard=has(visible,policy.hard_exit_terms),words=Object.values(policy.lexicons||{}).flat();
 const explicit=!hard&&visible.length>=2&&has(visible,words);
 const combo=!hard&&visible.length>=2&&(policy.combinations||[]).some(c=>c.all.every(group=>has(visible,group)));
 if(explicit||combo)return {reason:explicit?'explicit':'combination',state:{at:now,text:visible.slice(0,policy.context.anchor_chars),unrelated:0}};
 if(has(visible,policy.exit_terms))return {reason:'topic_changed',state:null};
 const live=state&&policy.context.enabled&&now-state.at<policy.context.seconds&&state.unrelated<policy.context.max_intervening_messages;
 if(live&&!has(visible,policy.continuation_exclusions)&&has(visible,policy.continuations))return {reason:'context',state};
 const next=live?{...state,unrelated:state.unrelated+1}:null;
 return {reason:'none',state:next&&next.unrelated<policy.context.max_intervening_messages?next:null};
}
