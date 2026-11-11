import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactMessages,materialInput,modelChunks,noteGroups,noteInput} from '../server/summaries/planning.js';
import {summaryProgressText} from '../shared/summary-progress.js';
import {sliceCachedMessages} from '../server/summaries/source-cache.js';
const job={group_name:'Synthetic',window_start:'2026-11-02T16:00:00Z',window_end:'2026-11-03T16:00:00Z',config:{timezone:'Asia/Shanghai'}};
const message=(seq:number,text='Synthetic discussion',time_kind:'original'|'capture'='original')=>({seq,sender:seq%2?'A':'B',text,at:new Date(Date.parse(job.window_start)+(seq%2000)*60000).toISOString(),time_kind});
test('979 short posts retain all content in one compact full-day input beyond the former envelope ceiling',()=>{
 const rows=Array.from({length:979},(_,i)=>({...message(1010000000000+i,'全天同一话题的后续讨论'),sender:i%2?'Synthetic member A':'Synthetic member B'}));
 // Use valid time separately from large source IDs.
 rows.forEach((m,i)=>m.at=new Date(Date.parse(job.window_start)+i*60000).toISOString());
 assert(JSON.stringify(rows).length>110000);const input=materialInput(job,rows);assert(input.length<=60000);
 const data=JSON.parse(input);assert.equal(data.messages.length,979);assert.equal(data.messages[978][3],rows[978].text);
});
test('compact input preserves sender absence and never exposes capture clocks as sent times',()=>{
 const rows=[{...message(1),sender:null},message(2,'synthetic','capture')];const data=compactMessages(rows,'Asia/Shanghai');
 assert.equal(data.senders[data.messages[0][1] as number],null);assert.equal(data.messages[1][2],null);assert.equal(data.messages[0][2],'2026-11-03 00:01');
});
test('large days are partitioned within budget with every original preserved and stable boundary context IDs',()=>{
 const rows=Array.from({length:1100},(_,i)=>message(i+1,'长讨论😀'.repeat(30))),chunks=modelChunks(job,rows,24000);
 assert(chunks.length>1);assert(chunks.every(c=>materialInput(job,c).length<=24000));
 const map=new Map(chunks.flat().map(m=>[m.seq,m.text]));assert.equal(map.size,rows.length);for(const row of rows)assert.equal(map.get(row.seq),row.text);
 assert(chunks[1].some(m=>chunks[0].slice(-3).some(before=>before.seq===m.seq)));
});
test('one long Unicode message is fragmented without losing characters or source identity',()=>{
 const text='😀讨论'.repeat(6000),rows=[message(7,text)],chunks=modelChunks(job,rows,24000),fragments=new Map(chunks.flat().map(m=>[m.fragment,m]));
 assert(chunks.every(c=>materialInput(job,c).length<=24000));assert.equal([...fragments.values()].map(m=>m.text).join(''),text);assert([...fragments.values()].every(m=>m.seq===7));
});
test('hierarchical notes are grouped within budget without silently dropping any segment',()=>{
 const notes=Array.from({length:40},(_,i)=>`${i}:`+'合成归纳'.repeat(800)),groups=noteGroups(job,notes,24000);
 assert.deepEqual(groups.flat(),notes);assert(groups.length<notes.length);assert(groups.every(g=>noteInput(job,g,'reduce').length<=24000));
});
test('progress explains estimates and whole-day versus hierarchical processing without a polling requirement',()=>{
 assert.match(summaryProgressText({status:'reading'}),/统计/);
 const text=summaryProgressText({status:'generating',progress:{total_count:979,total_characters:12000,planned_batches:5,completed_batches:5,read_count:979,strategy:'whole'}});
 assert.match(text,/979\/979/);assert.match(text,/全天/);
 assert.match(summaryProgressText({status:'generating',progress:{strategy:'hierarchical',phase:'merging',model_batches:4,completed_model_batches:4}}),/跨时段/);
 assert.match(summaryProgressText({status:'queued',progress:{cache_hit:true,cache_fetched_at:'2026-11-03T00:00:00Z'}}),/复用已保存/);
});
test('cached parent windows use left-closed right-open child boundaries',()=>{
 const rows=[message(1),message(2),message(3)];
 rows[0].at='2026-11-03T00:00:00Z';rows[1].at='2026-11-03T00:10:00Z';rows[2].at='2026-11-03T00:20:00Z';
 assert.deepEqual(sliceCachedMessages(rows,'2026-11-03T00:10:00Z','2026-11-03T00:20:00Z').map(x=>x.seq),[2]);
});
