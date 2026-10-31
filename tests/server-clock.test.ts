import{test}from'node:test';
import assert from'node:assert/strict';
import{createServerClock}from'../web/server-clock.js';
import{confirmationFor,type GroupStatus}from'../web/group-status.js';
test('server time avoids false future-heartbeat warnings on a slow device and still expires stale confirmation',()=>{
  const server=Date.parse('2026-10-31T13:46:33Z'),client=server-69000;
  const status:GroupStatus={id:'test',revision:5,applied_revision:5,bot_seen_at:new Date(server).toISOString(),enabled:true};
  assert.equal(confirmationFor(5,status,client).kind,'checking');
  const clock=createServerClock();clock.update(new Date(server).toUTCString(),client);
  assert.equal(confirmationFor(5,status,clock.now(client)).kind,'confirmed');
  assert.equal(confirmationFor(5,status,clock.now(client+180000)).kind,'offline');
  clock.update('invalid',client+1000);assert.equal(clock.now(client+1000),server+1000);
  clock.update(new Date(server+2000).toUTCString(),client+2000+300000);
  assert.equal(confirmationFor(5,status,clock.now(client+2000+300000)).kind,'confirmed');
});
