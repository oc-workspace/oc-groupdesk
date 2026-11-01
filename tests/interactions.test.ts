import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interactionCommand as command,interactionCommands as commands,interactionSettingsDefaults,interactionBindingDefaults} from '../shared/interactions.js';
import {settingsSchema,bindingSchema,definitionSchema,prizeSchema} from '../server/interactions/schema.js';
import {interactionDay} from '../server/interactions/config.js';
import {baseTemplate,parseInteractionTemplate,renderInteraction} from '../server/interactions/copy.js';
test('commands match whole messages, bot prefixes and multilingual stable prize codes',()=>{
 assert.equal(command('我今天想摸鱼，但是还要工作',commands),null);
 assert.equal(command('“摸鱼”',commands),null);
 assert.equal(command('摸鱼!!!',commands)?.action,'checkin');
 assert.equal(command('@小T，摸鱼',commands,['小T'],false,true)?.action,'checkin');
 assert.equal(command('摸鱼',commands,[],false,true),null);
 assert.deepEqual(command('REDEEM r001!',commands),{action:'redeem',locale:'en',prize_code:'R001'});
 assert.equal(command('redeemable r001',commands),null);
 assert.equal(command('兑换飞吻',commands)?.action,'catalog');
 assert.equal(command('兑换 R001',commands)?.prize_code,'R001');
 assert.equal(command('交換 R002',commands)?.locale,'ja');
 assert.equal(command('출석',commands)?.locale,'ko');
 assert.equal(command('可以兑换啥',commands)?.action,'catalog');
});
test('configuration validates accounting limits, time zones and custom interaction boundaries',()=>{
 assert(settingsSchema.safeParse(interactionSettingsDefaults).success);
 assert(!settingsSchema.safeParse({...interactionSettingsDefaults,timezone:'not-a-zone'}).success);
 assert(!settingsSchema.safeParse({...interactionSettingsDefaults,daily_checkin_limit:0}).success);
 assert(!bindingSchema.safeParse({...interactionBindingDefaults,reward_min:101,reward_max:100}).success);
 assert(!definitionSchema.safeParse({name:'x',kind:'custom_reply',description:'',instructions:'',commands}).success);
 assert.equal(prizeSchema.parse({code:'r001',name:'示例',description:'',cost:100,stock:null,enabled:true}).code,'R001');
 assert(!prizeSchema.safeParse({code:'1',name:'示例',description:'',cost:0,stock:-1,enabled:true}).success);
 assert.equal(interactionDay(Date.parse('2026-11-01T16:01:00Z'),'Asia/Singapore'),'2026-11-02');
});
test('AI copy cannot invent amounts, omit facts, repeat placeholders or change locale',()=>{
 const valid=JSON.stringify({locale:'zh-CN',template:'摸到 {{amount}} token，余额 {{balance}} token。🐟'});
 assert.equal(renderInteraction(parseInteractionTemplate(valid,'zh-CN','checked_in'),{amount:23,balance:46}),'摸到 23 token，余额 46 token。🐟');
 for(const template of ['摸到 999 token，余额 {{balance}}。','摸到 {{amount}}，{{amount}}，余额 {{balance}}。','摸到 {{amount}}。','https://example.invalid {{amount}} {{balance}}','Hi {{amount}}, balance {{balance}}']){
  assert.throws(()=>parseInteractionTemplate(JSON.stringify({locale:'zh-CN',template}),'zh-CN','checked_in'));
 }
 assert.throws(()=>parseInteractionTemplate(valid,'en','checked_in'));
 assert.match(baseTemplate('zh-CN','catalog_empty'),/现在还没定奖品，可以找群主商量/);
 assert.match(renderInteraction(baseTemplate('zh-CN','catalog'),{list:'1. aaa\n2. bbb',command:'兑换 R001'}),/兑换列表\n1\. aaa\n2\. bbb\n发送“兑换 R001”/);
 // Values are inserted once, even when a prize itself contains placeholder syntax.
 assert.equal(renderInteraction('{{prize}}',{prize:'{{amount}}'}),'{{amount}}');
});
