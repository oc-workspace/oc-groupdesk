import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTopicDraft} from '../server/topic-drafting.js';
import {callTextModel,generationRequest} from '../server/model-generation.js';
import {foodDraft} from './topic-fixture.js';
test('AI topic output fills the complete editable configuration and accepts a JSON fence',()=>{
 assert.deepEqual(parseTopicDraft(JSON.stringify(foodDraft)),foodDraft);
 assert.deepEqual(parseTopicDraft('```json\n'+JSON.stringify(foodDraft)+'\n```'),foodDraft);
});
test('AI topic output rejects partial, malformed or privilege-changing fields atomically',()=>{
 for(const output of ['unfinished',JSON.stringify({name:'美食'}),JSON.stringify({...foodDraft,id:'not-allowed'}),JSON.stringify({...foodDraft,policy:{...foodDraft.policy,regex:'(a+)+$'}}),JSON.stringify({...foodDraft,policy:{...foodDraft.policy,context:{...foodDraft.policy.context,seconds:181}}})])assert.throws(()=>parseTopicDraft(output));
 assert.throws(()=>parseTopicDraft(JSON.stringify({...foodDraft,policy:{...foodDraft.policy,lexicons:{},combinations:[]}})));
});
test('generated topic rules work with the real literal classifier and bounded continuation',async()=>{
 const {classify}=await import('../integration/participation/matcher.mjs');const p=parseTopicDraft(JSON.stringify(foodDraft)).policy;
 const start=classify(p,'今天想吃火锅',0);assert.equal(start.reason,'explicit');
 assert.equal(classify(p,'This soup is tasty',0).reason,'combination');
 assert.equal(classify(p,'food for thought',0).reason,'none');assert.equal(classify(p,'你好，今天怎么样',0).reason,'none');
 assert.equal(classify(p,'听起来不错',50,start.state).reason,'context');assert.equal(classify(p,'听起来不错',181,start.state).reason,'none');
});
test('topic requests honor the output budget and only lower thinking on the explicitly supported plain Gemini model',()=>{
 const c={base_url:'https://example.com',client_type:'gemini' as const};
 const low=generationRequest(c,'gemini-3.8-flash','s','i',{maxOutputTokens:6000,lowThinking:true});
 assert.deepEqual((low.body as any).generationConfig,{maxOutputTokens:6000,thinkingConfig:{thinkingLevel:'LOW',includeThoughts:false}});
 assert.equal((generationRequest(c,'gemini-3.8-flash-high','s','i',{lowThinking:true}).body as any).generationConfig.thinkingConfig,undefined);
 assert.equal((generationRequest(c,'gemini-3.8-flash','s','i').body as any).generationConfig.maxOutputTokens,8192);
 assert.equal((generationRequest(c,'gemini-3.8-flash','s','i').body as any).generationConfig.thinkingConfig,undefined);
});
test('cancelled text generation never resolves DNS or opens a model request',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(callTextModel({base_url:'must-not-be-read'},'m','s','i',{signal:controller.signal}),{name:'AbortError'});
});
