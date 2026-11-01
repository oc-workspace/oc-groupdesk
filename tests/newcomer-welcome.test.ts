import {test} from 'node:test';
import assert from 'node:assert/strict';
import {welcomeRuntime} from '../server/newcomer-welcome.js';
import {GroupDeskClient} from '../integration/groupdesk-client.mjs';

test('only the explicitly selected newcomer feature activates bounded scheduling',()=>{
 for(const features of [[],[{skill_name:'gt-persona'}],[{skill_name:'gt-banter'}],[{}]])assert.deepEqual(welcomeRuntime(features),{});
 const runtime=welcomeRuntime([{skill_name:'newcomer-welcome'}]);assert.equal(runtime.newcomer_welcome_contract_version,1);
 assert.deepEqual(runtime.newcomer_welcome,{min_delay_seconds:15,max_delay_seconds:40,ttl_seconds:90,coalesce_seconds:120});
});
test('a generic composition adapter cannot acknowledge welcome scheduling',async()=>{
 const calls:any[]=[];const config={id:'g',revision:1,...welcomeRuntime([{skill_name:'newcomer-welcome'}])};
 const client=new GroupDeskClient({baseUrl:'https://example.invalid',token:'synthetic',fetchImpl:(async(url:any,init:any)=>{calls.push({url,body:init.body&&JSON.parse(init.body)});return new Response(JSON.stringify(config),{headers:{'Content-Type':'application/json'}});}) as typeof fetch});
 await assert.rejects(client.applyConfig('g',async()=>({})),/welcome scheduling/);assert.equal(calls.length,1);
 await client.applyConfig('g',async()=>({newcomer_welcome_policy_version:1}));assert.equal(calls.at(-1).body.newcomer_welcome_policy_version,1);
});
