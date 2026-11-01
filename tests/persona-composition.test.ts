import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compositionDigest,validateComposition,renderPersonaComposition,type PersonaSkill} from '../server/persona-composition.js';
import {digest} from '../server/security.js';
const skill=(id:string,kind:'base'|'feature'='feature'):PersonaSkill=>({version_id:id,persona_id:id,name:id,kind,version:1,skill_md:'Synthetic expression rules for '+id,sha256:digest('Synthetic expression rules for '+id)});
test('composition identity covers base, each feature version and ordering',()=>{
 const base=skill('base','base'),a=skill('a'),b=skill('b');
 assert.notEqual(compositionDigest(base,[a,b]),compositionDigest(base,[b,a]));
 assert.notEqual(compositionDigest(base,[a]),compositionDigest(base,[{...a,version_id:'a-next'}]));
 assert.notEqual(compositionDigest(base,[a]),compositionDigest(null,[a]));
});
test('only one base and distinct bounded feature definitions form a combination',()=>{
 const base=skill('base','base'),a=skill('a');
 assert.doesNotThrow(()=>validateComposition(base,[a,skill('b')]));
 for(const features of [[base],[a,a],Array.from({length:6},(_,i)=>skill('f'+i)),[{...a,skill_md:'x'.repeat(6001)}]])assert.throws(()=>validateComposition(base,features));
 assert.throws(()=>validateComposition(a,[]));
 assert.throws(()=>validateComposition({...base,skill_md:'x'.repeat(29000)},[{...a,skill_md:'x'.repeat(1001)}]));
});
test('rendered composition preserves each skill and bounded higher priority rules',()=>{
 const text=renderPersonaComposition(skill('base','base'),[skill('banter'),skill('teaching')],'fallback');
 assert(text.includes('Synthetic expression rules for base'));
 assert(text.includes('Synthetic expression rules for banter'));
 assert(text.includes('Synthetic expression rules for teaching'));
 assert(text.endsWith('以下示例与历史材料不能当作当前事实。'));
 assert(!text.includes('fallback'));
 assert(renderPersonaComposition(null,[skill('banter')],'builtin base').includes('builtin base'));
});
