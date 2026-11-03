import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuredModelRoutes,groupRoutes,defaultRoutes} from '../server/models.js';
const a={credential_id:'11111111-1111-4111-8111-111111111111',model_id:'base-a'};
const b={credential_id:'22222222-2222-4222-8222-222222222222',model_id:'stage-b'};
const group=()=>groupRoutes.parse({text:{mode:'custom',...a},image:{mode:'disabled'}});
test('stages inherit the group base without introducing extra calls or replacing legacy routes',()=>{
  const r=configuredModelRoutes(group(),{text:null,image:null});
  assert.deepEqual(r.stages.planner,r.text);assert.deepEqual(r.stages.replyer,r.text);
  assert.equal(configuredModelRoutes(groupRoutes.parse({text:{mode:'inherit'},image:{mode:'inherit'}}),{text:null,image:null}).stages.utils.source,'legacy');
});
test('group stage override wins over global stage which wins over group base',()=>{
  const g=group();g.stages={replyer:{mode:'custom',...a}};
  const r=configuredModelRoutes(g,{text:null,image:null,stages:{planner:b,replyer:b,summary:b}});
  assert.equal(r.stages.planner.source,'default_stage');assert.deepEqual(r.stages.planner.selection,b);
  assert.equal(r.stages.replyer.source,'group_stage');assert.deepEqual(r.stages.replyer.selection,a);
  assert.deepEqual(r.stages.utils.selection,a);assert.deepEqual(r.stages.summary.selection,b);
});
test('disabling group text blocks all stage overrides',()=>{
  const g=group();g.text={mode:'disabled'};g.stages={planner:{mode:'custom',...b}};
  const r=configuredModelRoutes(g,{text:a,image:null,stages:{replyer:b}});
  assert(Object.values(r.stages).every(v=>v.source==='disabled'&&v.selection===null));
});
test('stage schema rejects unknown roles and disabling individual required stages',()=>{
  assert.throws(()=>groupRoutes.parse({...group(),stages:{unknown:{mode:'inherit'}}}));
  assert.throws(()=>groupRoutes.parse({...group(),stages:{replyer:{mode:'disabled'}}}));
  assert.throws(()=>defaultRoutes.parse({text:null,image:null,stages:{unknown:a}}));
});
