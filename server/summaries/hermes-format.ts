import {summaryMemberName} from '../../shared/summary-member-names.js';

type Speaker = {name:string;count:number;rank:number};
type CharacterSpeaker = {name:string;characterCount:number;rank:number};
type CompositeSpeaker = {name:string;messageCount:number;characterCount:number;compositeScore:number;rank:number};

function ranked<T extends {name:string}>(items:T[],value:(item:T)=>number,descending=true):Array<T&{rank:number}>{
 const compareNames=(a:string,b:string)=>{const left=[...a].map(x=>x.codePointAt(0)!),right=[...b].map(x=>x.codePointAt(0)!);for(let i=0;i<Math.min(left.length,right.length);i++)if(left[i]!==right[i])return left[i]-right[i];return left.length-right.length;};
 const sorted=[...items].sort((a,b)=>(descending?value(b)-value(a):value(a)-value(b))||compareNames(a.name,b.name));
 let previous:number|undefined,rank=0;
 return sorted.map((item,index)=>{const current=value(item);if(current!==previous){rank=index+1;previous=current;}return {...item,rank};}).filter(item=>item.rank<=5);
}

// Match the Mac bridge: quoted message text, punctuation, symbols, emoji and
// placeholders are excluded from the effective-character count.
export function effectiveCharacterCount(text:unknown){
 if(typeof text!=='string')return 0;
 const authored=text.split(/(?:\r\n|\r|\n| ⏎ )引用\s+@/u,1)[0];
 if(!authored.trim()||['[非文字消息]','[空消息]'].includes(authored.trim()))return 0;
 return [...authored].filter(char=>/[\p{L}\p{N}]/u.test(char)).length;
}

export function hermesStats(messages:Array<{sender?:string|null;text?:string;time_kind?:string}>){
 const counts=new Map<string,{name:string;count:number;characterCount:number}>();
 for(const message of messages){
  if(!message.sender)continue;
  const row=counts.get(message.sender)||{name:message.sender,count:0,characterCount:0};
  row.count++;row.characterCount+=effectiveCharacterCount(message.text);counts.set(message.sender,row);
 }
 const all=[...counts.values()],maximumMessages=Math.max(0,...all.map(x=>x.count)),maximumCharacters=Math.max(0,...all.map(x=>x.characterCount));
 const half=(value:number,max:number)=>max?Math.floor((value*5000+Math.floor(max/2))/max):0;
 const rankings=ranked(all,x=>x.count).map(({name,count,rank}):Speaker=>({name,count,rank}));
 const leastRankings=ranked(all,x=>x.count,false).map(({name,count,rank}):Speaker=>({name,count,rank}));
 const characterRankings=ranked(all.filter(x=>x.characterCount>0),x=>x.characterCount).map(({name,characterCount,rank}):CharacterSpeaker=>({name,characterCount,rank}));
 const compositeRankings=ranked(all.map(x=>({...x,score:half(x.count,maximumMessages)+half(x.characterCount,maximumCharacters)})),x=>x.score)
  .map(({name,count,characterCount,score,rank}):CompositeSpeaker=>({name,messageCount:count,characterCount,compositeScore:score/100,rank}));
 return {stats_version:2,rankings,leastRankings,characterRankings,compositeRankings};
}

