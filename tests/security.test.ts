import {test} from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash,passwordValid,secureEqual,digest} from '../server/security.js';
import {splitText,searchTerms} from '../server/search.js';
test('password hashing verifies valid credentials and rejects incorrect passwords',()=>{
  const a=passwordHash('a-long-password-for-test'),b=passwordHash('a-long-password-for-test');
  assert.notEqual(a,b);assert.equal(passwordValid('a-long-password-for-test',a),true);
  assert.equal(passwordValid('incorrect',a),false);assert.equal(passwordValid('x','invalid'),false);
});
test('tokens require full equality, independent of length',()=>{
  assert(secureEqual('secret-token','secret-token'));assert(!secureEqual('secret-token','secret'));
  assert.equal(digest('x').length,64);
});
test('chunking preserves text continuity and removes nulls',()=>{
  const content='甲乙丙丁'.repeat(1000),chunks=splitText(content);
  assert(chunks.length>1);for(let i=1;i<chunks.length;i++)assert(chunks[i-1].endsWith(chunks[i].slice(0,120)));
  assert.deepEqual(splitText(' \0\n '),[]);
});
test('Chinese and English search extracts useful bounded terms',()=>{
  const terms=searchTerms('英语口语活动 English ENGLISH');
  assert(terms.includes('英语'));assert(terms.includes('口语'));assert(terms.includes('english'));
  assert.equal(terms.filter(t=>t==='english').length,1);assert(searchTerms('甲'.repeat(200)).length<=32);
});
