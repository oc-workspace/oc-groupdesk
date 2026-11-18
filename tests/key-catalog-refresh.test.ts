import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshedKeyModels} from '../server/key-catalog-refresh.js';

test('refresh marks disappeared catalog models historical and retains manual registrations',()=>{
 const current=[{model_id:'new-text',capability:'text',source:'catalog',listed:true},{model_id:'same-image',capability:'image',source:'catalog',listed:true}];
 const previous=[{model_id:'old-text',capability:'text',source:'catalog',listed:true},{model_id:'same-image',capability:'text',source:'catalog',listed:true},{model_id:'manual-text',capability:'text',source:'manual',listed:false}];
 const models=refreshedKeyModels(current,previous);
 assert.deepEqual(models.map(m=>[m.model_id,m.capability,m.listed]),[['new-text','text',true],['same-image','image',true],['old-text','text',false],['manual-text','text',false]]);
 assert.deepEqual(previous[0],{model_id:'old-text',capability:'text',source:'catalog',listed:true});
});