function countRows(items:Speaker[]){
 const groups=new Map<string,Speaker[]>();
 for(const item of items){const key=item.rank+':'+item.count;groups.set(key,[...(groups.get(key)||[]),item]);}
 return [...groups.values()].map(rows=>`- ${rows.length>1?'并列':''}第 ${rows[0].rank} 名：${rows.map(x=>summaryMemberName(x.name)).join('、')}，${rows.length>1?'各 ':''}${rows[0].count} 条`).join('\n');
}
function characterRows(items:CharacterSpeaker[]){
 const groups=new Map<string,CharacterSpeaker[]>();
 for(const item of items){const key=item.rank+':'+item.characterCount;groups.set(key,[...(groups.get(key)||[]),item]);}
 return [...groups.values()].map(rows=>`- ${rows.length>1?'并列':''}第 ${rows[0].rank} 名：${rows.map(x=>summaryMemberName(x.name)).join('、')}，${rows.length>1?'各 ':''}${rows[0].characterCount} 字`).join('\n')||'- 本时段没有可计入的文字内容';
}
export function hermesRanking(slug:string,stats:any){
 const most=countRows(stats.rankings||[])||'- 本时段没有可确认昵称的发言人';
 if(slug==='ranking'||slug==='news')return `四、发言最多排行\n\n**发言最多（前五个名次）**\n${most}`+
  (slug==='news'?'\n\n> 本榜只记录本时段的发言数量，不代表贡献质量或人物价值；低频但有亮点的内容可在“今日高光时刻”中单独呈现。':'');
 if(slug==='entertainment'){
  const composite:CompositeSpeaker[]=stats.compositeRankings||[];
  const ties=new Map<number,number>();for(const row of composite)ties.set(row.rank,(ties.get(row.rank)||0)+1);
  const combined=composite.map(row=>`- ${(ties.get(row.rank)||0)>1?'并列':''}第 ${row.rank} 名：${summaryMemberName(row.name)}，${row.compositeScore.toFixed(2)} 分（${row.messageCount} 条、${row.characterCount} 字）`).join('\n');
  return `四、娱乐活跃度排行\n\n**1️⃣ 活跃冒泡榜｜发言条数（前五个名次）**\n${most}\n\n**2️⃣ 文字输出榜｜有效字数（前五个名次）**\n${characterRows(stats.characterRankings||[])}\n\n**3️⃣ 综合存在感榜｜条数 × 字数（前五个名次）**\n${combined}\n\n> 综合分＝50×（个人发言条数÷本时段最高条数）＋50×（个人有效字数÷本时段最高有效字数）；若本时段无有效文字，字数项统一计 0 分。有效字数不计标点、空白、表情、其他符号及引用原文。\n\n> 以上三榜只记录本时段的发言数量与文字量，不代表贡献质量或人物价值；低频但有亮点的内容可在“今日高光时刻”中单独呈现。`;
 }
 return `四、发言数量排行\n\n**发言最多（前五个名次）**\n${most}\n\n**发言最少（前五个名次，仅统计至少1条）**\n${countRows(stats.leastRankings||[])||'- 本时段没有可确认昵称的发言人'}`;
}


export function localizedRanking(slug:string,stats:any,language:string){
 if(language!=='en'&&language!=='ja')return hermesRanking(slug,stats);
 const en=language==='en',none=en?'No identified speakers in this period':'この期間に名前を確認できる発言者はいません';
 const rows=(items:any[],metric:string)=>items.map(r=>`- ${r.rank}. ${summaryMemberName(r.name)} · ${metric==='score'?r.compositeScore.toFixed(2):r[metric]}`+(metric==='count'?(en?' messages':' 件'):metric==='characterCount'?(en?' effective characters':' 有効文字'):en?' points':' 点')).join('\n')||none;
 const most=(en?'Most messages (ranks 1–5, including ties)':'発言最多（上位5位、同順位を含む）')+'\n'+rows(stats.rankings||[],'count');
 const heading=en?'IV. Activity rankings':'四、活動ランキング';
 if(slug==='ranking'||slug==='news')return heading+'\n\n'+most;
 if(slug==='entertainment')return heading+'\n\n'+most+'\n\n'+(en?'Effective characters (ranks 1–5)':'有効文字数（上位5位）')+'\n'+rows(stats.characterRankings||[],'characterCount')+'\n\n'+(en?'Composite activity (ranks 1–5)':'総合活動度（上位5位）')+'\n'+rows(stats.compositeRankings||[],'score')+'\n\n'+(en?'Score = 50 × personal/max message count + 50 × personal/max effective characters. A zero character maximum contributes zero. Quotes, punctuation, whitespace and emoji are excluded. These measure volume, not contribution quality.':'総合点＝50×本人/最大発言数＋50×本人/最大有効文字数。最大文字数0の場合は文字項を0点とします。引用原文・句読点・空白・絵文字は除外。量の指標であり貢献の質を示しません。');
 return heading+'\n\n'+most+'\n\n'+(en?'Fewest messages (ranks 1–5, speakers with at least one message)':'発言最少（上位5位、1件以上の発言者のみ）')+'\n'+rows(stats.leastRankings||[],'count');
}
export function requireRankingStats(slug:string,stats:any){
 if(['comprehensive','technical'].includes(slug)&&!Array.isArray(stats?.leastRankings)||slug==='entertainment'&&(!Array.isArray(stats?.characterRankings)||!Array.isArray(stats?.compositeRankings)))throw new Error('旧预览缺少本版完整统计，请重新生成后发布');
}
