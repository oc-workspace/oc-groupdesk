import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {route as summaryRoute} from '../server/summaries/core.js';
if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',cookie='',csrf='',a='',b='',c='',group:any,other:any;
const secrets=['isolated-stage-key-alpha','isolated-stage-key-beta','isolated-stage-key-gamma'];
async function req(path:string,method='GET',body?:unknown,bot=false){
 const r=await fetch(base+'/api'+path,{method,headers:{...(bot?{Authorization:'Bearer '+process.env.BOT_API_TOKEN}:{Cookie:cookie,'X-CSRF-Token':csrf}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await migrate();await migrate();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));base='http://127.0.0.1:'+(server.address() as any).port;
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD})});cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=(await login.json()).csrf;
 const ids:string[]=[];
 for(const [i,key] of secrets.entries()){
  const result=await req('/model-credentials','POST',{name:'Stage '+i,base_url:'https://stage'+i+'.example.com/v1',api_key:key});assert.equal(result.status,201);ids.push(result.data.id);
  assert.equal((await req('/model-credentials/'+result.data.id+'/models','POST',{model_id:'model-'+i,capability:'text'})).status,201);
 }
 [a,b,c]=ids;
 const defaults=(await req('/models')).data.defaults;
 assert.equal((await req('/model-defaults','PUT',{revision:defaults.revision,routes:{text:{credential_id:a,model_id:'model-0'},image:null,stages:{planner:{credential_id:b,model_id:'model-1'},summary:{credential_id:c,model_id:'model-2'}}}})).status,200);
 const overview=(await req('/overview')).data;[group,other]=overview.groups;
 group=(await req('/groups/'+group.id,'PUT',{...group,enabled:true,external_id:'stage-room-a',model_routes:{text:{mode:'inherit'},image:{mode:'disabled'},stages:{replyer:{mode:'custom',credential_id:c,model_id:'model-2'}}}})).data;
 other=(await req('/groups/'+other.id,'PUT',{...other,enabled:true,external_id:'stage-room-b',model_routes:{text:{mode:'custom',credential_id:a,model_id:'model-0'},image:{mode:'disabled'}}})).data;
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('public contracts show stage selections and never expose keys; private routes bind the exact group and revision',async()=>{
 const config=(await req('/runtime/config/stage-room-a','GET',undefined,true)).data;
 assert.equal(config.model_stage_routing_contract_version,1);assert.equal(config.model_routing.stages.planner.model_id,'model-1');assert.equal(config.model_routing.stages.replyer.model_id,'model-2');assert.equal(config.model_routing.stages.utils.model_id,'model-0');
 for(const key of secrets){assert(!JSON.stringify(config).includes(key));assert(!JSON.stringify((await req('/overview')).data).includes(key));}
 const privateRoutes=(await req('/runtime/model-credentials','POST',{group_id:group.id,revision:group.revision,credential_id:a},true)).data;
 assert.equal(privateRoutes.stage_routes.planner.api_key,secrets[1]);assert.equal(privateRoutes.stage_routes.replyer.api_key,secrets[2]);assert.equal(privateRoutes.stage_routes.utils.api_key,secrets[0]);assert.equal(privateRoutes.stage_routes.summary,undefined);
 assert.equal((await req('/runtime/model-credentials','POST',{group_id:group.id,revision:group.revision-1},true)).status,409);
});
test('stage contract requires an upgraded adapter before acknowledging application',async()=>{
 const ack={group_id:group.id,revision:group.revision,model_routing_version:1,timeout_policy_version:3,reply_limits_version:1,reply_frequency_version:1,reply_frequency_revision:1};
 const old=await req('/runtime/ack','POST',ack,true);assert.equal(old.status,409);assert.match(old.data.error,/分阶段/);
 assert.equal((await req('/runtime/ack','POST',{...ack,model_stage_routing_version:1},true)).status,200);
});
test('group summary inherits the summary stage and explicit summary configuration wins',async()=>{
 const inherited=await summaryRoute(group,{model_route:{mode:'inherit'}});assert.equal(inherited.model_id,'model-2');
 const explicit=await summaryRoute(group,{model_route:{mode:'custom',credential_id:a,model_id:'model-0'}});assert.equal(explicit.model_id,'model-0');
});
test('old group and default editors cannot erase stage settings they did not send',async()=>{
 const routes={...group.model_routes};delete routes.stages;
 const saved=await req('/groups/'+group.id,'PUT',{...group,model_routes:routes});assert.equal(saved.status,200);group=saved.data;assert.equal(group.model_routes.stages.replyer.credential_id,c);
 const defaults=(await req('/models')).data.defaults;const body={...defaults.routes};delete body.stages;
 assert.equal((await req('/model-defaults','PUT',{revision:defaults.revision,routes:body})).status,200);
 assert.equal((await req('/models')).data.defaults.routes.stages.planner.credential_id,b);
});
test('rotating a stage-only key invalidates affected group revisions without exposing the new key',async()=>{
 const before=(await req('/overview')).data.groups;
 const credential=(await req('/models')).data.credentials.find((v:any)=>v.id===c);
 assert.equal((await req('/model-credentials/'+c,'PUT',{...credential,api_key:'isolated-stage-rotated-key'})).status,200);
 const after=(await req('/overview')).data.groups;
 // Both groups inherit the global summary stage bound to this credential.
 for(const g of before)assert.equal(after.find((v:any)=>v.id===g.id).revision,g.revision+1);
 group=after.find((v:any)=>v.id===group.id);
 const response=(await req('/runtime/model-credentials','POST',{group_id:group.id,revision:group.revision},true)).data;
 assert.equal(response.stage_routes.replyer.api_key,'isolated-stage-rotated-key');assert(!JSON.stringify((await req('/logs')).data).includes('isolated-stage-rotated-key'));
});
test('invalid stage selections and image-generation models are rejected atomically',async()=>{
 const before=group.revision;
 const invalid=await req('/groups/'+group.id,'PUT',{...group,model_routes:{...group.model_routes,stages:{replyer:{mode:'custom',credential_id:b,model_id:'not-registered'}}}});assert.equal(invalid.status,400);
 assert.equal((await req('/overview')).data.groups.find((v:any)=>v.id===group.id).revision,before);
 assert.equal((await req('/model-credentials/'+b+'/models','POST',{model_id:'image-only',capability:'image'})).status,201);
 assert.equal((await req('/groups/'+group.id,'PUT',{...group,model_routes:{...group.model_routes,stages:{replyer:{mode:'custom',credential_id:b,model_id:'image-only'}}}})).status,400);
});
