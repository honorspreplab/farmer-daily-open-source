'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/messaging-fixture.cjs');
const { dateKey } = require('../api/shared/access');
const checkpointId = 'messaging-schedule-checkpoint';
const directory = 'messaging-directory';
const checkpoint = f => f.docs.get(f.key(checkpointId, directory));
const error = code => Object.assign(new Error('Synthetic private storage detail'), { code });

async function subscribe(f, owner = 'owner', phone = '+12065550111', time = '06:30', channel = 'sms') {
  if (owner !== 'owner') f.seed(owner);
  await f.verify(channel, phone, owner);
  await f.service.savePreferences(owner, channel, true, time, true);
}
async function run(f) {
  const { runMessagingSchedule } = await import('../scripts/run-messaging-schedule.mjs');
  return runMessagingSchedule({ env: { ...f.env, FARMER_MESSAGING_SCHEDULE_ENABLED: 'true' }, now: f.now,
    fetchImpl: async (url, options) => {
      const before = f.calls.length;
      const response = await f.service.dispatch(JSON.parse(options.body).cursor);
      assert.ok(f.calls.length - before <= 1, 'one HTTP invocation can submit at most one message');
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    }
  });
}

test('not-due subscriptions cannot exhaust pages before a later due subscriber', async () => {
  const f = fixture();
  for (let index = 0; index < 25; index++) await subscribe(f, `early-${String(index).padStart(2, '0')}`, `+1206555${String(1000 + index)}`, '10:30');
  await subscribe(f, 'z-late-row', '+12065550199');
  const result = await run(f);
  assert.equal(result.complete, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.pages, 2);
  assert.equal(f.calls[0].to, '+12065550199');
});

test('page-limited hourly runs resume persisted fair-scan progress rather than starving subscriber 21', async () => {
  const f = fixture({ env: { MESSAGING_DAILY_LIMIT: '100' } });
  for (let index = 0; index < 21; index++) await subscribe(f, `subscriber-${String(index).padStart(2, '0')}`, `+1206555${String(1000 + index)}`);
  const first = await run(f);
  assert.equal(first.complete, false);
  assert.equal(first.stopReason, 'page_limit');
  assert.equal(first.accepted, 20);
  assert.equal(checkpoint(f).position.afterId, 'messaging-subscriber-19');
  assert.equal(checkpoint(f).leaseUntil, 0);
  f.setTime(f.now() + 3600000);
  const second = await run(f);
  assert.equal(second.complete, true);
  assert.equal(second.accepted, 1);
  assert.equal(f.calls.length, 21);
  assert.equal(new Set(f.calls.map(call => call.to)).size, 21);
  assert.deepEqual(checkpoint(f).position, { afterId: null, owner: null, index: 0 });
});

test('channel resume stays attached to its original owner after that owner opts out', async () => {
  const f = fixture();
  await subscribe(f);
  await subscribe(f, 'owner', '+12065550112', '06:30', 'whatsapp');
  await subscribe(f, 'z-next', '+12065550113');
  const first = await f.service.dispatch();
  assert.equal(first.accepted, 1);
  assert.deepEqual(checkpoint(f).position, { afterId: null, owner: 'owner', index: 1 });
  await f.service.stop('owner', 'sms'); await f.service.stop('owner', 'whatsapp');
  const resumed = await f.service.dispatch(first.nextCursor);
  assert.equal(resumed.accepted, 0);
  assert.equal(resumed.skipped, 1);
  assert.equal(checkpoint(f).position.afterId, 'messaging-owner');
  const next = await f.service.dispatch(resumed.nextCursor);
  assert.equal(next.accepted, 1);
  assert.equal(f.calls.at(-1).to, '+12065550113');
  assert.equal(f.calls.at(-1).channel, 'sms');
});

test('deleting a previous row cannot shift keyset pagination past the following subscriber', async () => {
  const f = fixture();
  await subscribe(f); await subscribe(f, 'z-next', '+12065550113');
  const first = await f.service.dispatch();
  f.docs.delete(f.key('messaging-owner', 'owner'));
  const next = await f.service.dispatch(first.nextCursor);
  assert.equal(next.accepted, 1);
  assert.equal(f.calls.at(-1).to, '+12065550113');
});

test('overlapping dispatches cannot obtain the active checkpoint lease or submit twice', async () => {
  const f = fixture(); await subscribe(f);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.send = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { messageSid: 'SM' + 'a'.repeat(32) }; };
  const active = f.service.dispatch();
  await started;
  await assert.rejects(f.service.dispatch(), e => e.status === 409 && /in progress/.test(e.message));
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await active).accepted, 1);
  assert.equal(checkpoint(f).leaseUntil, 0);
});

