import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequestActivityStore,requestActivityLabel,trackRequest} from '../shared/request-activity.js';
import {onboardingTaskLoading} from '../shared/onboarding-loading.js';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('concurrent requests stay busy until each finishes; robot switching hides the old scope',async()=>{
 const store=createRequestActivityStore(),a=deferred<string>(),b=deferred<string>();let notifications=0;const stop=store.subscribe(()=>notifications++);
 const first=trackRequest(store,'/overview','GET','a',()=>a.promise),second=trackRequest(store,'/group-onboarding/suggest','POST','b',()=>b.promise);
 assert.equal(store.getSnapshot().length,2);assert.equal(store.visible('a').length,1);assert.equal(store.visible('b')[0].label,'AI 正在生成配置建议…');
 a.resolve('done');assert.equal(await first,'done');assert.equal(store.visible('a').length,0);assert.equal(store.visible('b').length,1);
 b.resolve('suggestion');await second;assert.equal(store.getSnapshot().length,0);assert.equal(notifications,4);stop();
});
test('failures, aborts and synchronous errors release loading, without swallowing errors',async()=>{
 const store=createRequestActivityStore();
 for(const error of [Error('network failure'),Object.assign(Error('stopped'),{name:'AbortError'})]){await assert.rejects(trackRequest(store,'/topics/draft','POST','a',()=>Promise.reject(error)),error);assert.equal(store.getSnapshot().length,0);}
 await assert.rejects(trackRequest(store,'/overview','GET','a',()=>{throw Error('sync');}),/sync/);assert.equal(store.getSnapshot().length,0);
 const end=store.begin('one','a');end();end();assert.equal(store.getSnapshot().length,0);
});
test('background job polls are quiet and snapshots stable; labels never expose query text or IDs',async()=>{
 const store=createRequestActivityStore(),before=store.getSnapshot();await trackRequest(store,'/group-onboarding/jobs/private-id','GET','a',async()=>true);assert.equal(store.getSnapshot(),before);
 assert.equal(requestActivityLabel('/topics/draft','POST'),'AI 正在完善话题草稿…');assert.equal(requestActivityLabel('/model-credentials/private/refresh','POST'),'正在查询可用模型…');
 const text=requestActivityLabel('/persona-collections/private/messages?query=private-text','GET');assert.equal(text,'正在加载数据…');assert(!text?.includes('private'));
 const done=store.begin('global');assert.equal(store.visible('a').length,1);assert.equal(store.visible('b').length,1);done();
});
test('a submitted job remains visibly pending until terminal state, separately from HTTP',()=>{
 for(const status of ['queued','working'])assert.equal(onboardingTaskLoading({kind:'discover',status},true)?.active,true);
 assert.match(onboardingTaskLoading({kind:'connect',status:'succeeded',ready:false},true)!.label,/确认/);
 for(const status of ['failed','cancelled'])assert.equal(onboardingTaskLoading({kind:'discover',status},true),null);
 assert.equal(onboardingTaskLoading({kind:'discover',status:'succeeded'},true),null);assert.equal(onboardingTaskLoading({kind:'connect',status:'succeeded',ready:true},true),null);
 const stale=onboardingTaskLoading({kind:'discover',status:'working'},false);assert.equal(stale?.active,false);assert.match(stale!.detail,/刷新/);
});
