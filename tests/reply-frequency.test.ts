import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replyFrequencySchema} from '../server/reply-frequency.js';
import {replyFrequencyDefaults} from '../shared/reply-frequency.js';
test('reply frequency supports configurable rolling windows and direct catch-up settings',()=>{
 assert.deepEqual(replyFrequencySchema.parse(replyFrequencyDefaults),replyFrequencyDefaults);
 assert.equal(replyFrequencySchema.parse({windows:[{minutes:3,max_replies:8}],catch_up:{enabled:false,within_minutes:20}}).windows[0].max_replies,8);
});
test('reply frequency rejects duplicate windows, non-integers, oversized waits and unknown fields',()=>{
 for(const policy of [
  {...replyFrequencyDefaults,windows:[]},
  {...replyFrequencyDefaults,windows:[{minutes:0,max_replies:1}]},
  {...replyFrequencyDefaults,windows:[{minutes:5,max_replies:1},{minutes:5,max_replies:2}]},
  {...replyFrequencyDefaults,windows:[{minutes:1.5,max_replies:1}]},
  {...replyFrequencyDefaults,catch_up:{enabled:true,within_minutes:61}},
  {...replyFrequencyDefaults,catch_up:{enabled:1,within_minutes:10}},
  {...replyFrequencyDefaults,extra:true}
 ])assert.equal(replyFrequencySchema.safeParse(policy).success,false);
});
