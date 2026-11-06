import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityPolicySchema} from '../server/identity.js';
import {resolveBotIdentity,botIdentityInstructions,withPersonaIdentityBoundary} from '../shared/bot-identity.js';
import {cleanPersonaIdentity} from '../server/bot-identity-maintenance.js';
const bot={id:'a',name:'Tatsumi',wechat_id:'Tatsumisaki'};
test('per-group names, natural self-reference and explicit empty mentions are independent',()=>{
 const a=resolveBotIdentity(bot,'group-a',{bot_name:'小T',self_reference:'本喵',mention_names:['小T']}),b=resolveBotIdentity(bot,'group-b',{bot_name:'小白',mention_names:[]});
 assert.deepEqual(a.mention_names,['小T']);assert.deepEqual(b.mention_names,[]);assert.equal(b.self_reference,null);
 assert.deepEqual(resolveBotIdentity(bot,'c').mention_names,['Tatsumi','Tatsumisaki']);
 assert(botIdentityInstructions(a).join('\n').includes('不要把对你的点名当作在询问另一位同名成员'));assert(!botIdentityInstructions(b).join('\n').includes('本喵'));
});
test('naming is bounded literal data, rejects duplicate aliases and preserves legacy identity policy',()=>{
 assert.deepEqual(identityPolicySchema.parse({}),{disclosure:'when_asked',personal_questions:'tactful'});
 for(const bad of [{bot_name:'bad\nname'},{self_reference:'x'.repeat(41)},{mention_names:['Tatsumi','tatsumi']},{mention_names:Array.from({length:13},(_,i)=>String(i))}])assert.equal(identityPolicySchema.safeParse(bad).success,false);
 assert.deepEqual(identityPolicySchema.parse({mention_names:[]}).mention_names,[]);
 assert.deepEqual(identityPolicySchema.parse({mention_names:['T.+','Little T']}).mention_names,['T.+','Little T']);
});
test('persona cleanup removes fixed follower identity and is repeatable without altering style labels',()=>{
 const text='---\nname: gt-persona\ndescription: test style\n---\n# GT Persona\n你以GT小跟班的身份接话。风格直率。';
 const cleaned=cleanPersonaIdentity(text);assert(!cleaned.includes('GT小跟班'));assert(cleaned.includes('# GT Persona'));assert(cleaned.includes('风格直率'));assert.equal(cleanPersonaIdentity(cleaned),cleaned);assert.equal(withPersonaIdentityBoundary(cleaned),cleaned);
});
