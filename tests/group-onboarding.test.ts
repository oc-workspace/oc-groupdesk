import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseOnboardingSuggestion} from '../server/group-onboarding.js';
import {defaultRoutes,configuredModelRoutes} from '../server/models.js';
const suggestion={topic_ids:[randomUUID()],participation:'quiet',topic_scope:'proactive',language:'auto',base_version_id:null,explanation:'先保持安静，确认后再接入。'};
test('onboarding AI accepts a complete editable suggestion and refuses authority-changing output',()=>{
 assert.deepEqual(parseOnboardingSuggestion(JSON.stringify(suggestion)),suggestion);
 for(const value of [{...suggestion,api_key:'must-not-exist'},{...suggestion,enable:true},{...suggestion,external_id:'forged'}, {topic_ids:[]},'unfinished'])assert.throws(()=>parseOnboardingSuggestion(typeof value==='string'?value:JSON.stringify(value)));
});
test('onboarding default stays separate from group chat stage routes',()=>{
 const model={credential_id:randomUUID(),model_id:'gpt-6-luna'};const base={text:null,image:null};
 assert.deepEqual(configuredModelRoutes({text:{mode:'inherit'},image:{mode:'inherit'}},base),configuredModelRoutes({text:{mode:'inherit'},image:{mode:'inherit'}},defaultRoutes.parse({...base,onboarding:model})));
});
