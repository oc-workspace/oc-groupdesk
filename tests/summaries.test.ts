import {summaryConfig} from '../shared/summaries.js';
import {modelStages} from '../shared/model-stages.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summaryDefaults,instant,resolveWindow,nextOccurrence} from '../shared/summaries.js';
import {sourceStats,reportParts,completeReport,summaryMessages,validateReportTimes} from '../server/summaries/generation.js';
test('summary defaults grant no automatic publication',()=>{assert.equal(summaryDefaults().enabled,false);assert.equal(summaryDefaults().model_route.mode,'unconfigured');});
test('day windows and minute windows use explicit zones and exclusive ends',()=>{
 const now=Date.parse('2026-11-02T03:00:00Z');
 assert.deepEqual(resolveWindow({kind:'previous_day'},'Asia/Shanghai',now),{start:'2026-10-31T16:00:00.000Z',end:'2026-11-01T16:00:00.000Z'});
 assert.deepEqual(resolveWindow({kind:'custom',start:'2026-10-31T17:24',end:'2026-11-01T18:40'},'Asia/Shanghai',now),{start:'2026-10-31T09:24:00.000Z',end:'2026-11-01T10:40:00.000Z'});
 assert.equal(resolveWindow({kind:'day',date:'2026-11-01'},'UTC',now).start,'2026-11-01T00:00:00.000Z');
});
test('future whole days, impossible dates, reversed and oversized windows are rejected',()=>{
 const now=Date.parse('2026-11-02T03:00:00Z');
 for(const w of [{kind:'day',date:'2026-11-02'},{kind:'day',date:'2026-02-30'},{kind:'custom',start:'2026-11-01T12:00',end:'2026-11-01T11:00'},{kind:'custom',start:'2026-01-01T00:00',end:'2026-11-01T00:00'}])assert.throws(()=>resolveWindow(w,'Asia/Shanghai',now));
 assert.throws(()=>instant('2026-13-01T20:00','UTC'));
});
test('daily and once execution dates advance across month and year boundaries',()=>{
 const daily={kind:'daily',at:'00:10',window:{kind:'previous_day'}};
 assert.equal(nextOccurrence(daily,'Asia/Shanghai',Date.parse('2026-12-31T16:11:00Z')),'2027-01-01T16:10:00.000Z');
 assert.equal(nextOccurrence({...daily,kind:'once',at:'2026-11-03T10:00'},'Asia/Shanghai',Date.parse('2026-11-02T00:00Z')),'2026-11-03T02:00:00.000Z');
 assert.throws(()=>nextOccurrence({...daily,kind:'once',at:'2026-11-01T10:00'},'Asia/Shanghai',Date.parse('2026-11-02T00:00Z')));
});
test('relative windows freeze their endpoint to the execution occurrence',()=>{
 const now=Date.parse('2026-11-02T03:00:00Z');assert.equal(resolveWindow({kind:'today'},'Asia/Shanghai',now).end,new Date(now).toISOString());
 assert.equal(Date.parse(resolveWindow({kind:'last_24h'},'UTC',now).start),now-86400000);
});
test('rankings count captured messages and retain fifth-place ties with competition ranks',()=>{
 const messages=['A','A','A','B','B','C','D','E','F'].map((sender,i)=>({sender,time_kind:i%2?'capture':'original'}));const s=sourceStats(messages);
 assert.deepEqual(sourceStats([{sender:null,time_kind:'capture'}]).rankings,[]);assert.equal(s.count,9);assert.equal(s.capture_time_count,4);assert.deepEqual(s.rankings.map(x=>x.rank),[1,2,3,3,3,3]);
});
test('delivery adds provenance, preserves source counts, and bounds every segment',()=>{
 for(const [value,protocol] of [[{choices:[{finish_reason:'length',message:{content:'A partial report'}}]},'openai'],[{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}]},'gemini'],[{status:'incomplete',output:[]},'openai_responses']] as const)assert.throws(()=>completeReport(value,protocol));
 const job={group_name:'Synthetic',external_id:'synthetic',config:{language:'en',timezone:'UTC'},template:{slug:'ranking'},window_start:'2026-11-01T00:00Z',window_end:'2026-11-02T00:00Z',report:'A meaningful synthetic discussion. '.repeat(150),source:{stats:{count:4,capture_time_count:2,rankings:[{rank:1,name:'Synthetic person',count:4}]}}};
 const p=reportParts(job);assert(p.length>1);assert(p.every(t=>t.length<=2000));assert(p[0].includes('not guaranteed complete'));assert(p.join('').includes('Synthetic person'));
 assert.throws(()=>reportParts({...job,report:'x'.repeat(16000)}));
});