test('stale external revision tokens cannot rewind or skip server progress', async () => {
  const f = fixture(); await subscribe(f); await subscribe(f, 'z-next', '+12065550113');
  const first = await f.service.dispatch();
  const next = await f.service.dispatch(first.nextCursor);
  const saved = structuredClone(checkpoint(f));
  await assert.rejects(f.service.dispatch(first.nextCursor), e => e.status === 409);
  assert.deepEqual(checkpoint(f), saved);
  assert.match(next.nextCursor, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 2);
});

test('expired crashed-worker leases recover without enabling a retry while the lease is active', async () => {
  const f = fixture(); await subscribe(f);
  f.save({ id: checkpointId, userId: directory, type: 'messagingScheduleCheckpoint', schemaVersion: 1, date: dateKey(f.now()), cursor: 'a'.repeat(64), position: { afterId: null, owner: null, index: 0 }, lease: 'crashed', leaseUntil: f.now() + 90000 });
  await assert.rejects(f.service.dispatch(), e => e.status === 409);
  assert.equal(f.calls.length, 0);
  f.setTime(f.now() + 90001);
  assert.equal((await f.service.dispatch()).accepted, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(checkpoint(f).leaseUntil, 0);
});

test('a stale worker cannot overwrite a newer checkpoint after its provider POST finishes', async () => {
  const f = fixture(); await subscribe(f);
  f.send = async () => {
    f.save({ ...checkpoint(f), cursor: 'b'.repeat(64), position: { afterId: 'messaging-z-next', owner: null, index: 0 }, lease: 'new-worker', leaseUntil: f.now() + 90000 });
    return { messageSid: 'SM' + 'a'.repeat(32) };
  };
  await assert.rejects(f.service.dispatch(), e => e.status === 409);
  assert.equal(checkpoint(f).cursor, 'b'.repeat(64));
  assert.equal(checkpoint(f).position.afterId, 'messaging-z-next');
  assert.equal(checkpoint(f).lease, 'new-worker');
  assert.equal(f.calls.length, 1);
});

test('lost checkpoint acknowledgement cannot replay an accepted delivery or erase committed progress', async () => {
  const f = fixture(); await subscribe(f); await subscribe(f, 'z-next', '+12065550113');
  const originalItem = f.container.item;
  let fail = true;
  f.container.item = (id, owner) => {
    const item = originalItem(id, owner), replace = item.replace;
    item.replace = async (document, options) => {
      const result = await replace(document, options);
      if (fail && id === checkpointId && document.lease === null && document.position.afterId) { fail = false; throw error(500); }
      return result;
    };
    return item;
  };
  await assert.rejects(f.service.dispatch(), e => e.code === 500);
  assert.equal(checkpoint(f).position.afterId, 'messaging-owner');
  assert.equal(checkpoint(f).leaseUntil, 0);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.dispatch()).accepted, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).to, '+12065550113');
});

test('checkpoint storage failure before acquisition fails closed without provider calls', async () => {
  const f = fixture(); await subscribe(f);
  const originalCreate = f.container.items.create;
  f.container.items.create = async document => { if (document.id === checkpointId) throw error(500); return originalCreate(document); };
  await assert.rejects(f.service.dispatch(), e => e.code === 500);
  assert.equal(f.calls.length, 0);
});

test('a new Pacific date starts a fresh scan instead of skipping an owner from yesterday', async () => {
  const f = fixture(); await subscribe(f);
  f.save({ id: checkpointId, userId: directory, type: 'messagingScheduleCheckpoint', schemaVersion: 1, date: '2026-10-21', cursor: 'a'.repeat(64), position: { afterId: 'messaging-z-last', owner: null, index: 0 }, lease: null, leaseUntil: 0 });
  assert.equal((await f.service.dispatch()).accepted, 1);
  assert.equal(checkpoint(f).date, '2026-10-22');
  assert.equal(f.calls.length, 1);
});

test('malformed checkpoint and caller-controlled owner cursors fail closed', async () => {
  const f = fixture(); await subscribe(f);
  await assert.rejects(f.service.dispatch(Buffer.from(JSON.stringify({ owner: 'owner', index: 1 })).toString('base64url')), e => e.status === 400);
  f.save({ id: checkpointId, userId: directory, type: 'messagingScheduleCheckpoint', date: dateKey(f.now()), cursor: 'a'.repeat(64), position: { afterId: null, owner: '../owner', index: 1 }, leaseUntil: 0 });
  await assert.rejects(f.service.dispatch(), e => e.status === 503);
  assert.equal(f.calls.length, 0);
});
