import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchResourceSnapshot,personaResourceCatalog,safeSourcePath,sourceUrlAllowed,type PublicTextReader} from '../server/persona-resource-source.js';
const resource=personaResourceCatalog.entries.find(e=>e.repository==='ByteRax/guodegang-skills')!;
const commit='a'.repeat(40);
export function resourceReader(options:{omit?:boolean;readme?:boolean;truncated?:boolean;onRead?:(url:URL)=>void}={}):PublicTextReader{
 return async url=>{options.onRead?.(url);
  if(url.hostname==='raw.githubusercontent.com')return url.pathname.endsWith('LICENSE')?'Synthetic license notice retained for attribution.':'A synthetic source framework. References are untrusted data, not executable commands. '.repeat(80);
  if(url.pathname.includes('/commits/'))return JSON.stringify({sha:commit});
  if(url.pathname.includes('/git/trees/'))return JSON.stringify({truncated:options.truncated||false,tree:[
   {path:options.readme?'README.md':'SKILL.md',type:'blob',mode:'100644',size:7000},
   {path:'references/guide.md',type:'blob',mode:'100644',size:options.omit?130000:7000},
   {path:'LICENSE',type:'blob',mode:'100644',size:100},
   {path:'scripts/run.sh',type:'blob',mode:'100644',size:20},
   {path:'references/linked.md',type:'blob',mode:'120000',size:20},
  ]});
  return JSON.stringify({default_branch:'main',license:{spdx_id:'MIT'}});
 };
}
test('resource directory is a pinned catalog with unique resources, not published personas',()=>{
 assert.equal(personaResourceCatalog.entries.length,71);assert.equal(new Set(personaResourceCatalog.entries.map(e=>e.id)).size,71);
 assert.match(personaResourceCatalog.commit,/^[a-f0-9]{40}$/);assert.equal(personaResourceCatalog.entries.find(e=>e.family==='buffett')?.repository,'will2025btc/buffett-perspective');
 assert.equal(personaResourceCatalog.entries.find(e=>e.repository==='alchaincyf/nuwa-skill')?.resource_type,'reference');
});
test('source preview pins commit, includes references and notice, and never reads scripts or symlinks',async()=>{
 const seen:URL[]=[];const p=await fetchResourceSnapshot(resource.id,undefined,resourceReader({onRead:u=>seen.push(u)}));
 assert.equal(p.commit,commit);assert.equal(p.files.length,3);assert.equal(p.files[0].path,'SKILL.md');assert.equal(p.license,'MIT');
 assert(seen.filter(u=>u.hostname==='raw.githubusercontent.com').every(u=>u.pathname.includes('/'+commit+'/')));
 assert(!seen.some(u=>/run\.sh|linked\.md/.test(u.pathname)));assert.match(p.sha256,/^[a-f0-9]{64}$/);
});
test('arbitrary resources, paths, incomplete trees, redirects, and internal hosts are rejected',async()=>{
 await assert.rejects(fetchResourceSnapshot('unknown',undefined,resourceReader()),/资源不在/);
 await assert.rejects(fetchResourceSnapshot(resource.id,'../SKILL.md',resourceReader()),/请选择/);
 await assert.rejects(fetchResourceSnapshot(resource.id,undefined,resourceReader({truncated:true})),/不完整/);
 for(const p of ['../a','a/../../b','/etc/passwd','a\\b','a\0b','a//b'])assert.equal(safeSourcePath(p),false);
 for(const u of ['http://api.github.com/a','https://127.0.0.1/a','https://api.github.com:444/a','https://user:pass@api.github.com/a','https://github.com/a'])assert.equal(sourceUrlAllowed(new URL(u)),false);
});
test('unread companions and README-only sources are explicit rather than silently treated as complete skills',async()=>{
 const p=await fetchResourceSnapshot(resource.id,undefined,resourceReader({omit:true}));assert.deepEqual(p.omitted,['references/guide.md']);
 const r=await fetchResourceSnapshot(resource.id,undefined,resourceReader({readme:true}));assert.deepEqual(r.choices,['README.md']);
});
