import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textMatchesAny,conversationGuide,conversationDefaults} from '../shared/conversation.js';
import {parseJudgements,insightSummary,analysisFailure} from '../server/conversation-insights.js';
import {generationRequest} from '../server/model-generation.js';
test('authored target filters support normalized aliases without substring identity mistakes',()=>{
 for(const s of ['Ask Alex-Z.','@alex z hi','ＡＬＥＸ—Ｚ','Alex left early'])assert(textMatchesAny(s,['Alex-Z','Alex Z','Alex']));
 for(const s of ['Alexander left','notalex','words'])assert(!textMatchesAny(s,['Alex']));
 assert(textMatchesAny('a+b',['a+b']));assert(!textMatchesAny('ab',['a+b']));assert(textMatchesAny('anything',[]));
});
test('low confidence stays uncertain and malformed, duplicate or foreign IDs are rejected',()=>{
 const item={id:0,tone:'playful',substantive:false,confidence:.4,reason:'Context is missing'};
 const result=parseJudgements(JSON.stringify({items:[item]}),1)[0];assert.equal(result.tone,'uncertain');assert.equal(result.substantive,null);
 assert.equal(parseJudgements('  ```JSON '+JSON.stringify({items:[item]})+'```  ',1).length,1);
 assert.throws(()=>parseJudgements('prose '+JSON.stringify({items:[item]}),1));
 for(const items of [[],[item,item],[{...item,id:1}],[{...item,confidence:1.2}],[{...item,tone:'liar'}]])assert.throws(()=>parseJudgements(JSON.stringify({items}),1));
});
test('Gemini analysis requests JSON while Persona/plain generation remains text by default',()=>{
 const c={base_url:'https://example.com',client_type:'gemini' as const};
 assert.equal((generationRequest(c,'gemini-3.8-flash','s','i',{jsonOutput:true,lowThinking:true}).body as any).generationConfig.responseMimeType,'application/json');
 assert.equal((generationRequest(c,'gemini-3.8-flash','s','i').body as any).generationConfig.responseMimeType,undefined);
 assert.equal((generationRequest({base_url:'https://example.com/v1',client_type:'openai'},'m','s','i',{jsonOutput:true}).body as any).response_format,undefined);
});
test('analysis errors explain validation and database failures without echoing private model text',()=>{
 let invalid:unknown;try{parseJudgements(JSON.stringify({items:[{id:0,tone:'private-model-text',substantive:true,confidence:.9,reason:'secret'}]}),1);}catch(e){invalid=e;}
 const message=analysisFailure(invalid);assert.match(message,/items.0.tone/);assert(!message.includes('private-model-text'));assert(!message.includes('secret'));
 assert(!analysisFailure(new SyntaxError('private-model-output')).includes('private-model-output'));
 assert.match(analysisFailure({code:'23503',detail:'private detail'}),/23503/);
});
test('statistics keep mixed substance, unknowns, changed sources and exclusions distinct',()=>{
 const rows=[0,1,2,3].map(i=>({collection_id:'c',source_id:String(i),content_hash:'new',timestamp:i}));
 const labels=[{...rows[0],tone:'mixed',substantive:true},{...rows[1],tone:'playful',substantive:false},{...rows[2],tone:'uncertain',substantive:null},{...rows[3],content_hash:'old',tone:'serious',substantive:true}];
 const {stats}=insightSummary(rows,labels);assert.equal(stats.substantive_ratio,.5);assert.equal(stats.analyzed,3);assert.equal(stats.remaining,1);assert.equal(stats.undetermined,1);assert.equal(stats.tones.mixed,1);
 assert.equal(insightSummary([],labels).stats.substantive_ratio,null);
});
test('group tone guidance is opt in and never turns jokes into facts or bypasses limits',()=>{
 assert.equal(conversationGuide(conversationDefaults),'');
 assert.match(conversationGuide({...conversationDefaults,enabled:true}),/不主动接梗/);
 assert.match(conversationGuide({...conversationDefaults,enabled:true,banter_replies:true}),/不把玩笑存成人物事实/);
});

test('per-group reply limits keep old defaults and validate editable bounds',async()=>{
 const {conversationPolicySchema}=await import('../server/conversation-policy.js');
 const legacy={enabled:false,banter_replies:false,frequency:'low',instructions:''};
 assert.deepEqual(conversationPolicySchema.parse(legacy).reply_limits,{enabled:true,max_rounds:2,reset_seconds:180,followup_seconds:180});
 const a=conversationPolicySchema.parse({...legacy,reply_limits:{enabled:true,max_rounds:4,reset_seconds:300,followup_seconds:240}});assert.equal(a.reply_limits.max_rounds,4);
 for(const limits of [{...a.reply_limits,max_rounds:0},{...a.reply_limits,max_rounds:21},{...a.reply_limits,reset_seconds:29},{...a.reply_limits,followup_seconds:1801},{...a.reply_limits,enabled:1}])assert.throws(()=>conversationPolicySchema.parse({...legacy,reply_limits:limits}));
});
