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
 for(const value of [timeoutDefaults,{planner_seconds:30,request_seconds:40,direct_ttl_seconds:105},{planner_seconds:600,request_seconds:660,direct_ttl_seconds:1800}]){
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
