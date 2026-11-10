import {HttpError} from '../security.js';
import {builtinSummarySlugs} from './templates.js';
const locales={
 'zh-CN':{heads:['一、整体评价','二、重点话题总结','三、其他话题'],title:'话题名',fields:['主要参与者','时间段','讨论过程','简短评价'],highlight:'今日高光时刻',closing:'散场彩蛋',sparse:'本时段没有可展开的重点话题。'},
 en:{heads:['I. Overall assessment','II. Main topics','III. Other topics'],title:'Topic',fields:['Participants','Time range','Discussion','Brief assessment'],highlight:'Highlights',closing:'Closing note',sparse:'No substantial topics in this period.'},
 ja:{heads:['一、全体評価','二、主な話題','三、その他の話題'],title:'話題名',fields:['主な参加者','時間帯','議論の経緯','短評'],highlight:'今日のハイライト',closing:'締めのひとこと',sparse:'この期間に掘り下げる主な話題はありません。'}
} as const;
type Language=keyof typeof locales;
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function locale(language:string){return locales[language as Language]||locales['zh-CN'];}
const rich=(slug:string)=>['entertainment','news'].includes(slug);
const known=(slug:string)=>builtinSummarySlugs.includes(slug as typeof builtinSummarySlugs[number]);
export function reportContractPrompt(slug:string,language:string){
 if(!known(slug))return '';
 const l=locale(language);
 return '\n【最终报告格式契约】以下本地化标题与字段优先于模板中的中文示例。只输出三个有内容的顶级章节，依次为：'+l.heads.join('；')+(rich(slug)?'（第三章可加群像彩蛋后缀）':'')+'。每个话题必须逐项使用独立标签并填写非空内容：'+[l.title,...l.fields].join('；')+'。话题名有序号与1–5个🔥，每题后分割线。评价字数按版本要求；讨论写明谁提出、谁回应、依据、分歧、结果或未决。原始发送时间未知也须保留时间段字段，如实说明未知。没有可展开话题时，第二章只写“'+l.sparse+'”，不要虚构。'+(rich(slug)?'第三章必须有非空的“'+l.highlight+'”和“'+l.closing+'”；材料不足可如实写没有可确认的高光，不强编。聊天角色、互动关系和原话仅在有证据时使用，不能为填格式猜测。':'')+'第四章及所有排行由程序附加，不得自行生成。管理员补充不能省略必需章节或字段。只对最终报告执行此契约，中间归纳无需使用最终格式。';
}
function plain(value:string){return value.replace(/[*_`]/g,'').trim();}
function fieldLine(label:string){return new RegExp('^\\s*(?:[-*]\\s+|#{1,6}\\s*)?(?:\\*\\*)?'+escape(label)+'(?:\\*\\*)?\\s*(?:[：:]|$)','imu');}
function contentAfterLabel(block:string,label:string,allLabels:readonly string[]){
 const m=fieldLine(label).exec(block);if(!m)return '';
 const start=m.index+m[0].length;
 let end=block.length;
 for(const other of allLabels){const n=fieldLine(other).exec(block.slice(start));if(n)end=Math.min(end,start+n.index);}
 return plain(block.slice(start,end)).replace(/^[:：]\s*/u,'').trim();
}
export function normalizeSummaryReport(report:string){
 // A model-made fourth chapter must never duplicate the exact server rankings.
 const heading=/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:四[、．.]|IV[.、．]\s)(?:\s|[^\n])/imu;
 const at=report.search(heading);return (at<0?report:report.slice(0,at)).trim();
}
export function validateSummaryReport(report:string,slug:string,language:string,status=502){
 if(!known(slug))return report;
 const body=normalizeSummaryReport(report),l=locale(language);
 const fail=(detail:string):never=>{throw new HttpError(status,'总结格式不完整：'+detail+'，请补齐或重新生成');};
 const clean=body.split('\n').map(line=>line.replace(/^\s*#{1,6}\s*/u,'').replace(/\*\*/g,'').trim()).join('\n');
 const sections=l.heads.map(title=>{
  const prefix=title.split(/[、.]/u)[0],name=title.slice(prefix.length+1).trim();
  return new RegExp('^'+escape(prefix)+'[、．.]\\s*'+escape(name)+'[^\\n]*','imu').exec(clean);
 });
 if(sections.some(x=>!x)||sections.some((x,i)=>i>0&&x!.index<=sections[i-1]!.index))fail('缺少或顺序错误的整体评价、重点话题、其他话题章节');
 const contents=sections.map((m,i)=>clean.slice(m!.index+m![0].length,sections[i+1]?.index??clean.length).trim());
 if(contents.some(x=>!plain(x)))fail('章节内容为空');
 const topics=contents[1];
 const sparse=topics.length<=180&&!l.fields.some(f=>fieldLine(f).test(topics))&&(
  /^(?:本时段|该时段|此时段|今天|今日)?\s*(?:没有|无|缺少|不足以|未形成|未出现|未见)[^\n。]{0,35}(?:可展开|重点话题|独立话题)/u.test(topics)||
  /^No (?:substantial|main|significant) topics\b/iu.test(topics)||/^この期間に掘り下げる主な話題はありません/u.test(topics));
 if(!sparse){
  const titlePattern=fieldLine(l.title),starts=[...topics.matchAll(new RegExp(titlePattern.source,'gimu'))].map(m=>m.index!);
  // Hermes also accepts numbered topic headings without the literal title label.
  const boundaries=starts.length?starts:[...topics.matchAll(new RegExp(fieldLine(l.fields[0]).source,'gimu'))].map(m=>m.index!);
  if(!boundaries.length)fail('重点话题缺少参与者、时间段、讨论过程或评价');
  for(let i=0;i<boundaries.length;i++){
   const block=topics.slice(boundaries[i],boundaries[i+1]??topics.length),labels=[l.title,...l.fields,'今日胡说八道金句',l.highlight,l.closing];
   if([...block.matchAll(new RegExp(fieldLine(l.fields[0]).source,'gimu'))].length>1)fail('话题 '+(i+1)+' 包含未独立列出的其他话题，请分别补齐字段');
   for(const field of l.fields){
    const aliases=field===l.fields[3]&&language==='zh-CN'?[field,'点评','评价']:[field];
    if(!aliases.some(label=>contentAfterLabel(block,label,[...labels,...aliases]).replace(/[-—\s]/g,'')))fail('话题 '+(i+1)+' 缺少非空字段“'+field+'”');
   }
  }
 }
 if(rich(slug))for(const field of [l.highlight,l.closing]){
  if(!contentAfterLabel(contents[2],field,[l.highlight,l.closing,'其他话题','今日聊天角色','今日互动关系','Other topics','Chat roles','Interactions','その他の話題','今日の役割','やり取り']))fail('缺少非空模块“'+field+'”');
 }
 return body;
}