test('capture-only rows never expose UTC or local capture clocks as speaking times',()=>{
 const input=[{seq:1,sender:null,text:'Synthetic private follow-up',at:'2026-11-01T15:10:36Z',time_kind:'capture'}];
 const data=summaryMessages(input,'Asia/Singapore');assert.equal(data[0].sent_time,null);assert.equal(data[0].sender,null);assert.equal(data[0].sender_status,'unavailable');assert(!JSON.stringify(data).includes('15:10'));assert(!JSON.stringify(data).includes('23:10'));
 assert.throws(()=>validateReportTimes('15:10 someone offered to send it privately.',input,'Asia/Singapore'));
 assert.throws(()=>validateReportTimes('23:10 someone offered to send it privately.',input,'Asia/Singapore'));
 validateReportTimes('A message offered to send it privately; sender name and original time unavailable.',input,'Asia/Singapore');
});
test('known original times are formatted once in the configured zone',()=>{
 const rows=[{seq:2,sender:'Synthetic member',text:'A synthetic message',at:'2026-11-01T23:48:16Z',time_kind:'original'}];
 assert.equal(summaryMessages(rows,'Asia/Singapore')[0].sent_time,'2026-11-02 07:48 (Asia/Singapore)');
 validateReportTimes('07:48 Synthetic member asked a question.',rows,'Asia/Singapore');assert.throws(()=>validateReportTimes('23:48 Synthetic member asked a question.',rows,'Asia/Singapore'));
});
test('summary provenance exposes missing names and separates capture coverage',()=>{
 const job={group_name:'Synthetic',external_id:'synthetic',config:{language:'zh-CN',timezone:'Asia/Singapore'},template:{slug:'comprehensive'},window_start:'2026-11-01T00:00Z',window_end:'2026-11-02T00:00Z',report:'A synthetic report.',source:{stats:{count:3,capture_time_count:2,unknown_sender_count:1,rankings:[]}}};
 assert(reportParts(job)[0].includes('1条未获取发送者昵称'));assert(reportParts({...job,config:{...job.config,language:'en'}})[0].includes('1 have no captured sender name'));
});

test('database summaries identify the verified database source in all supported languages',()=>{
 const job={group_name:'Synthetic',external_id:'synthetic',config:{language:'zh-CN',timezone:'Asia/Shanghai'},template:{slug:'comprehensive'},window_start:'2026-11-01T00:00Z',window_end:'2026-11-02T00:00Z',report:'Synthetic report.',source:{origin:'wechat-database-chatlog-keeper',stats:{count:3,capture_time_count:0,unknown_sender_count:1,rankings:[]}}};
 for(const language of ['zh-CN','en','ja']){const text=reportParts({...job,config:{...job.config,language}}).join('');assert(text.includes('Chatlog Reader'));assert(!text.includes('not guaranteed complete WeChat history'));}
});

import {summaryMemberName,withSummaryMemberRules} from '../shared/summary-member-names.js';
import {compactMessages} from '../server/summaries/planning.js';
test('member display formatting adds one prefix and preserves Unicode nicknames',()=>{
 for(const [name,expected] of [['aa','@aa'],['@aa','@aa'],['@@aa','@aa'],['GT🇨🇦','@GT🇨🇦'],['A B','@A B'],['','']])assert.equal(summaryMemberName(name),expected);
 const custom='保留管理员自定义规则';const decorated=withSummaryMemberRules(custom);assert(decorated.startsWith(custom));assert.equal(withSummaryMemberRules(decorated),decorated);
});
test('model material prefixes member labels without rewriting chat text or missing senders',()=>{
 const text='aa 提到 https://example.com/aa 和 aa@example.com';const rows=[{seq:1,sender:'aa',text,at:'2026-11-01T00:00Z',time_kind:'original' as const},{seq:2,sender:'@bb',text:'原话',at:'2026-11-01T00:01Z',time_kind:'original' as const},{seq:3,sender:null,text:'未知来源',at:'2026-11-01T00:02Z',time_kind:'capture' as const}];
 const result=compactMessages(rows,'UTC');assert.deepEqual(result.senders,['@aa','@bb',null]);assert.equal(result.messages[0][3],text);assert.equal(rows[0].sender,'aa');assert.deepEqual(new Set(sourceStats(rows).rankings.map(x=>x.name)),new Set(['aa','@bb']));
});
test('published rankings prefix every member in all ranking variants and languages',()=>{
 for(const slug of ['ranking','entertainment','news'])for(const language of ['zh-CN','en','ja']){
 const job={group_name:'Synthetic group',config:{language,timezone:'UTC'},template:{slug},window_start:'2026-11-01T00:00Z',window_end:'2026-11-02T00:00Z',report:'Synthetic report.',source:{stats:{count:2,capture_time_count:0,rankings:[{rank:1,name:'aa',count:1},{rank:1,name:'@bb',count:1}]}}};
 const text=reportParts(job).join('');assert(text.includes('@aa'));assert(text.includes('@bb'));assert(!text.includes('@@bb'));assert(text.includes('Synthetic group'));
 }
});

test('new summary settings do not inherit chat routes and stage editors omit summary',()=>{assert.throws(()=>summaryConfig.parse({model_route:{mode:'inherit'}}));assert(!modelStages.some(s=>s.id==='summary'));});
