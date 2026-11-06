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

import {onboardingFlowId,resumeOnboardingTask} from '../shared/group-onboarding.js';
test('refresh resumes the parent workflow after greeting and keeps other groups and robot scopes separate',()=>{
 const flow={id:'parent',kind:'connect',status:'succeeded'},other={id:'other-flow',kind:'connect',status:'succeeded'};
 const greeting={id:'child',kind:'greeting',parent_id:flow.id,status:'succeeded'},discover={id:'discovery',kind:'discover',status:'succeeded'};
 assert.equal(onboardingFlowId(greeting),flow.id);assert.equal(resumeOnboardingTask(greeting.id,[flow,other],[greeting,discover]),flow.id);
 assert.equal(resumeOnboardingTask(flow.id,[flow,other],[discover]),flow.id);
 assert.equal(resumeOnboardingTask('foreign-bot-flow',[],[]),null);
 assert.equal(resumeOnboardingTask(other.id,[flow,other],[greeting]),other.id);
 assert.equal(resumeOnboardingTask(discover.id,[flow],[discover,greeting]),discover.id);
 assert.equal(resumeOnboardingTask(null,[flow],[{...greeting,status:'working'}]),flow.id);
});
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OnboardingFlow} from '../web/onboarding-flow.js';
test('a completed flow stays complete with optional connection warnings and exposes no repeated greeting action',()=>{
 const noop=()=>{};
 const html=renderToStaticMarkup(createElement(OnboardingFlow,{flow:{id:'parent',ready:true,status:'succeeded',group:{name:'Synthetic group',enabled:true,revision:2,applied_revision:2},followups:{greeting:{id:'g',status:'succeeded'},verify:{id:'v',status:'succeeded',result:{wechat:false,reader:true,sender:true}}}},activeJob:null,busy:false,onRefresh:noop,onVerify:noop,onGreeting:noop,onViewTask:noop,onOpenGroup:noop,onRetry:noop,onCancel:noop}));
 assert(html.includes('必做步骤已完成'));assert(html.includes('查看问候结果'));assert(html.includes('部分连接待恢复'));assert(!html.includes('发送入群问候（需确认）'));assert(html.includes('4、5、6 均为可选操作'));
});
