import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelProbe} from '../web/model-probe.js';

test('each owned active key can refresh even without text models, while historical catalog entries are hidden',()=>{
 const keys=[
  {id:'empty',name:'Empty key',client_type:'openai',base_url:'https://example.com/v1',is_owner:true,enabled:true,archived:false,models:[]},
  {id:'key',name:'Catalog key',client_type:'gemini',base_url:'https://example.com',is_owner:true,enabled:true,archived:false,models:[
   {model_id:'current-text',capability:'text',source:'catalog',listed:true},
   {model_id:'old-text',capability:'text',source:'catalog',listed:false},
   {model_id:'manual-text',capability:'text',source:'manual',listed:false},
   {model_id:'image-model',capability:'image',source:'catalog',listed:true}
  ]},
  {id:'foreign',name:'Foreign key',client_type:'openai',base_url:'https://example.com/v1',is_owner:false,enabled:true,archived:false,models:[]}
 ];
 const html=renderToStaticMarkup(React.createElement(ModelProbe,{keys,api:async()=>({}),onRefresh:async()=>{}}));
 assert.equal((html.match(/刷新此 Key 的模型目录/g)||[]).length,2);
 assert.match(html,/Empty key/);assert.match(html,/current-text/);assert.match(html,/manual-text/);assert.match(html,/image-model/);
 assert.doesNotMatch(html,/old-text|Foreign key/);
});
