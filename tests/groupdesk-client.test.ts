import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupDeskClient} from '../integration/groupdesk-client.mjs';
const config={id:'synthetic-group',revision:4,timeout_policy_contract_version:2,policy:{timeouts:{planner_seconds:60,request_seconds:70,direct_ttl_seconds:180,wait_apology_seconds:300}}};
function fixture(bundle=config){
 const calls:{path:string;body?:any}[]=[];
 const client=new GroupDeskClient({baseUrl:'https://example.invalid',token:'isolated-adapter-token',fetchImpl:(async(url,init)=>{
  calls.push({path:String(url),body:init?.body?JSON.parse(String(init.body)):undefined});return new Response(JSON.stringify(String(url).endsWith('/ack')?{ok:true}:bundle),{status:200});
 }) as typeof fetch});
 return {client,calls};
}
test('adapter confirms group time budgets only after its apply callback declares support',async()=>{
 const {client,calls}=fixture();let applied=false;
 await client.applyConfig('synthetic-room',async c=>{assert.deepEqual(c.policy.timeouts,config.policy.timeouts);assert.equal(calls.length,1);applied=true;return {timeout_policy_version:2};});
 assert(applied);assert.deepEqual(calls[1].body,{group_id:'synthetic-group',revision:4,timeout_policy_version:2});
});
test('an older adapter cannot accidentally acknowledge unapplied time budgets',async()=>{
 const {client,calls}=fixture();await assert.rejects(client.applyConfig('synthetic-room',async()=>{}),/time budgets/);assert.equal(calls.length,1);
});
test('failed application does not send any configuration acknowledgement',async()=>{
 const {client,calls}=fixture();await assert.rejects(client.applyConfig('synthetic-room',async()=>{throw new Error('synthetic apply failure');}),/synthetic apply failure/);assert.equal(calls.length,1);
});

test('a v1 adapter cannot confirm the v2 per-group apology setting',async()=>{
 const {client,calls}=fixture();await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:1})),/time budgets/);assert.equal(calls.length,1);
});
test('the updated client can still apply an older v1 backend configuration',async()=>{
 const {client,calls}=fixture({...config,timeout_policy_contract_version:1});await client.applyConfig('synthetic-room',async()=>({timeout_policy_version:1}));assert.equal(calls[1].body.timeout_policy_version,1);
});

test('enabled interactions require the adapter capability before acknowledgement',async()=>{
 const bundle={...config,interactions_contract_version:1,interactions:{bindings:[{id:'synthetic-binding'}]}};
 const {client,calls}=fixture(bundle as typeof config);
 await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2})),/interactions/);assert.equal(calls.length,1);
 await client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2,interactions_policy_version:1}));assert.equal(calls.at(-1)!.body.interactions_policy_version,1);
});
test('conversation recognition is acknowledged only after the adapter applies its explicit capability',async()=>{
 const bundle={...config,conversation_policy_contract_version:1,policy:{...config.policy,conversation:{enabled:true}}};
 const {client,calls}=fixture(bundle as typeof config);
 await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2})),/conversation policy/);assert.equal(calls.length,1);
 await client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2,conversation_policy_version:1}));assert.equal(calls.at(-1)!.body.conversation_policy_version,1);
});

test('feature composition requires a matching complete-combination acknowledgement',async()=>{
 const bundle={...config,persona_feature_skills:[{version_id:'f1'}],persona_composition_contract_version:1,persona_composition_sha256:'a'.repeat(64)};
 const {client,calls}=fixture(bundle as typeof config);
 await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2})),/complete persona composition/);assert.equal(calls.length,1);
 await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2,persona_composition_version:1,persona_composition_sha256:'b'.repeat(64)})),/complete persona composition/);
 await client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2,persona_composition_version:1,persona_composition_sha256:bundle.persona_composition_sha256}));
 assert.equal(calls.at(-1)!.body.persona_composition_sha256,bundle.persona_composition_sha256);
});

test('per-group reply limits must be applied before the adapter acknowledges',async()=>{
 const bundle={...config,reply_limits_contract_version:1};const {client,calls}=fixture(bundle as typeof config);
 await assert.rejects(client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2})),/reply limits/);assert.equal(calls.length,1);
 await client.applyConfig('synthetic-room',async()=>({timeout_policy_version:2,reply_limits_version:1}));assert.equal(calls.at(-1)!.body.reply_limits_version,1);
});
