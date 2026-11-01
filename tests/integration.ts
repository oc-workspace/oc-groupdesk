import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {migrate} from '../server/migrate.js';
import {pool} from '../server/db.js';
import {createApp} from '../server/app.js';
import {processNext} from '../server/worker.js';

if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw new Error('Integration tests require a dedicated groupdesk_test database');
let server:Server,base='',cookie='',csrf='',groupA:any,groupB:any,topicA:any,kbA='',kbB='';
async function request(path:string,method='GET',body?:unknown,runtime=false,csrfOverride?:string){
  const response=await fetch(base+'/api'+path,{
    method,headers:{...(runtime?{Authorization:'Bearer '+process.env.BOT_API_TOKEN}:{Cookie:cookie,'X-CSRF-Token':csrfOverride??csrf}),...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined
  });
  const data=await response.json();
  return {status:response.status,data,response};
}
before(async()=>{
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();await migrate();
  server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'0.0.0.0',r));
  const address=server.address() as {port:number};base='http://127.0.0.1:'+address.port;
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('authentication, CSRF and source validation prevent unauthorized administration',async()=>{
  assert.equal((await request('/overview')).status,401);
  assert.equal((await request('/groups/status')).status,401);
  assert.equal((await request('/models')).status,401);
  assert.equal((await request('/model-credentials','POST',{})).status,401);
  assert.equal((await request('/auth/login','POST',{username:'admin',password:'wrong-password'})).status,401);
  const login=await request('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});
  assert.equal(login.status,200);cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
  assert.equal((await request('/groups','POST',{name:'denied'},false,'wrong')).status,403);
  const foreign=await fetch(base+'/api/groups',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',Origin:'https://untrusted.invalid'},body:JSON.stringify({name:'denied'})});
  assert.equal(foreign.status,403);
  const {data}=await request('/overview');assert.equal(data.groups.length,2);
  groupA=data.groups.find((g:any)=>g.name==='ssh外语学习园地');groupB=data.groups.find((g:any)=>g.id!==groupA.id);
  topicA=data.topics.find((t:any)=>t.name==='外语交流');assert(!groupA.enabled);
});
test('groups require stable bindings and reject stale configuration writes',async()=>{
  assert.equal((await request('/groups/'+groupA.id,'PUT',{...groupA,enabled:true})).status,400);
  groupA=(await request('/groups/'+groupA.id,'PUT',{...groupA,enabled:true,external_id:'trusted-room-A'})).data;
  groupB=(await request('/groups/'+groupB.id,'PUT',{...groupB,enabled:true,external_id:'trusted-room-B'})).data;
  const stale={...groupA,revision:groupA.revision-1};
  assert.equal((await request('/groups/'+groupA.id,'PUT',stale)).status,409);
});
test('knowledge worker indexes text and handles upload formats and failures',async()=>{
  kbA=(await request('/knowledge','POST',{name:'A private knowledge',description:''})).data.id;
  kbB=(await request('/knowledge','POST',{name:'B private knowledge',description:''})).data.id;
  const a=await request('/knowledge/'+kbA+'/text','POST',{title:'外语活动安排',content:'口语活动周六下午三点，地点外语园地。secret-A'});
  await request('/knowledge/'+kbB+'/text','POST',{title:'创业活动安排',content:'创业活动周日下午五点。secret-B'});
  assert.equal(a.status,201);while(await processNext()){}
  const result=await request('/knowledge/'+kbA+'/search','POST',{query:'活动'});
  assert.equal(result.data.results.length,1);assert(result.data.results[0].content.includes('secret-A'));
  assert(!JSON.stringify(result.data).includes('secret-B'));
  const form=new FormData();form.append('file',new Blob(['活动新增文字资料']), 'notes.txt');
  const uploaded=await fetch(base+'/api/knowledge/'+kbA+'/upload',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf},body:form});
  assert.equal(uploaded.status,201);while(await processNext()){}
  const bad=new FormData();bad.append('file',new Blob(['not a pdf']), 'fake.pdf');
  assert.equal((await fetch(base+'/api/knowledge/'+kbA+'/upload',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf},body:bad})).status,400);
  const invalid=new FormData();invalid.append('file',new Blob([new Uint8Array([255,255,255])]),'invalid.txt');
  const invalidDoc=await (await fetch(base+'/api/knowledge/'+kbA+'/upload',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf},body:invalid})).json();
  while(await processNext()){}
  const docs=(await request('/knowledge/'+kbA+'/documents')).data;
  assert.equal(docs.find((d:any)=>d.id===invalidDoc.id).status,'failed');
});
test('valid PDF uploads are parsed and indexed by the isolated worker',async()=>{
  const stream='BT /F1 12 Tf 50 750 Td (GroupDesk PDF knowledge test) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n';
  for(const offset of offsets.slice(1))pdf+=String(offset).padStart(10,'0')+' 00000 n \n';
  pdf+='trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  const form=new FormData();form.append('file',new Blob([pdf],{type:'application/pdf'}),'knowledge-test.pdf');
  const response=await fetch(base+'/api/knowledge/'+kbA+'/upload',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf},body:form});
  assert.equal(response.status,201);const doc=await response.json();while(await processNext()){}
  const docs=(await request('/knowledge/'+kbA+'/documents')).data;assert.equal(docs.find((d:any)=>d.id===doc.id).status,'ready');
  const found=(await request('/knowledge/'+kbA+'/search','POST',{query:'GroupDesk PDF'})).data.results;
  assert(found.some((r:any)=>r.content.includes('GroupDesk PDF knowledge test')));
});
test('DM scenes require verified membership and never leak another group knowledge',async()=>{
  groupA=(await request('/groups/'+groupA.id,'PUT',{...groupA,kb_ids:[kbA]})).data;
  groupB=(await request('/groups/'+groupB.id,'PUT',{...groupB,kb_ids:[kbB]})).data;
  assert.equal((await request('/runtime/select-scene','POST',{user_id:'stable-user-1',group_id:groupA.id},true)).status,403);
  assert.equal((await request('/memberships','POST',{group_id:groupA.id,user_id:'ui-nickname-hash',display_name:'bad',evidence:'昵称不是身份验证依据'})).status,400);
  assert.equal((await request('/memberships','POST',{group_id:groupA.id,user_id:'stable-user-1',display_name:'核验测试成员',evidence:'通过可信群成员目录及私聊身份交叉核验'})).status,201);
  const scenes=await request('/runtime/scenes?user_id=stable-user-1','GET',undefined,true);
  assert.deepEqual(scenes.data.scenes.map((g:any)=>g.id),[groupA.id]);
  assert.equal((await request('/runtime/select-scene','POST',{user_id:'stable-user-1',group_id:groupB.id},true)).status,403);
  assert.equal((await request('/runtime/select-scene','POST',{user_id:'stable-user-1',group_id:groupA.id},true)).status,200);
  const context=await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm',query:'活动'},true);
  assert.equal(context.status,200);assert.equal(context.data.language,'en');
  assert(context.data.sources.length);assert(!JSON.stringify(context.data).includes('secret-B'));
  const spoof=await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm',group_external_id:'trusted-room-B',query:'活动'},true);
  assert.equal(spoof.data.group.id,groupA.id);
  const disabledTopic=(await request('/overview')).data.topics.find((t:any)=>!groupA.topic_ids.includes(t.id));
  assert.equal((await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm',topic_id:disabledTopic.id},true)).status,403);
});
test('scene switching isolates conversation scope and membership revocation is immediate',async()=>{
  const first=(await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm'},true)).data;
  await request('/memberships','POST',{group_id:groupB.id,user_id:'stable-user-1',display_name:'核验测试成员',evidence:'通过第二群的可信成员目录独立核验'});
  await request('/runtime/select-scene','POST',{user_id:'stable-user-1',group_id:groupB.id},true);
  const second=(await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm',query:'活动'},true)).data;
  assert.notEqual(first.conversation_scope,second.conversation_scope);
  assert(!JSON.stringify(second).includes('secret-A'));assert(JSON.stringify(second).includes('secret-B'));
  const members=(await request('/memberships')).data;
  const m=members.find((m:any)=>m.group_id===groupB.id);
  await request('/memberships/'+m.id,'DELETE');
  assert.equal((await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm'},true)).status,403);
  await request('/runtime/select-scene','POST',{user_id:'stable-user-1',group_id:groupA.id},true);
  await pool.query("UPDATE dm_scenes SET expires_at=now()-interval '1 second'");
  assert.equal((await request('/runtime/context','POST',{user_id:'stable-user-1',channel:'dm'},true)).status,403);
});
test('language overrides, group mention rules and revision acknowledgements are enforced',async()=>{
  const ctx={user_id:'trusted-sender',channel:'group',group_external_id:'trusted-room-A',language:'ja'};
  assert.equal((await request('/runtime/context','POST',ctx,true)).status,403);
  assert.equal((await request('/runtime/context','POST',{...ctx,mentioned:true},true)).data.language,'ja');
  groupA=(await request('/groups/'+groupA.id,'PUT',{...groupA,allow_language_override:false})).data;
  assert.equal((await request('/runtime/context','POST',{...ctx,mentioned:true},true)).data.language,'en');
  assert.equal((await request('/runtime/ack','POST',{group_id:groupA.id,revision:groupA.revision-1},true)).status,409);
  assert.equal((await request('/runtime/ack','POST',{group_id:groupA.id,revision:groupA.revision},true)).status,200);
  const anonymous=await fetch(base+'/api/runtime/config/trusted-room-A');assert.equal(anonymous.status,401);
  groupA=(await request('/groups/'+groupA.id,'PUT',{...groupA,enabled:false})).data;
  assert.equal((await request('/runtime/context','POST',{...ctx,mentioned:true},true)).status,403);
});
test('topic updates bump linked configuration versions and used topics cannot be deleted',async()=>{
  const old=(await request('/overview')).data.groups.find((g:any)=>g.id===groupA.id);
  assert.equal((await request('/topics/'+topicA.id,'PUT',{...topicA,instructions:'更新后的规则'})).status,200);
  const fresh=(await request('/overview')).data.groups.find((g:any)=>g.id===groupA.id);
  assert.equal(fresh.revision,old.revision+1);
  assert.equal((await request('/topics/'+topicA.id,'DELETE')).status,409);
});
test('editable topic policy, dry-run, template preservation and multi-language group policy',async()=>{
  const overview=(await request('/overview')).data;
  const food=overview.topics.find((t:any)=>t.catalog_key==='china-food');assert(food.policy.combinations.length);
  const edit={...food,policy:{...food.policy,lexicons:{...food.policy.lexicons,en:[...food.policy.lexicons.en,'synthetic culinary example']}}};
  const updated=await request('/topics/'+food.id,'PUT',edit);assert.equal(updated.status,200);
  assert.equal((await request('/topics/'+food.id,'PUT',edit)).status,409);
  const preview=await request('/topics/'+food.id+'/test','POST',{messages:['Canto fare is delicious.','But it must be good since lots of people are waiting','The bus fare is expensive.']});
  assert.equal(preview.status,200);assert.equal(preview.data.sends,0);assert.equal(preview.data.model_calls,0);
  assert.deepEqual(preview.data.results.map((x:any)=>x.reason),['explicit','context','none']);
  await migrate();const retained=(await request('/overview')).data.topics.find((t:any)=>t.id===food.id);assert(retained.policy.lexicons.en.includes('synthetic culinary example'));
  assert.equal((await request('/catalog/import','POST',{keys:['china-food'],replace:false})).status,200);
  assert((await request('/overview')).data.topics.find((t:any)=>t.id===food.id).policy.lexicons.en.includes('synthetic culinary example'));
  assert.equal((await request('/catalog/import','POST',{keys:['china-food'],replace:true,expected:{'china-food':food.revision}})).status,409);
  let group=(await request('/groups','POST',{name:'Synthetic policy group'})).data;
  group=(await request('/groups/'+group.id,'PUT',{...group,enabled:true,external_id:'synthetic-policy-room',topic_ids:[food.id],interaction:'topic',policy:{...group.policy,topic_scope:'proactive',language:{mode:'restricted',allowed:['zh-CN','en'],fallback:'en',allow_requested:true}}})).data;
  const context={user_id:'ui-local-sender',channel:'group',group_external_id:'synthetic-policy-room',language:'ja',mentioned:true};
  const output=await request('/runtime/context','POST',context,true);assert.equal(output.status,200);assert.equal(output.data.language,'en');
  assert.equal((await request('/runtime/context','POST',{...context,topic_id:topicA.id},true)).status,200);
  assert.equal((await request('/runtime/context','POST',{...context,mentioned:false,topic_id:topicA.id},true)).status,403);
  const config=await request('/runtime/config/synthetic-policy-room','GET',undefined,true);assert.equal(config.data.topics.length,1);assert(config.data.participation_skill.includes('group-participation'));
  assert(!JSON.stringify(config.data).includes('secret-A'));
  const bad={...group,policy:{...group.policy,language:{mode:'restricted',allowed:['en'],fallback:'ja',allow_requested:true}}};
  assert.equal((await request('/groups/'+group.id,'PUT',bad)).status,400);
});
test('identity policy persists per group, reaches runtime and cannot be overridden by chat',async()=>{
  const before=(await request('/overview')).data;
  let selected=before.groups.find((g:any)=>g.external_id==='synthetic-policy-room');
  const other=before.groups.find((g:any)=>g.id!==selected.id);
  assert.deepEqual(selected.policy.identity,{disclosure:'when_asked',personal_questions:'tactful'});
  selected=(await request('/groups/'+selected.id,'PUT',{...selected,policy:{...selected.policy,identity:{disclosure:'proactive',personal_questions:'plain'}}})).data;
  assert.equal(selected.policy.identity.disclosure,'proactive');
  const config=(await request('/runtime/config/synthetic-policy-room','GET',undefined,true)).data;
  assert(config.identity_instructions.some((s:string)=>s.includes('首次交流')));
  assert(!config.identity_instructions.some((s:string)=>s.includes('合成语气示例')));
  const out=(await request('/runtime/context','POST',{user_id:'synthetic-user',channel:'group',group_external_id:'synthetic-policy-room',mentioned:true,query:'Are you an AI?',identity:{disclosure:'never'}},true)).data;
  assert.equal(out.policy.identity.disclosure,'proactive');assert(out.policy_instructions.some((s:string)=>s.includes('简短如实回答')));
  assert.equal((await request('/groups/'+selected.id,'PUT',{...selected,policy:{...selected.policy,identity:{disclosure:'never',personal_questions:'tactful'}}})).status,400);
  assert.equal((await request('/overview')).data.groups.find((g:any)=>g.id===selected.id).revision,selected.revision);
  await migrate();
  const after=(await request('/overview')).data;
  assert.deepEqual(after.groups.find((g:any)=>g.id===selected.id).policy.identity,{disclosure:'proactive',personal_questions:'plain'});
  assert.deepEqual(after.groups.find((g:any)=>g.id===other.id).policy.identity,other.policy.identity);
});
test('informed roleplay survives save and reaches runtime without overriding another group',async()=>{
  const before=(await request('/overview')).data;
  let selected=before.groups.find((g:any)=>g.external_id==='synthetic-policy-room');
  const other=before.groups.find((g:any)=>g.id!==selected.id);
  selected=(await request('/groups/'+selected.id,'PUT',{...selected,policy:{...selected.policy,identity:{disclosure:'roleplay',personal_questions:'plain'}}})).data;
  assert.equal(selected.policy.identity.disclosure,'roleplay');
  const config=(await request('/runtime/config/synthetic-policy-room','GET',undefined,true)).data;
  assert(config.identity_instructions.some((s:string)=>s.includes('所有参与者知道')));
  assert(config.identity_instructions.some((s:string)=>s.includes('OOC')&&s.includes('如实说明')));
  const output=(await request('/runtime/context','POST',{user_id:'synthetic-user',channel:'group',group_external_id:'synthetic-policy-room',mentioned:true,query:'Who are you?'},true)).data;
  assert.equal(output.policy.identity.disclosure,'roleplay');assert(output.policy_instructions.some((s:string)=>s.includes('角色内持续')));
  assert(!output.policy_instructions.some((s:string)=>s.startsWith('身份底线：')));
  await migrate();
  const after=(await request('/overview')).data;
  assert.equal(after.groups.find((g:any)=>g.id===selected.id).policy.identity.disclosure,'roleplay');
  assert.deepEqual(after.groups.find((g:any)=>g.id===other.id).policy.identity,other.policy.identity);
});
test('scoped adapter tokens cannot access other groups or DM scenes',async()=>{
  const {digest}=await import('../server/security.js');
  const scoped='scoped_adapter_test_token_000000000000';
  await pool.query('INSERT INTO runtime_adapters VALUES($1,$2,$3,now())',[digest(scoped),'synthetic adapter',JSON.stringify(['synthetic-policy-room'])]);
  async function scopedGet(path:string){return fetch(base+'/api/runtime'+path,{headers:{Authorization:'Bearer '+scoped}});}
  assert.equal((await scopedGet('/config/synthetic-policy-room')).status,200);
  assert.equal((await scopedGet('/config/trusted-room-A')).status,403);
  assert.equal((await scopedGet('/scenes?user_id=stable-user-1')).status,403);
  await pool.query('DELETE FROM runtime_adapters WHERE token_hash=$1',[digest(scoped)]);
  assert.equal((await scopedGet('/config/synthetic-policy-room')).status,401);
});
test('status endpoint reports save-to-ack transitions without exposing or changing configuration',async()=>{
  const before=(await request('/overview')).data;
  let selected=before.groups.find((g:any)=>g.external_id==='synthetic-policy-room');
  const others=before.groups.filter((g:any)=>g.id!==selected.id);
  selected=(await request('/groups/'+selected.id,'PUT',{...selected,name:'Synthetic confirmation test'})).data;
  const pending=await request('/groups/status');
  assert.equal(pending.status,200);assert.equal(pending.response.headers.get('cache-control'),'no-store');
  const pendingRow=pending.data.find((g:any)=>g.id===selected.id);
  assert.deepEqual(Object.keys(pendingRow).sort(),['applied_revision','bot_seen_at','enabled','id','revision','runtime_health','runtime_health_at']);
  assert.equal(pendingRow.revision,selected.revision);assert(pendingRow.applied_revision<selected.revision);
  assert.equal((await request('/runtime/ack','POST',{group_id:selected.id,revision:selected.revision-1},true)).status,409);
  assert.deepEqual((await request('/groups/status')).data.find((g:any)=>g.id===selected.id),pendingRow);
  assert.equal((await request('/runtime/ack','POST',{group_id:selected.id,revision:selected.revision},true)).status,200);
  const confirmed=(await request('/groups/status')).data.find((g:any)=>g.id===selected.id);
  assert.equal(confirmed.revision,selected.revision);assert.equal(confirmed.applied_revision,selected.revision);
  assert(Number.isFinite(Date.parse(confirmed.bot_seen_at)));
  const after=(await request('/overview')).data;
  assert.deepEqual(after.groups.find((g:any)=>g.id===selected.id).policy,selected.policy);
  assert.deepEqual(after.groups.filter((g:any)=>g.id!==selected.id),others);
});
test('existing credential import is atomic and repeatable without overriding a later model choice',async()=>{
  const {importExistingCredential}=await import('../server/models.js');
  const input={name:'Existing isolated key',base_url:'https://api.example.com/v1',api_key:'existing-isolated-key-not-production',model_id:'existing-text-model'};
  const id=await importExistingCredential(input),first=(await request('/overview')).data;
  assert.equal(first.model_config.defaults.routes.text.credential_id,id);
  assert.equal(await importExistingCredential(input),id);
  const second=(await request('/overview')).data;
  assert.deepEqual(second.model_config.defaults,first.model_config.defaults);
  assert.deepEqual(second.groups,first.groups);
  await assert.rejects(importExistingCredential({...input,name:'Different existing key',api_key:'different-isolated-key',model_id:'other-model'}));
  assert.deepEqual((await request('/overview')).data.model_config,second.model_config);
});

test('model credentials stay write-only while text/image routes isolate groups and rotate safely',async()=>{
  const secretA='isolated-model-credential-A-only',secretB='isolated-model-credential-B-only';
  const makeKey=async(name:string,api_key:string)=>(await request('/model-credentials','POST',{name,base_url:'https://api.example.com/v1',api_key})).data.id;
  const a=await makeKey('Test Key A',secretA),b=await makeKey('Test Key B',secretB);assert(a&&b);
  for(const [id,model_id,capability] of [[a,'text-a','text'],[a,'image-a','image'],[b,'text-b','text']])assert.equal((await request('/model-credentials/'+id+'/models','POST',{model_id,capability})).status,201);
  const publicModels=(await request('/models')).data;
  assert(!JSON.stringify(publicModels).includes(secretA));assert(!JSON.stringify(publicModels).includes('key_ciphertext'));
  assert.equal((await request('/runtime/model-credentials','POST',{group_id:groupA.id,revision:groupA.revision})).status,401);
  const stored=(await pool.query('SELECT key_ciphertext FROM model_credentials WHERE id=$1',[a])).rows[0];assert(!stored.key_ciphertext.includes(secretA));
  assert.equal((await request('/model-defaults','PUT',{revision:publicModels.defaults.revision,routes:{text:{credential_id:a,model_id:'image-a'},image:null}})).status,400);
  assert.equal((await request('/model-defaults','PUT',{revision:publicModels.defaults.revision,routes:{text:{credential_id:a,model_id:'text-a'},image:null}})).status,200);
  let x=(await request('/groups','POST',{name:'Synthetic routed A'})).data;
  let y=(await request('/groups','POST',{name:'Synthetic routed B'})).data;
  x=(await request('/groups/'+x.id,'PUT',{...x,enabled:true,external_id:'synthetic-route-a',topic_ids:[topicA.id],model_routes:{text:{mode:'custom',credential_id:b,model_id:'text-b'},image:{mode:'custom',credential_id:a,model_id:'image-a'}}})).data;
  y=(await request('/groups/'+y.id,'PUT',{...y,enabled:true,external_id:'synthetic-route-b',topic_ids:[topicA.id]})).data;
  const configX=(await request('/runtime/config/synthetic-route-a','GET',undefined,true)).data;
  const configY=(await request('/runtime/config/synthetic-route-b','GET',undefined,true)).data;
  assert.equal(configX.model_routing.text.model_id,'text-b');assert.equal(configX.model_routing.image.model_id,'image-a');
  assert.equal(configY.model_routing.text.model_id,'text-a');assert.equal(configY.model_routing.text.source,'default');
  assert(!JSON.stringify(configX).includes(secretB));assert(!JSON.stringify((await request('/overview')).data).includes(secretA));
  assert.equal((await request('/runtime/ack','POST',{group_id:x.id,revision:x.revision},true)).status,409);
  assert.equal((await request('/runtime/ack','POST',{group_id:x.id,revision:x.revision,model_routing_version:1},true)).status,200);
  assert.equal((await request('/runtime/model-credentials','POST',{group_id:x.id,revision:x.revision-1},true)).status,409);
  const privateX=(await request('/runtime/model-credentials','POST',{group_id:x.id,revision:x.revision,credential_id:a},true)).data;
  assert.equal(privateX.text_route.api_key,secretB);assert.equal(privateX.text_route.model_id,'text-b');
  assert.equal((await request('/runtime/model-credentials','POST',{group_id:y.id,revision:y.revision},true)).data.text_route.api_key,secretA);
  const {digest}=await import('../server/security.js');const scoped='isolated_model_scope_adapter_0000000000000';
  await pool.query('INSERT INTO runtime_adapters VALUES($1,$2,$3,now())',[digest(scoped),'model scope test',JSON.stringify(['synthetic-route-a'])]);
  const response=await fetch(base+'/api/runtime/model-credentials',{method:'POST',headers:{Authorization:'Bearer '+scoped,'Content-Type':'application/json'},body:JSON.stringify({group_id:y.id,revision:y.revision})});assert.equal(response.status,403);
  await pool.query('DELETE FROM runtime_adapters WHERE token_hash=$1',[digest(scoped)]);
  const keyB=(await request('/models')).data.credentials.find((c:any)=>c.id===b);
  const edited={...keyB,enabled:false};
  assert.equal((await request('/model-credentials/'+b,'PUT',edited)).status,200);
  assert.equal((await request('/model-credentials/'+b,'PUT',edited)).status,409);
  const after=(await request('/overview')).data;
  const updatedX=after.groups.find((g:any)=>g.id===x.id),updatedY=after.groups.find((g:any)=>g.id===y.id);
  assert.equal(updatedX.revision,x.revision+1);assert.equal(updatedY.revision,y.revision);
  assert.equal((await request('/runtime/model-credentials','POST',{group_id:x.id,revision:updatedX.revision},true)).status,409);
  assert.equal((await request('/runtime/model-credentials','POST',{group_id:y.id,revision:y.revision},true)).status,200);
  const {refreshCatalog}=await import('../server/models.js');
  const result=await refreshCatalog(a,'test',async()=>({data:[{id:'catalog-text'},{id:'flux-image'},{id:'example-video'}]}));assert.equal(result.count,3);
  const catalogue=(await request('/models')).data.credentials.find((c:any)=>c.id===a);
  assert(catalogue.models.some((m:any)=>m.model_id==='text-a'&&!m.listed));
  await assert.rejects(refreshCatalog(a,'test',async()=>{throw new Error('upstream included '+secretA);}));
  const failed=(await request('/models')).data.credentials.find((c:any)=>c.id===a);
  assert.equal(failed.models.length,catalogue.models.length);assert(!failed.catalog_error.includes(secretA));
  await migrate();assert.deepEqual((await request('/overview')).data.groups.find((g:any)=>g.id===x.id).model_routes,updatedX.model_routes);
  assert(!JSON.stringify((await request('/logs')).data).includes(secretA));assert(!JSON.stringify((await request('/logs')).data).includes(secretB));
});

test('provider batch imports protocols and reference models atomically while preserving existing defaults',async()=>{
  const {importProviderBatch}=await import('../server/provider-import.js');
  const {refreshCatalog}=await import('../server/models.js');
  const before=(await request('/models')).data,original=before.credentials.find((c:any)=>c.id===before.defaults.routes.text.credential_id);
  const ciphertext=(await pool.query('SELECT key_ciphertext FROM model_credentials WHERE id=$1',[original.id])).rows[0].key_ciphertext;
  const input={rename:{id:original.id,revision:original.revision,name:'Renamed existing provider'},credentials:[
    {name:'Gemini image fixture',base_url:'https://api.example.com',client_type:'gemini',api_key:'isolated-gemini-image-secret',configured_model:'gemini-2.0-flash'},
    {name:'Responses fixture',base_url:'https://api.example.com/v1',client_type:'openai_responses',api_key:'isolated-responses-secret',configured_model:'gpt-5.5'},
    {name:'Gemini text fixture',base_url:'https://api.example.com',client_type:'gemini',api_key:'isolated-gemini-text-secret',configured_model:'gemini-2.0-flash'}
  ]};
  const added=await importProviderBatch(input);assert.equal(added.length,3);
  const after=(await request('/models')).data;
  assert.equal(after.credentials.length,before.credentials.length+3);assert.deepEqual(after.defaults,before.defaults);
  assert.equal(after.credentials.find((c:any)=>c.id===original.id).name,'Renamed existing provider');
  assert.equal((await pool.query('SELECT key_ciphertext FROM model_credentials WHERE id=$1',[original.id])).rows[0].key_ciphertext,ciphertext);
  assert.deepEqual(await importProviderBatch(input),added);
  for(const item of added){
    const row=after.credentials.find((c:any)=>c.id===item.id);let observed='';
    await refreshCatalog(item.id,'test',async(_url,_key,protocol)=>{observed=protocol||'';return protocol==='gemini'?{models:[{name:'models/gemini-nano-banana-2.1'},{name:'models/gemini-3.8-flash'}]}:{data:[{id:'gpt-image-2',type:'image'}]};});
    assert.equal(observed,row.client_type);
  }
  const gemini=(await request('/models')).data.credentials.find((c:any)=>c.id===added[0].id);
  assert(gemini.models.some((m:any)=>m.model_id==='gemini-2.0-flash'&&m.source==='configured'&&!m.listed));
  assert.equal((await request('/model-credentials/'+gemini.id,'PUT',{...gemini,client_type:undefined})).status,200);
  assert.equal((await request('/models')).data.credentials.find((c:any)=>c.id===gemini.id).client_type,'gemini');
  let group=(await request('/overview')).data.groups.find((g:any)=>g.external_id==='synthetic-route-a');
  group=(await request('/groups/'+group.id,'PUT',{...group,model_routes:{...group.model_routes,text:{mode:'custom',credential_id:gemini.id,model_id:'gemini-2.0-flash'}}})).data;
  assert.equal((await request('/runtime/config/synthetic-route-a','GET',undefined,true)).data.model_routing.text.client_type,'gemini');
  const privateRoute=(await request('/runtime/model-credentials','POST',{group_id:group.id,revision:group.revision},true)).data.text_route;
  assert.equal(privateRoute.client_type,'gemini');assert.equal(privateRoute.base_url,'https://api.example.com');assert.equal(privateRoute.api_key,input.credentials[0].api_key);
  const publicData=JSON.stringify((await request('/overview')).data),logs=JSON.stringify((await request('/logs')).data);
  for(const c of input.credentials){assert(!publicData.includes(c.api_key));assert(!logs.includes(c.api_key));}
});
test('a conflicting provider batch rolls back its rename and never overwrites an existing key',async()=>{
  const {importProviderBatch}=await import('../server/provider-import.js');
  const before=(await request('/models')).data,original=before.credentials.find((c:any)=>c.name==='Renamed existing provider'),existing=before.credentials.find((c:any)=>c.name==='Gemini image fixture');
  await assert.rejects(importProviderBatch({rename:{id:original.id,revision:original.revision,name:'Must roll back'},credentials:[{name:existing.name,base_url:existing.base_url,client_type:'gemini',api_key:'different-isolated-secret'}]}));
  assert.deepEqual((await request('/models')).data,before);
});

const personaFixture:any={};
async function uploadPersona(collection:string,records:unknown,name='history.jsonl'){
 const form=new FormData();form.append('file',new Blob([typeof records==='string'?records:JSON.stringify(records)]),name);
 const response=await fetch(base+'/api/persona-collections/'+collection+'/import',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf},body:form});return {status:response.status,data:await response.json()};
}
test('persona archives authenticate, preserve source identity and incrementally update exact senders',async()=>{
 assert.equal((await fetch(base+'/api/persona-studio')).status,401);
 assert.equal((await request('/persona-collections','POST',{},false,'wrong')).status,403);
 const group=(await request('/overview')).data.groups.find((g:any)=>g.external_id==='synthetic-route-a');personaFixture.group=group;
 const collection=(await request('/persona-collections','POST',{name:'Source archive A',group_id:group.id})).data.id;personaFixture.collection=collection;
 const row={id:'shard:1',group_id:group.external_id,sender_id:'exact-speaker',sender_display_name:'Same display',timestamp:1700000000,authored_text:'private-authored-A',message_type:'text'};
 const records=[row,{...row,id:'shard:2',authored_text:'same speech'},{...row,id:'shard:3',sender_id:'different-speaker',authored_text:'quote-is-not-authorship',quoted_context:{speaker_id:'exact-speaker',text:'private-authored-A'}}];
 let imported=await uploadPersona(collection,records.map(r=>JSON.stringify(r)).join('\n'));assert.equal(imported.status,200);assert.equal(imported.data.added,3);assert.equal((await request('/persona-studio')).data.collections.find((c:any)=>c.id===collection).source_group_id,group.external_id);
 const next=[{...row,authored_text:'private-authored-A revised'},records[1],records[2],{...row,id:'shard:4',authored_text:'same speech'}].map(r=>JSON.stringify(r)).join('\n');
 imported=await uploadPersona(collection,next);assert.equal(imported.data.added,1);assert.equal(imported.data.updated,1);assert.equal(imported.data.unchanged,2);
 assert.equal((await uploadPersona(collection,next)).data.reused,true);
 const invalid=await uploadPersona(collection,[row,{...row,id:'shard:new',group_id:'foreign-room'}].map(r=>JSON.stringify(r)).join('\n'));assert.equal(invalid.status,400);
 const overview=(await request('/persona-studio')).data;assert.equal(overview.collections.find((c:any)=>c.id===collection).message_count,4);assert(!JSON.stringify(overview).includes('private-authored-A'));
 const dataset=(await request('/persona-datasets','POST',{name:'Exact speaker only',collection_id:collection,sender_ids:['exact-speaker'],since:null,until_time:null})).data.id;personaFixture.dataset=dataset;
 const result=await fetch(base+'/api/persona-datasets/'+dataset+'/export',{headers:{Cookie:cookie}});const rows=(await result.text()).trim().split('\n').map(r=>JSON.parse(r));assert.equal(rows.length,3);assert(rows.every(r=>r.sender_id==='exact-speaker'&&r.group_id===group.external_id));assert(!JSON.stringify(rows).includes('quote-is-not-authorship'));
 const docCollection=(await request('/persona-collections','POST',{name:'General reference files',group_id:null})).data.id;
 assert.equal((await uploadPersona(docCollection,'Reference body','notes.md')).data.added,1);
 assert.equal((await uploadPersona(docCollection,'Revised reference body','notes.md')).data.updated,1);
 assert.equal((await uploadPersona(docCollection,JSON.stringify(row))).status,400);
});
test('personas publish immutable versions and groups pin independent skills with verified acknowledgements',async()=>{
 const {makeSkill}=await import('../server/persona-generation.js');
 const persona=(await request('/personas','POST',{name:'Voice A',skill_name:'voice-a',description:'Independent voice A',goal:'Concise natural replies',dataset_ids:[personaFixture.dataset]})).data.id;personaFixture.persona=persona;
 let p=(await request('/personas/'+persona)).data;
 const skill=makeSkill('voice-a','Independent voice A','A concise natural style with a specific voice and source-grounded claims; do not invent experiences or copy quotations as speaker words.');
 assert.equal((await request('/personas/'+persona,'PUT',{...p,draft_skill:skill})).status,200);
 assert.equal((await request('/personas/'+persona,'PUT',{...p,draft_skill:skill+'stale'})).status,409);
 p=(await request('/personas/'+persona)).data;const v1=(await request('/personas/'+persona+'/publish','POST',{revision:p.revision})).data;personaFixture.version=v1.id;
 const group=(await request('/overview')).data.groups.find((g:any)=>g.id===personaFixture.group.id);
 assert.equal((await request('/persona-bindings/'+group.id,'PUT',{revision:group.revision,version_id:v1.id})).status,200);
 const a=(await request('/runtime/config/'+group.external_id,'GET',undefined,true)).data;assert.equal(a.persona_skill.skill_md,skill);assert.equal(a.persona_skill.version_id,v1.id);assert.equal(a.persona_binding.name,'Voice A');assert(!JSON.stringify(a).includes('private-authored-A'));
 const other=(await request('/overview')).data.groups.find((g:any)=>g.id!==group.id);
 assert.equal((await request('/runtime/config/'+other.external_id,'GET',undefined,true)).data.persona_skill,null);
 assert.equal((await request('/runtime/ack','POST',{group_id:a.id,revision:a.revision,model_routing_version:1},true)).status,409);
 assert.equal((await request('/runtime/ack','POST',{group_id:a.id,revision:a.revision,model_routing_version:1,persona_skill_version:1,persona_skill_sha256:'0'.repeat(64)},true)).status,409);
 assert.equal((await request('/runtime/ack','POST',{group_id:a.id,revision:a.revision,model_routing_version:1,persona_skill_version:1,persona_skill_sha256:a.persona_skill.sha256},true)).status,200);
 p=(await request('/personas/'+persona)).data;await request('/personas/'+persona,'PUT',{...p,draft_skill:skill+'\nNew manually edited rule.'});
 assert.equal((await request('/runtime/config/'+group.external_id,'GET',undefined,true)).data.persona_skill.skill_md,skill);
 p=(await request('/personas/'+persona)).data;const v2=(await request('/personas/'+persona+'/publish','POST',{revision:p.revision})).data;
 assert.equal((await request('/runtime/config/'+group.external_id,'GET',undefined,true)).data.persona_skill.version,1);
 assert.equal((await request('/persona-bindings/'+other.id,'PUT',{revision:other.revision,version_id:v2.id})).status,200);
 assert.equal((await request('/runtime/config/'+other.external_id,'GET',undefined,true)).data.persona_skill.version,2);
 assert.equal((await request('/personas/'+persona+'/archive','POST',{revision:p.revision,archived:true})).status,409);
 const packageResponse=await fetch(base+'/api/persona-versions/'+v1.id+'/export',{headers:{Cookie:cookie}});assert.equal(packageResponse.status,200);assert.equal(packageResponse.headers.get('content-type'),'application/gzip');
});
test('persona generation uses a frozen sample, preserves manual conflicts and never auto-publishes',async()=>{
 const {processPersonaJob}=await import('../server/persona-generation.js');
 const key=(await request('/model-credentials','POST',{name:'Persona generator fixture',base_url:'https://api.example.com/v1',api_key:'isolated-persona-only-key',client_type:'openai'})).data.id;
 await request('/model-credentials/'+key+'/models','POST',{model_id:'text-persona',capability:'text'});
 const p=(await request('/personas/'+personaFixture.persona)).data;
 const job=(await request('/personas/'+p.id+'/generate','POST',{revision:p.revision,credential_id:key,model_id:'text-persona'}));assert.equal(job.status,202);assert.equal(job.data.provenance.sampled_records,3);
 assert.equal((await request('/personas/'+p.id+'/generate','POST',{revision:p.revision,credential_id:key,model_id:'text-persona'})).status,409);
 // The frozen input was created before this curation change.
 await request('/persona-collections/'+personaFixture.collection+'/exclusion','POST',{source_id:'shard:2',excluded:true});
 let observed:any,calls=0;
 await processPersonaJob(async(_c,_m,_system,input)=>{calls++;observed=JSON.parse(input);return {choices:[{message:{content:'Updated voice guidance with practical, concise, respectful language and grounded facts. Follow current group rules and disclose identity under its policy.'}}]};});
 assert.equal(calls,1);assert.equal(observed.samples.length,3);assert(!JSON.stringify(observed.samples).includes('quote-is-not-authorship'));
 let updated=(await request('/personas/'+p.id)).data;assert.equal(updated.jobs[0].status,'ready');assert(updated.draft_skill.includes('Updated voice'));assert.equal(updated.versions.length,p.versions.length);
 await request('/personas/'+p.id+'/generate','POST',{revision:updated.revision,credential_id:key,model_id:'text-persona'});
 await request('/personas/'+p.id,'PUT',{...updated,draft_skill:updated.draft_skill+'\nKeep this manual edit.'});
 await processPersonaJob(async()=>({choices:[{message:{content:'Another generated candidate with enough useful rules for concise natural writing, without overwriting the editor who is currently working.'}}]}));
 updated=(await request('/personas/'+p.id)).data;assert.equal(updated.jobs[0].status,'conflict');assert(updated.draft_skill.includes('Keep this manual edit'));assert(updated.jobs[0].output_skill.includes('Another generated candidate'));
 await request('/personas/'+p.id+'/generate','POST',{revision:updated.revision,credential_id:key,model_id:'text-persona'});
 const c=(await request('/models')).data.credentials.find((c:any)=>c.id===key);await request('/model-credentials/'+key,'PUT',{...c,enabled:false});
 await processPersonaJob(async()=>{throw new Error('must not call a disabled provider');});assert.equal((await request('/personas/'+p.id)).data.jobs[0].status,'failed');
 const logs=JSON.stringify((await request('/logs')).data);assert(!logs.includes('private-authored-A'));assert(!logs.includes('isolated-persona-only-key'));
});

test('different groups select different personas; archive, restore and unbinding preserve history',async()=>{
 const b=(await request('/personas','POST',{name:'Voice B',skill_name:'voice-b',description:'Another independent persona',goal:'',dataset_ids:[]})).data.id;
 let p=(await request('/personas/'+b)).data;
 const version=(await request('/personas/'+b+'/publish','POST',{revision:p.revision})).data;
 assert.equal((await request('/personas/'+b+'/archive','POST',{revision:p.revision,archived:true})).status,200);
 p=(await request('/personas/'+b)).data;assert(p.archived);assert.equal(p.versions.length,1);
 let groups=(await request('/overview')).data.groups,other=groups.find((g:any)=>g.id!==personaFixture.group.id);
 assert.equal((await request('/persona-bindings/'+other.id,'PUT',{revision:other.revision,version_id:version.id})).status,400);
 assert.equal((await request('/personas/'+b+'/archive','POST',{revision:p.revision,archived:false})).status,200);
 assert.equal((await request('/persona-bindings/'+other.id,'PUT',{revision:other.revision,version_id:version.id})).status,200);
 const a=groups.find((g:any)=>g.id===personaFixture.group.id);
 assert.equal((await request('/runtime/config/'+a.external_id,'GET',undefined,true)).data.persona_skill.persona_id,personaFixture.persona);
 assert.equal((await request('/runtime/config/'+other.external_id,'GET',undefined,true)).data.persona_skill.persona_id,b);
 other=(await request('/overview')).data.groups.find((g:any)=>g.id===other.id);
 assert.equal((await request('/persona-bindings/'+other.id,'PUT',{revision:other.revision,version_id:null})).status,200);
 assert.equal((await request('/runtime/config/'+other.external_id,'GET',undefined,true)).data.persona_skill,null);
 p=(await request('/personas/'+personaFixture.persona)).data;
 assert.equal((await request('/personas/'+p.id,'PUT',{...p,source_version_id:version.id})).status,400);
 assert.equal((await request('/personas/'+p.id,'PUT',{...p,source_version_id:personaFixture.version})).status,200);
 assert.deepEqual((await request('/personas/'+p.id)).data.draft_provenance,{});
});

test('runtime health is scoped, rejects extra data, and never confirms a policy revision',async()=>{
 const group=(await request('/overview')).data.groups[0];
 const body={external_id:group.external_id,state:'needs_phone',wechat:false,bridge:true,maibot:true,reason:'phone_confirmation',interval_seconds:3600,actions:[]};
 const old=group.revision,ack=group.applied_revision;
 assert.equal((await request('/runtime/health','POST',body,true)).status,200);
 const status=(await request('/groups/status')).data.find((g:any)=>g.id===group.id);
 assert.equal(status.runtime_health.state,'needs_phone');assert(status.runtime_health_at);
 assert.equal(status.revision,old);assert.equal(status.applied_revision,ack);
 assert.equal((await request('/runtime/health','POST',{...body,api_key:'secret'},true)).status,400);
 const {digest}=await import('../server/security.js');
 await pool.query('INSERT INTO runtime_adapters(token_hash,name,group_external_ids) VALUES($1,$2,$3)',[digest('health-test-scoped-adapter-token'),'health-test',JSON.stringify([group.external_id])]);
 const send=(external_id:string)=>fetch(base+'/api/runtime/health',{method:'POST',headers:{Authorization:'Bearer health-test-scoped-adapter-token','Content-Type':'application/json'},body:JSON.stringify({...body,external_id})});
 assert.equal((await send(group.external_id)).status,200);assert.equal((await send('untrusted-room')).status,403);
});

test('independent WeChat notifications encrypt credentials and bind them to exactly one adapter',async()=>{
 const {digest}=await import('../server/security.js');
 const adapter='notification-test',secret='SCT'+('x'.repeat(24));
 await pool.query('INSERT INTO runtime_adapters(token_hash,name,group_external_ids) VALUES($1,$2,$3)',[digest('notification-test-scoped-adapter-token'),adapter,JSON.stringify(['example-room'])]);
 const b={adapter_name:adapter,recipient_wechat_id:'Ryuuna',sendkey:secret,enabled:true,binding_confirmed:false,revision:0};
 assert.equal((await request('/notifications/wechat','PUT',b)).status,400);
 assert.equal((await request('/notifications/wechat','PUT',{...b,binding_confirmed:true})).status,200);
 assert(!JSON.stringify((await request('/notifications/wechat')).data).includes(secret));
 const ciphertext=(await pool.query('SELECT key_ciphertext FROM runtime_notifications WHERE adapter_token_hash=$1',[digest('notification-test-scoped-adapter-token')])).rows[0].key_ciphertext;
 assert(!ciphertext.includes(secret));
 const response=await fetch(base+'/api/runtime/notification',{headers:{Authorization:'Bearer notification-test-scoped-adapter-token'}});
 assert.equal(response.status,200);assert.equal((await response.json()).sendkey,secret);
 assert.equal((await request('/runtime/notification','GET',undefined,true)).data.configured,false);
 assert.equal((await request('/notifications/wechat','PUT',{...b,binding_confirmed:true})).status,409);
 const logs=JSON.stringify((await request('/logs')).data);assert(!logs.includes(secret));
});

test('audit logs exclude raw knowledge and passwords; logout invalidates sessions',async()=>{
  const logs=JSON.stringify((await request('/logs')).data);
  assert(!logs.includes('secret-A'));assert(!logs.includes(process.env.ADMIN_PASSWORD!));
  await request('/auth/logout','POST');assert.equal((await request('/overview')).status,401);
});
