import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timeoutDefaults,timeoutPolicyIssue} from '../shared/timeout-policy.js';
import {timeoutPolicySchema} from '../server/timeout-policy.js';
import {effectivePolicy} from '../server/policies.js';
test('existing groups receive the current 300/310/420 second defaults',()=>{
 const old=effectivePolicy({language:'auto',allow_language_override:true});assert.deepEqual(old.timeouts,timeoutDefaults);
 const another=effectivePolicy({language:'en',allow_language_override:false});old.timeouts.planner_seconds=60;
 assert.equal(another.timeouts.planner_seconds,300);assert.equal(timeoutDefaults.planner_seconds,300);
});
test('timeout policy accepts distinct bounded budgets for different groups',()=>{
 for(const value of [timeoutDefaults,{...timeoutDefaults,planner_seconds:30,request_seconds:40,direct_ttl_seconds:105},{...timeoutDefaults,planner_seconds:600,request_seconds:660,direct_ttl_seconds:1800}]){
  assert.deepEqual(timeoutPolicySchema.parse(value),value);assert.equal(timeoutPolicyIssue(value),'');
 }
});
test('both form and server reject inconsistent or non-integer time budgets',()=>{
 for(const value of [{...timeoutDefaults,planner_seconds:601},{...timeoutDefaults,request_seconds:300},{...timeoutDefaults,direct_ttl_seconds:374},{...timeoutDefaults,planner_seconds:30.5},{...timeoutDefaults,direct_ttl_seconds:NaN}]){
  assert(!timeoutPolicySchema.safeParse(value).success);assert(timeoutPolicyIssue(value));
 }
 assert(!timeoutPolicySchema.safeParse({...timeoutDefaults,hidden_override:9999}).success);
 assert(!timeoutPolicySchema.safeParse({planner_seconds:60}).success);
});

test('old three-field policies retain the current five-minute apology default',()=>{
 assert.equal(timeoutPolicySchema.parse({planner_seconds:300,request_seconds:310,direct_ttl_seconds:420}).wait_apology_seconds,300);
 const old=effectivePolicy({policy:{language:{mode:'follow',allowed:[],fallback:'en',allow_requested:true},timeouts:{planner_seconds:300,request_seconds:310,direct_ttl_seconds:420}}});
 assert.equal(old.timeouts.wait_apology_seconds,300);
});
test('apology threshold accepts whole minutes independently of the request lifetime',()=>{
 for(const seconds of [60,120,300,1800]){const t={...timeoutDefaults,wait_apology_seconds:seconds};assert.deepEqual(timeoutPolicySchema.parse(t),t);assert.equal(timeoutPolicyIssue(t),'');}
 for(const seconds of [0,30,61,1801,120.5]){const t={...timeoutDefaults,wait_apology_seconds:seconds};assert(!timeoutPolicySchema.safeParse(t).success);assert.match(timeoutPolicyIssue(t),/分钟/);}
});
