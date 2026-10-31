import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {parseMaterial} from '../server/persona-materials.js';
import {makeSkill,validateSkill,representativeSample,generationRequest,generationText} from '../server/persona-generation.js';
import {skillArchive} from '../server/personas-api.js';

test('material identity preserves repeated speech and Unicode while isolating quotations and groups',()=>{
 const r={id:'db:1',group_id:'room',sender_id:'speaker-a',timestamp:1700000000,authored_text:'same\u2028text',quoted_context:{speaker_id:'b',text:'not authored by a'}};
 const rows=parseMaterial(Buffer.from([r,{...r,id:'db:2'},{...r,id:'db:3',sender_id:'speaker-b'}].map(v=>JSON.stringify(v)).join('\n')),'jsonl','snapshot.jsonl','room');
 assert.equal(rows.length,3);assert.equal(rows[0].authored_text,'same\u2028text');assert.equal(rows[0].quoted_context.speaker_id,'b');
 assert.throws(()=>parseMaterial(Buffer.from(JSON.stringify({...r,group_id:'different'})),'jsonl','snapshot','room'));
 assert.throws(()=>parseMaterial(Buffer.from([r,{...r,authored_text:'conflict'}].map(v=>JSON.stringify(v)).join('\n')),'jsonl','snapshot','room'));
 assert.throws(()=>parseMaterial(Buffer.from(JSON.stringify(r)),'jsonl','snapshot',null));
});
test('reference documents have stable source IDs and remain separate from speakers',()=>{
 const a=parseMaterial(Buffer.from('reference one'),'md','notes.md'),b=parseMaterial(Buffer.from('reference two'),'md','notes.md');
 assert.equal(a[0].source_id,b[0].source_id);assert.notEqual(a[0].content_hash,b[0].content_hash);assert.equal(a[0].kind,'document');assert.equal(a[0].sender_id,'__reference__');
});
test('persona sampling is bounded, spans the period, excludes unreadable media and never consumes quoted text',()=>{
 const rows=Array.from({length:1000},(_,i)=>({source_id:String(i),collection_id:'c',sender_id:'s',timestamp:i,content_hash:'h',authored_text:'a'.repeat(5000),quoted_context:{text:'excluded quote'}}));
 const result=representativeSample([...rows,{authored_text:null}]);assert.equal(result.eligible,1000);assert.equal(result.selected.length,500);assert.equal(result.selected[0].id,'0');assert.equal(result.selected.at(-1).id,'999');assert(result.characters<=100000);assert(!JSON.stringify(result).includes('excluded quote'));assert(result.selected[0].truncated);
});
test('skill validation and portable archive preserve a self-contained UTF-8 SKILL',()=>{
 const skill=makeSkill('voice-a','中文用途','正文规则足够具体，跟随当前成员的语言；合成例句不可当历史原话，身份和权限规则由群配置决定。');
 assert(validateSkill(skill,'voice-a').includes('正文规则'));assert.throws(()=>validateSkill(skill,'other'));assert.throws(()=>skillArchive('../bad',skill,{}));
 const tar=gunzipSync(skillArchive('voice-a',skill,{sampled_records:3}));assert.equal(tar.subarray(0,100).toString().replace(/\0.*$/s,''),'voice-a/SKILL.md');
 const size=parseInt(tar.subarray(124,136).toString(),8);assert.equal(tar.subarray(512,512+size).toString(),skill);
});
test('generation routes each protocol correctly and extracts visible text without response storage',()=>{
 const gem=generationRequest({base_url:'https://example.com',client_type:'gemini'},'gemini-flash','system','input');assert.equal(gem.url.pathname,'/v1beta/models/gemini-flash:generateContent');
 assert.equal(generationRequest({base_url:'https://example.com/v1beta',client_type:'gemini'},'gemini-flash','s','i').url.pathname,gem.url.pathname);
 const responses=generationRequest({base_url:'https://example.com/v1',client_type:'openai_responses'},'gpt-example','s','i');assert.equal(responses.url.pathname,'/v1/responses');assert.equal((responses.body as any).store,false);
 const chat=generationRequest({base_url:'https://example.com/v1',client_type:'openai'},'gpt-example','s','i');assert.equal(chat.url.pathname,'/v1/chat/completions');assert.equal((chat.body as any).store,false);
 assert.equal(generationText({candidates:[{content:{parts:[{thought:true,text:'private thought'},{text:'visible'}]}}]},'gemini'),'visible');
 assert.equal(generationText({output:[{type:'reasoning',content:[{text:'private thought'}]},{type:'message',content:[{type:'output_text',text:'visible'}]}]},'openai_responses'),'visible');
 assert.throws(()=>generationText({choices:[]},'openai'));
});
