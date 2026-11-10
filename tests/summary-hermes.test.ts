import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {hermesStats,effectiveCharacterCount,localizedRanking,requireRankingStats} from '../server/summaries/hermes-format.js';
import {validateSummaryReport,reportContractPrompt} from '../server/summaries/report-contract.js';
import {builtinSummarySlugs,fullSummaryInstructions} from '../server/summaries/templates.js';
const topic='**话题名**：1️⃣ 验证方法 🔥🔥\n**主要参与者**：@aa、@bb\n**时间段**：原始发送时间未获取\n**讨论过程**：@aa 提出问题，@bb 建议测试，尚未形成结论。\n**简短评价**：先验证再决定。\n------------';
const report='一、整体评价\n讨论了验证方法。\n二、重点话题总结\n'+topic+'\n三、其他话题与群像彩蛋\n**其他话题**：零散问候。\n**今日高光时刻**\n- 一次具体的测试建议。\n**散场彩蛋**：下次分享结果。';
test('all five complete writing adapters retain verified Hermes source and original versions',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../skills/wechat-server-summary/hermes/manifest.json',import.meta.url),'utf8'));
 for(const slug of builtinSummarySlugs){
  const entry=manifest[slug],source=readFileSync(new URL('../skills/wechat-server-summary/hermes/'+entry.skill+'/SKILL.md',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),entry.sha256);
  const rules=fullSummaryInstructions(slug,'请保留这一条后台自定义要求');
  for(const label of ['主要参与者','时间段','讨论过程','简短评价','🔥','@'])assert(rules.includes(label),slug+': '+label);
  assert(rules.includes('请保留这一条后台自定义要求'));assert.equal(fullSummaryInstructions(slug,rules),rules);
  if(slug==='news')for(const label of ['情感与心理','今日胡说八道金句','今日聊天角色','今日互动关系','80 个汉字'])assert(rules.includes(label));
 }
});
test('every built-in accepts complete fields and sparse records, without forcing invented roles or relationships',()=>{
 for(const slug of builtinSummarySlugs){assert.equal(validateSummaryReport(report,slug,'zh-CN'),report);const sparse=report.replace(topic,'本时段没有可展开的重点话题。');assert.equal(validateSummaryReport(sparse,slug,'zh-CN'),sparse);}
});
test('missing, empty, reordered and partially populated topics fail independently',()=>{
 for(const body of [report.replace('一、整体评价\n讨论了验证方法。',''),report.replace('讨论了验证方法。',''),report.replace('二、重点话题总结','二、重点话题'),report.replace('**时间段**：原始发送时间未获取','**时间段**：'),report.replace('**讨论过程**：@aa 提出问题，@bb 建议测试，尚未形成结论。',''),report.replace('三、其他话题',topic.replace('**主要参与者**：@aa、@bb','')+'\n三、其他话题')])assert.throws(()=>validateSummaryReport(body,'comprehensive','zh-CN'),/格式不完整/);
 const trick=report.replace(topic,'有人说“没有可展开的重点话题”，其实这里还有其他材料。');assert.throws(()=>validateSummaryReport(trick,'ranking','zh-CN'));
});
test('news and entertainment require nonempty highlights and closing while optional modules may be omitted',()=>{
 for(const slug of ['news','entertainment'])for(const body of [report.replace('**今日高光时刻**\n- 一次具体的测试建议。',''),report.replace('- 一次具体的测试建议。',''),report.replace('下次分享结果。','')])assert.throws(()=>validateSummaryReport(body,slug,'zh-CN'),/非空模块/);
});
test('English and Japanese use localized contracts with equally strict fields and highlights',()=>{
 for(const [language,heads,labels,extra] of [
  ['en',['I. Overall assessment','II. Main topics','III. Other topics'],['Topic','Participants','Time range','Discussion','Brief assessment'],['Highlights','Closing note']],
  ['ja',['一、全体評価','二、主な話題','三、その他の話題'],['話題名','主な参加者','時間帯','議論の経緯','短評'],['今日のハイライト','締めのひとこと']]
 ] as const){const body=heads[0]+'\nSummary.\n'+heads[1]+'\n'+labels.map(label=>'**'+label+'**: Evidence.').join('\n')+'\n'+heads[2]+'\n'+extra.map(label=>'**'+label+'**: Evidence.').join('\n');assert.equal(validateSummaryReport(body,'news',language),body);assert.throws(()=>validateSummaryReport(body.replace('**'+labels[1]+'**: Evidence.',''),'news',language));assert(reportContractPrompt('news',language).includes(extra[0]));}
});
test('model-made ranking is removed so exact program rankings cannot be duplicated',()=>{
 for(const suffix of ['\n四、发言最多排行\n虚构数字','\n## 四、发言最多排行\n虚构数字','\nIV. Activity rankings\n999'])assert.equal(validateSummaryReport(report+suffix,'news','zh-CN'),report);
});
test('effective characters and composite scores match bridge arithmetic and exclude quoted original',()=>{
 assert.equal(effectiveCharacterCount('你好A1 ！😀\n引用 @甲 被引用的字'),4);
 assert.equal(effectiveCharacterCount('hi ⏎ 引用 @甲 lots of quoted letters'),2);
 assert.equal(effectiveCharacterCount('[非文字消息]'),0);assert.equal(effectiveCharacterCount('[空消息]'),0);
 const stats=hermesStats([{sender:'a',text:'甲乙丙'},{sender:'a',text:'丁'},{sender:'b',text:'甲'},{sender:null,text:'excluded'}]);
 assert.equal(stats.compositeRankings[0].compositeScore,100);assert.equal(stats.compositeRankings[1].compositeScore,37.5);assert.equal(stats.characterRankings[0].characterCount,4);
 const empty=hermesStats([{sender:'a',text:'[非文字消息]'}]);assert.equal(empty.compositeRankings[0].compositeScore,50);assert.deepEqual(empty.characterRankings,[]);
});
test('competition rankings retain all cutoff ties, least includes only speakers, and all five render correct boards',()=>{
 const rows=['a','a','a','b','b','c','d','e','f'].map(sender=>({sender,text:sender}));const stats=hermesStats(rows);
 assert.deepEqual(stats.rankings.map(r=>r.rank),[1,2,3,3,3,3]);assert.deepEqual(stats.leastRankings.map(r=>r.rank),[1,1,1,1,5]);
 for(const language of ['zh-CN','en','ja'])for(const slug of builtinSummarySlugs){const body=localizedRanking(slug,stats,language);assert(body.includes('@a'));assert(body.includes('@f'));requireRankingStats(slug,stats);}
 assert(localizedRanking('comprehensive',stats,'zh-CN').includes('发言最少'));assert(localizedRanking('technical',stats,'zh-CN').includes('发言最少'));assert(!localizedRanking('news',stats,'zh-CN').includes('发言最少'));assert(localizedRanking('entertainment',stats,'zh-CN').includes('综合存在感'));
 assert.throws(()=>requireRankingStats('entertainment',{rankings:[]}));assert.throws(()=>requireRankingStats('technical',{rankings:[]}));requireRankingStats('news',{rankings:[]});
});

test('mixed topic styles cannot hide a second incomplete topic and ordinary numbered highlights survive',()=>{
 const mixed=report.replace('三、其他话题', '**主要参与者**：@cc\n**时间段**：未知\n**讨论过程**：另一个话题未给评价。\n三、其他话题');assert.throws(()=>validateSummaryReport(mixed,'news','zh-CN'));
 const numbered=report.replace('- 一次具体的测试建议。','1. 第一条\n2. 第二条\n3. 第三条\n4. 第四条');assert.equal(validateSummaryReport(numbered,'news','zh-CN'),numbered);
});
