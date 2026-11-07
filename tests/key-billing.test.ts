import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outputLimit,responseUsage} from '../server/model-proxy.js';
import {parseUsage} from '../server/key-vault.js';
test('OpenAI stream explicitly asks for final usage and preserves valid stream options',()=>{
 const b:any={stream:true,max_tokens:64,stream_options:{include_usage:false,include_obfuscation:false}};assert.equal(outputLimit(b,'openai'),64);assert.deepEqual(b.stream_options,{include_usage:true,include_obfuscation:false});
 assert.throws(()=>outputLimit({stream:true,stream_options:'invalid'},'openai'));
 const raw='data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n';assert.deepEqual(parseUsage(responseUsage(raw)),{input:10,output:2,cached:0});
});
test('output limit normalization cannot leave a conflicting larger alternate limit',()=>{
 const chat:any={max_output_tokens:32,max_completion_tokens:50000,max_tokens:50000};assert.equal(outputLimit(chat,'openai'),32);assert.equal(chat.max_completion_tokens,32);assert.equal(chat.max_tokens,undefined);assert.equal(chat.max_output_tokens,undefined);
 const responses:any={max_output_tokens:100,max_tokens:50000};assert.equal(outputLimit(responses,'openai_responses'),100);assert.equal(responses.max_tokens,undefined);assert.throws(()=>outputLimit({generationConfig:{maxOutputTokens:32769}},'gemini'));
});
