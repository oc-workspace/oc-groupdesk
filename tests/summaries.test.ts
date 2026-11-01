import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summaryDefaults,instant,resolveWindow,nextOccurrence} from '../shared/summaries.js';
import {sourceStats,reportParts} from '../server/summaries/generation.js';
test('summary defaults grant no automatic publication',()=>{assert.equal(summaryDefaults().enabled,false);assert.equal(summaryDefaults().model_route.mode,'inherit');});
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
 const job={group_name:'Synthetic',external_id:'synthetic',config:{language:'en',timezone:'UTC'},template:{slug:'ranking'},window_start:'2026-11-01T00:00Z',window_end:'2026-11-02T00:00Z',report:'A meaningful synthetic discussion. '.repeat(150),source:{stats:{count:4,capture_time_count:2,rankings:[{rank:1,name:'Synthetic person',count:4}]}}};
 const p=reportParts(job);assert(p.length>1);assert(p.every(t=>t.length<=2000));assert(p[0].includes('not guaranteed complete'));assert(p.join('').includes('Synthetic person'));
 assert.throws(()=>reportParts({...job,report:'x'.repeat(16000)}));
});
