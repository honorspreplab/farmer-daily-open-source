'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/messaging-fixture.cjs');
const { dateKey } = require('../api/shared/access');

async function token(f, owner = 'owner', channel = 'sms') {
  const result = await f.call('GET', undefined, owner);
  assert.equal(result.status, 200);
  return result.body.channels.find(item => item.id === channel).approvalToken;
}
async function send(f, approvalToken, owner = 'owner', channel = 'sms') {
  return f.call('POST', { action: 'sendBrief', channel, approved: true, approvalToken }, owner);
}

test('manual send needs a current server approval token; matching token submits once', async () => {
  const f = fixture();
  assert.equal(await token(f), null);
  await f.verify();
  assert.equal((await send(f, undefined)).status, 409);
  assert.equal((await send(f, 'forged')).status, 409);
  const approved = await token(f);
  assert.match(approved, /^\d{13}\.[a-f0-9]{64}$/);
  assert.equal((await send(f, approved.slice(0, -1) + (approved.endsWith('0') ? '1' : '0'))).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await send(f, approved)).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal((await send(f, approved)).status, 409);
  assert.equal(f.calls.length, 1);
});

test('refreshing the brief invalidates an earlier approval without consuming the daily attempt', async () => {
  const f = fixture(); await f.verify();
  const approved = await token(f);
  const brief = f.docs.get(f.key(`brief-owner-${dateKey(f.now())}`, 'owner'));
  f.save({ ...brief, brief: { ...brief.brief, advisories: [{ fieldName: 'Changed field', whatChanged: 'A different reviewed priority.' }] } });
  assert.equal((await send(f, approved)).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.docs.has(f.key(`message-owner-sms-${dateKey(f.now())}`, 'owner')), false);
  assert.equal((await send(f, await token(f))).status, 200);
  assert.match(f.calls[0].body, /different reviewed priority/);
});

test('approval binds owner, channel and fresh recipient verification', async () => {
  const f = fixture(); await f.verify();
  f.seed('other'); await f.verify('sms', '+12065550112', 'other');
  await f.verify('whatsapp', '+12065550111');
  const approved = await token(f);
  assert.equal((await send(f, approved, 'other')).status, 409);
  assert.equal((await send(f, approved, 'owner', 'whatsapp')).status, 409);
  await f.service.stop('owner', 'sms');
  await f.verify('sms', '+12065550113');
  assert.equal((await send(f, approved)).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await send(f, await token(f))).status, 200);
  assert.equal(f.calls[0].to, '+12065550113');
});

test('approval expires after fifteen minutes and is not exported or persisted', async () => {
  const f = fixture(); await f.verify();
  const approved = await token(f);
  assert.equal(JSON.stringify([...f.docs.values()]).includes(approved), false);
  const { exportMessaging } = require('../api/shared/messaging');
  assert.equal(JSON.stringify(await exportMessaging(f.container, 'owner')).includes(approved), false);
  f.setTime(f.now() + 15 * 60000);
  assert.equal((await send(f, approved)).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await send(f, await token(f))).status, 200);
});

test('changed provider sender or WhatsApp template requires a newly reviewed approval', async () => {
  const f = fixture(); await f.verify('whatsapp');
  const approved = await token(f, 'owner', 'whatsapp');
  f.env.TWILIO_WHATSAPP_CONTENT_SID = 'HX' + 'd'.repeat(32);
  assert.equal((await send(f, approved, 'owner', 'whatsapp')).status, 409);
  const next = await token(f, 'owner', 'whatsapp');
  f.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+12065550115';
  assert.equal((await send(f, next, 'owner', 'whatsapp')).status, 409);
  assert.equal(f.calls.length, 0);
});
