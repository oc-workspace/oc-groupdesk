import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeHealthSchema} from '../server/runtime-health.js';
import {runtimeLabel} from '../web/runtime-health.js';
const now=Date.parse('2026-11-01T02:00:00Z');
const h={state:'online',wechat:true,bridge:true,maibot:true,reason:'ok',interval_seconds:3600,actions:[]};
test('hourly runtime health is distinct from configuration acknowledgments',()=>{
 assert.equal(runtimeLabel(null,null,now).ok,false);
 assert.equal(runtimeLabel(h,new Date(now-3600000).toISOString(),now).ok,true);
 assert.equal(runtimeLabel(h,new Date(now-4500001).toISOString(),now).ok,false);
 assert.match(runtimeLabel({...h,state:'needs_phone',wechat:false},new Date(now).toISOString(),now).label,/手机/);
 assert.equal(runtimeLabel({...h,bridge:false},new Date(now).toISOString(),now).ok,false);
});
test('health reports accept only bounded status fields, not secrets or chat bodies',()=>{
 assert(runtimeHealthSchema.safeParse({external_id:'example-room',...h}).success);
 assert(!runtimeHealthSchema.safeParse({external_id:'example-room',...h,interval_seconds:30}).success);
 assert(!runtimeHealthSchema.safeParse({external_id:'example-room',...h,token:'sensitive'}).success);
 assert(!runtimeHealthSchema.safeParse({external_id:'example-room',...h,reason:'arbitrary chat text'}).success);
});
