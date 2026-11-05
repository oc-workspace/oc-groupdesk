import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindBotApi} from '../web/scoped-api.js';
test('a late editor save keeps its original robot after a workspace switch',async()=>{
 const calls:any[]=[];let finish!:(value:unknown)=>void;
 const transport=async(path:string,method?:string,body?:unknown,signal?:AbortSignal,botId?:string)=>{calls.push({path,method,body,botId,signal});if(path==='/slow-preview')return new Promise(r=>finish=r);return {botId};};
 const original=bindBotApi('robot-a',transport);const preview=original('/slow-preview','POST',{prompt:'synthetic'});
 const selected=bindBotApi('robot-b',transport);assert.deepEqual(await selected('/overview'),{botId:'robot-b'});
 finish({draft:'ready'});await preview;await original('/topics','POST',{name:'original editor'});
 assert.deepEqual(calls.map(c=>c.botId),['robot-a','robot-b','robot-a']);
 const abort=new AbortController();await selected('/groups/status','GET',undefined,abort.signal);assert.equal(calls[3].signal,abort.signal);
});
