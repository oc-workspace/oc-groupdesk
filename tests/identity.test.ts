import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityInstructions,identityPolicySchema} from '../server/identity.js';
import {parseGroupPolicy,policyInstructions} from '../server/policies.js';

test('older group policies receive a truthful non-proactive identity default',()=>{
  const p=parseGroupPolicy({language:{mode:'follow',allowed:[],fallback:'zh-CN',allow_requested:true}});
  assert.deepEqual(p.identity,{disclosure:'when_asked',personal_questions:'tactful'});
  assert(policyInstructions(p).some(s=>s.includes('日常回复不主动')));
});
test('both disclosure modes preserve direct-question truthfulness and different personal-question styles',()=>{
  for(const disclosure of ['when_asked','proactive'] as const){
    const tactful=identityInstructions({disclosure,personal_questions:'tactful'},'gt-persona');
    const plain=identityInstructions({disclosure,personal_questions:'plain'},'gt-persona');
    assert(tactful[0].includes('简短如实回答'));assert(plain[0].includes('简短如实回答'));
    assert(tactful.some(s=>s.includes('合成语气示例')));assert(!plain.some(s=>s.includes('合成语气示例')));
  }
  assert(identityInstructions({disclosure:'proactive',personal_questions:'tactful'},'gt-persona').some(s=>s.includes('首次交流')));
});
test('unsupported concealment modes are rejected; neutral persona never inherits GT examples',()=>{
  for(const value of ['never',false,'pretend_human'])assert(!identityPolicySchema.safeParse({disclosure:value}).success);
  assert(!identityPolicySchema.safeParse({disclosure:'when_asked',deny_ai:true}).success);
  const neutral=identityInstructions({disclosure:'when_asked',personal_questions:'tactful'},'neutral');
  assert(!neutral.some(s=>s.includes('口吻可以借')));assert(neutral.some(s=>s.includes('不模仿GT')));
});
