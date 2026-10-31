import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalog,effectivePolicy,parseGroupPolicy,replyLanguage,topicPolicySchema} from '../server/policies.js';
test('catalog has all eleven topic packs, food details and no group bindings',async()=>{
  const items=await catalog();assert.equal(items.length,11);
  const food=items.find(x=>x.key==='china-food');assert(food.policy.combinations.length);
  assert.equal(food.policy.context.seconds,180);assert(food.policy.lexicons.en.includes('Canto fare'));
  assert(!JSON.stringify(items).includes('26992'));assert(!JSON.stringify(items).includes('ssh外语学习园地'));
});
test('legacy single-language and override behavior is preserved',()=>{
  const p=effectivePolicy({language:'en',allow_language_override:true,policy:{}});
  assert.equal(replyLanguage(p),'en');assert.equal(replyLanguage(p,'ja'),'ja');assert.equal(p.topic_scope,'all');
});
test('restricted output languages do not allow a user request to escape the set',()=>{
  const p=parseGroupPolicy({language:{mode:'restricted',allowed:['zh-CN','en'],fallback:'en',allow_requested:true}});
  assert.equal(replyLanguage(p,'ja'),'en');assert.equal(replyLanguage(p,'zh-CN'),'zh-CN');
  assert.throws(()=>parseGroupPolicy({language:{mode:'restricted',allowed:['en'],fallback:'ja',allow_requested:true}}));
});
test('topic data accepts literal rule groups and rejects executable regex fields',()=>{
  const p=topicPolicySchema.parse({combinations:[{name:'food and taste',all:[['food','汤'],['tasty','鲜']]}]});
  assert.deepEqual(p.combinations[0].all[0],['food','汤']);
  assert.throws(()=>topicPolicySchema.parse({combinations:[{name:'bad',all:[['food']]}]}));
  assert.throws(()=>topicPolicySchema.parse({regex:'(a+)+$'}));
});

test('literal preview supports food combinations and bounded continuation without sending',async()=>{
  const {classify}=await import('../integration/participation/matcher.mjs');
  const policy=(await catalog()).find(x=>x.key==='china-food').policy;
  let r=classify(policy,'Canto fare is good.',0);assert.equal(r.reason,'explicit');
  r=classify(policy,'But it must be good since lots of people are waiting',50,r.state);assert.equal(r.reason,'context');assert.equal(r.state.at,0);
  assert.equal(classify(policy,'But it must be good since lots of people are waiting',181,r.state).reason,'none');
  assert.equal(classify(policy,'This soup tastes delicious.',0).reason,'combination');
  assert.equal(classify(policy,'food for thought',0).reason,'none');
});
