import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeStatuses,confirmationFor,clearCheckedRevisions,type GroupStatus} from '../web/group-status.js';
const now=Date.parse('2026-10-31T13:00:00Z');
const row=(patch:Partial<GroupStatus>={}):GroupStatus=>({id:'group-a',revision:4,applied_revision:3,bot_seen_at:'2026-10-31T12:59:00Z',enabled:true,...patch});

test('later confirmation updates displayed state and contains only status metadata',()=>{
  const pending=mergeStatuses({},[row()]);
  assert.equal(confirmationFor(4,pending['group-a'],now).kind,'pending');
  const updated=mergeStatuses(pending,[row({applied_revision:4})]);
  assert.equal(confirmationFor(4,updated['group-a'],now).kind,'confirmed');
  assert(!('policy' in updated['group-a']));
  assert.equal(pending['group-a'].applied_revision,3);
});
test('out-of-order poll cannot undo a successful save or confirmed heartbeat',()=>{
  let values=mergeStatuses({},[row({revision:5,applied_revision:4})]);
  values=mergeStatuses(values,[row({revision:4,applied_revision:4})]);
  assert.equal(values['group-a'].revision,5);
  values=mergeStatuses(values,[row({revision:5,applied_revision:5,bot_seen_at:'2026-10-31T13:00:00Z'})]);
  values=mergeStatuses(values,[row({revision:5,applied_revision:4,bot_seen_at:'2026-10-31T12:59:00Z'})]);
  assert.equal(values['group-a'].applied_revision,5);
  assert.equal(values['group-a'].bot_seen_at,'2026-10-31T13:00:00Z');
});
test('stale, absent and externally changed versions are not reported as live confirmation',()=>{
  assert.equal(confirmationFor(4,undefined,now).kind,'checking');
  assert.equal(confirmationFor(4,row({revision:3}),now).kind,'checking');
  assert.equal(confirmationFor(4,row({revision:5}),now).kind,'changed');
  assert.equal(confirmationFor(4,row({applied_revision:4,bot_seen_at:null}),now).kind,'pending');
  assert.equal(confirmationFor(4,row({applied_revision:4,bot_seen_at:'2026-10-31T12:50:00Z'}),now).kind,'offline');
  assert.equal(confirmationFor(4,row({applied_revision:4,bot_seen_at:'invalid'}),now).kind,'checking');
});
test('status updates remain isolated between groups',()=>{
  const values=mergeStatuses({},[row(),row({id:'group-b',revision:7,applied_revision:7})]);
  const updated=mergeStatuses(values,[row({applied_revision:4})]);
  assert.deepEqual(updated['group-b'],values['group-b']);
  assert.equal(updated['group-a'].applied_revision,4);
});

test('an older manual check cannot dismiss the reminder for a newly saved revision',()=>{
  const required={'group-a':5,'group-b':7};
  const stale=clearCheckedRevisions(required,[row({revision:4})]);
  assert.deepEqual(stale,required);
  const checked=clearCheckedRevisions(stale,[row({revision:5})]);
  assert.deepEqual(checked,{'group-b':7});
  assert.deepEqual(required,{'group-a':5,'group-b':7});
});
