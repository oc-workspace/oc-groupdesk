import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isInitialPersonaDraft,refreshPersonaEditor} from '../shared/persona-editor.js';
import {collectionQuotas,packPersonaSamples} from '../server/persona-sampling.js';

test('initial scaffolding stays distinct from generated and manually authored skills',()=>{
 const skill='---\nname: test\ndescription: "test"\n---\n\n# test\n\n在这里编写适用场景、表达方式、语言和边界；也可以先关联素材，再生成待人工修订的草稿。\n';
 assert(isInitialPersonaDraft(skill));assert(isInitialPersonaDraft(skill.replaceAll('\n','\r\n')));
 assert(!isInitialPersonaDraft(skill+'\nA manually written rule for this persona.'));
 assert(!isInitialPersonaDraft('---\nname: test\ndescription: "test"\n---\n\nUseful complete voice rules.'));
});
test('refresh loads completed drafts while preserving unsaved edits and the active persona',()=>{
 const local={id:'a',draft_skill:'unsaved user edit',revision:2,jobs:[],versions:[]};
 const remote={id:'a',draft_skill:'complete generated draft',revision:3,jobs:[{status:'ready'}],versions:[]};
 assert.equal(refreshPersonaEditor(local,remote,false).draft_skill,remote.draft_skill);
 const preserved=refreshPersonaEditor(local,remote,true);assert.equal(preserved.draft_skill,local.draft_skill);assert.equal(preserved.revision,2);assert.deepEqual(preserved.jobs,remote.jobs);
 assert.equal(refreshPersonaEditor(local,{...remote,id:'another'},false),local);
});
test('small analysis and curated collections remain represented beside a full archive',()=>{
 const quotas=collectionQuotas([{collection_id:'archive',eligible_records:176245},{collection_id:'analysis',eligible_records:32},{collection_id:'curated',eligible_records:101}]);
 assert.equal(quotas.reduce((n,q)=>n+q.take,0),500);assert.equal(quotas.find(q=>q.collection_id==='analysis')?.take,32);assert.equal(quotas.find(q=>q.collection_id==='curated')?.take,101);
 assert.equal(collectionQuotas([{collection_id:'small',eligible_records:2}])[0].take,2);
});
test('reference excerpts get useful space without exceeding the total character budget',()=>{
 const rows=Array.from({length:500},(_,i)=>({source_id:String(i),collection_id:'c',kind:i<32?'document':'text',text:'中😀'.repeat(2000),prefix_truncated:true}));
 const sample=packPersonaSamples(rows);assert(sample.characters<=100000);assert(sample.selected[0].text.length>200);assert(sample.selected.every(r=>r.truncated));
});
