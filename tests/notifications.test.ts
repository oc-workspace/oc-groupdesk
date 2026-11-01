import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyWechatNotification} from '../server/notifications.js';
test('notification verification uses only the configured service and reports acceptance without claiming delivery',async()=>{
 let called=0;
 await verifyWechatNotification('SCT'+'x'.repeat(24),(async(url:any,options:any)=>{
  called++;assert(String(url).startsWith('https://sctapi.ftqq.com/SCT'));assert.equal(options.redirect,'error');
  const text=String(options.body);assert(!text.includes('sk-'));return Response.json({code:0});
 }) as typeof fetch);assert.equal(called,1);
 await assert.rejects(()=>verifyWechatNotification('invalid',(async()=>{throw Error('must not call');}) as typeof fetch));
 await assert.rejects(()=>verifyWechatNotification('SCT'+'x'.repeat(24),(async()=>Response.json({code:400})) as typeof fetch));
});
