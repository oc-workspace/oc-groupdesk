import {readFileSync} from 'node:fs';
import {summaryMemberRules} from '../../shared/summary-member-names.js';

export const builtinSummarySlugs=['comprehensive','technical','ranking','entertainment','news'] as const;
const originals=JSON.parse(readFileSync(new URL('./legacy-templates.json',import.meta.url),'utf8')) as Record<string,string>;
const templates=new Map(builtinSummarySlugs.map(slug=>[slug,readFileSync(new URL('../../skills/wechat-server-summary/references/'+slug+'.md',import.meta.url),'utf8')]));
const compact=(text:string)=>text.replace(/\s/gu,'');
export function fullSummaryInstructions(slug:string,instructions:string){
 const full=templates.get(slug as typeof builtinSummarySlugs[number]);
 if(!full)return instructions;
 if(instructions.includes('[GroupDesk 完整 Skill v2:'+slug+']'))return instructions;
 const old=originals[slug],bare=old.split('【总结成员昵称格式】')[0];
 const builtin=[old,bare,bare+'\n\n'+summaryMemberRules].some(text=>compact(text)===compact(instructions));
 return full+(builtin?'':'\n\n## 保留的后台自定义要求\n以下为管理员补充；选题与语气可定制，必需结构及事实约束仍须满足。\n'+instructions);
}
