import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {pool,transaction} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {createApp} from '../server/app.js';
import {samplePersonaDatasets} from '../server/persona-sampling.js';
import {processPersonaJob} from '../server/persona-generation.js';
import {readJobInput} from '../server/persona-materials.js';

if(!process.env.DATABASE_URL?.includes('groupdesk_test'))throw Error('Dedicated test database required');
let server:Server,base='',cookie='',csrf='',archive='',references='',curated='';const datasets:string[]=[];
async function request(path:string,method='GET',body?:unknown){
 const r=await fetch(base+'/api'+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json(),response:r};
}
async function collection(name:string){
 const id=randomUUID(),importId=randomUUID();
 await pool.query('INSERT INTO persona_collections(id,name,source_group_id) VALUES($1,$2,$3)',[id,name,'synthetic-historical-room']);
 await pool.query("INSERT INTO persona_imports(id,collection_id,name,format,sha256,filename) VALUES($1::uuid,$2::uuid,'fixture.jsonl','jsonl',$1::text,$1::text)",[importId,id]);
 return {id,importId};
}
async function dataset(collectionId:string,name:string,senders:string[]=[],terms:string[]=[]){
 const id=randomUUID();await pool.query('INSERT INTO persona_datasets(id,collection_id,name,sender_ids,contains_any) VALUES($1,$2,$3,$4,$5)',[id,collectionId,name,senders,terms]);return id;
}
before(async()=>{
 await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate();
 server=createServer(createApp());await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const login=await request('/auth/login','POST',{username:'admin',password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 const a=await collection('Large synthetic archive'),b=await collection('Synthetic analysis'),c=await collection('Synthetic curated evidence');archive=a.id;references=b.id;curated=c.id;
 await pool.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,kind,content_status,source,content_hash,import_id)
  SELECT $1,'full:'||lpad(i::text,8,'0'),CASE WHEN i%2=0 THEN 'speaker-a' ELSE 'speaker-b' END,'Synthetic speaker',1700000000+i,
   CASE WHEN i%1000=0 THEN NULL ELSE 'Concrete synthetic reply '||i::text END,'text','text_decoded',
   jsonb_build_object('unselected_metadata','UNSELECTED-METADATA'),md5(i::text),$2 FROM generate_series(1,220001) i`,[archive,a.importId]);
 await pool.query("UPDATE persona_materials SET excluded=true WHERE collection_id=$1 AND source_id='full:00000002'",[archive]);
 await pool.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,kind,content_status,source,content_hash,import_id)
  SELECT $1,'doc:'||i::text,'__reference__','Reference',0,repeat('Detailed reference guidance. ',200),'document','text_document','{}',md5(i::text),$2 FROM generate_series(1,32) i`,[references,b.importId]);
 await pool.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,kind,content_status,source,content_hash,import_id)
  SELECT $1,'full:'||lpad(i::text,8,'0'),'curated-speaker','Curated',1700000000+i,'Reviewed reply '||i::text,'text','text_decoded','{}',md5(i::text),$2 FROM generate_series(1,101) i`,[curated,c.importId]);
 datasets.push(await dataset(archive,'Whole history'),await dataset(archive,'Overlapping exact speaker',['speaker-a']),await dataset(references,'Analysis'),await dataset(curated,'Curated'));
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();});

test('large overlapping selections stay bounded and retain analysis plus curated evidence',async()=>{
 const sampled=await transaction(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return samplePersonaDatasets(datasets,db);});
 assert.equal(sampled.total_records,220133);assert.equal(sampled.eligible,219913);assert.equal(sampled.selected.length,500);assert(sampled.characters<=100000);
 assert.equal(sampled.collections.find(c=>c.collection_id===references)?.sampled_records,32);assert.equal(sampled.collections.find(c=>c.collection_id===curated)?.sampled_records,101);
 assert(sampled.selected.filter(r=>r.kind==='document').every(r=>r.text.length>200));
 const raw=sampled.selected.filter(r=>r.collection_id===archive);assert.equal(raw.length,367);assert.equal(raw[0].id,'full:00000001');assert.equal(raw.at(-1)?.id,'full:00220001');
 assert(!JSON.stringify(sampled).includes('UNSELECTED-METADATA'));assert(!sampled.selected.some(r=>r.collection_id===archive&&r.id==='full:00000002'));
});
test('keyword datasets retain Unicode aliases and boundaries without reading quotation bodies',async()=>{
 const c=await collection('Keyword source'),texts=['ＡＬＥＸ—Ｚ speaks','Alexander does not match','literal a+b','notalex-z is not a whole word','quotation only'];
 for(let i=0;i<texts.length;i++)await pool.query(`INSERT INTO persona_materials(collection_id,source_id,sender_id,sender_name,timestamp,authored_text,quoted_context,kind,content_status,source,content_hash,import_id)
  VALUES($1,$2,'keyword-speaker','Keyword',1700000000+$3,$4,'{"text":"Alex-Z quoted only"}','text','text_decoded','{}',$2,$5)`,[c.id,'keyword:'+i,i,texts[i],c.importId]);
 const id=await dataset(c.id,'Keyword alias',['keyword-speaker'],['Alex-Z','a+b']);
 const sampled=await transaction(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return samplePersonaDatasets([id],db);});
 assert.equal(sampled.total_records,2);assert.equal(sampled.selected.length,2);assert.deepEqual(sampled.selected.map(r=>r.id),['keyword:0','keyword:2']);
});
test('scaffolding cannot publish and a full-archive creation produces a visible complete draft',async()=>{
 const created=await request('/personas','POST',{name:'Large archive voice',skill_name:'large-archive-voice',description:'A standalone community voice',goal:'Make a useful full voice',dataset_ids:datasets});assert.equal(created.status,201);
 let p=(await request('/personas/'+created.data.id)).data;assert.equal((await request('/personas/'+p.id+'/publish','POST',{revision:p.revision})).status,400);
 const key=(await request('/model-credentials','POST',{name:'Synthetic sampling model',base_url:'https://api.example.com/v1',api_key:'isolated-sampling-fixture-only',client_type:'openai'})).data.id;
 await request('/model-credentials/'+key+'/models','POST',{model_id:'sampling-fixture',capability:'text'});
 const queued=await request('/personas/'+p.id+'/generate','POST',{revision:p.revision,credential_id:key,model_id:'sampling-fixture'});assert.equal(queued.status,202);assert.equal(queued.data.provenance.total_records,220133);assert.equal(queued.data.provenance.sampled_records,500);
 const job=(await pool.query('SELECT input_file FROM persona_jobs WHERE id=$1',[queued.data.id])).rows[0];assert.equal((await readJobInput(job.input_file)).persona.previous_skill,'');
 await processPersonaJob(async()=>({choices:[{message:{content:'A complete generated voice with concrete examples, natural concise questions and explicit boundaries. Keep contextual uncertainty and never invent personal experiences.'}}]}));
 p=(await request('/personas/'+p.id)).data;assert.equal(p.jobs[0].status,'ready');assert(p.draft_skill.includes('A complete generated voice'));assert(p.draft_skill.length>107);assert.equal(p.versions.length,0);
});
