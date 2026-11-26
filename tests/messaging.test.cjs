'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/messaging-fixture.cjs');
const { createMessagingDispatchHandler } = require('../api/messaging-dispatch');
const { pruneMessaging, exportMessaging, minuteOfDay } = require('../api/shared/messaging');
const { dateKey } = require('../api/shared/access');

test('messaging is available on Free but owner-checked and never trusts arbitrary recipients/content', async () => {
  const f = fixture();
  assert.equal((await f.call()).status, 200);
  assert.equal((await f.call('GET', null, 'owner', { headers: { 'x-ms-client-principal': '' } })).status, 401);
  assert.equal((await f.call('GET', null, 'owner', { headers: { 'x-farmer-account-id': 'other' } })).status, 409);
  assert.equal((await f.call('POST', { action: 'sendBrief', channel: 'sms', approved: true, to: '+12065550199' })).status, 400);
  assert.equal((await f.call('POST', { action: 'sendBrief', channel: 'sms', approved: true, body: 'Spam' })).status, 400);
  assert.equal((await f.call('POST', { action: 'sendBrief', channel: 'sms', approved: false })).status, 400);
  assert.equal((await f.call('POST', { action: 'stop', channel: 'sms' }, 'owner', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(f.calls.length, 0);
});
test('legacy preferences do not verify a recipient; explicit verification encrypts number and only matching inbound JOIN works', async () => {
  const f = fixture();
  await assert.rejects(f.service.beginVerification('owner', 'sms', '+12065550111', false), /Agree/);
  await assert.rejects(f.service.beginVerification('owner', 'sms', '2065550111', true), /country/);
  await f.service.beginVerification('owner', 'sms', '+12065550111', true);
  let view = await f.service.view('owner'); assert.equal(view.channels[0].verified, false);
  const command = view.channels[0].verification.command;
  await f.service.inbound({ From: '+12065550199', Body: command, MessageSid: 'SM' + '1'.repeat(32) });
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
  await f.service.inbound({ From: '+12065550111', Body: command, MessageSid: 'SM' + '2'.repeat(32) });
  view = await f.service.view('owner'); assert.equal(view.channels[0].verified, true); assert.equal(view.channels[0].dailyEnabled, false);
  assert.doesNotMatch(JSON.stringify([...f.docs.values()]), /\+12065550111/);
  assert.doesNotMatch(JSON.stringify(view), /pending|recipientHash|secret|TWILIO_AUTH_TOKEN|\+12065550111/);
  assert.equal(f.calls.length, 0);
});
test('verification expires, rate limit is bounded, and configuration off never sends', async () => {
  const f = fixture(); await f.service.beginVerification('owner', 'sms', '+12065550111', true);
  const command = (await f.service.view('owner')).channels[0].verification.command;
  f.setTime(f.now() + 31 * 60000);
  await f.service.inbound({ From: '+12065550111', Body: command, MessageSid: 'SM' + '1'.repeat(32) });
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
  for (let i = 0; i < 5; i++) await f.service.beginVerification('owner', 'sms', '+12065550111', true);
  await assert.rejects(f.service.beginVerification('owner', 'sms', '+12065550111', true), error => error.status === 429);
  f.env.MESSAGING_ENABLED = 'false';
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /setup/);
  assert.equal(f.calls.length, 0);
});
test('manual sends use saved brief and verified number exactly once per channel/date across concurrent calls', async () => {
  const f = fixture(); await f.verify();
  const results = await Promise.allSettled([f.service.sendBrief('owner', 'sms'), f.service.sendBrief('owner', 'sms')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].to, '+12065550111'); assert.match(f.calls[0].body, /8 mph/); assert.match(f.calls[0].body, /STOP/);
  assert.equal((await f.service.view('owner')).deliveries[0].status, 'accepted');
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /already attempted/);
});
test('provider acceptance never claims delivered; signed callback model updates matching dispatch only', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const doc = [...f.docs.values()].find(x => x.type === 'messagingDelivery');
  await f.service.status({ To: '+12065550199', MessageSid: doc.messageSid, MessageStatus: 'delivered' }, doc.dispatchId);
  assert.equal((await f.service.view('owner')).deliveries[0].status, 'accepted');
  await f.service.status({ To: '+12065550111', MessageSid: doc.messageSid, MessageStatus: 'delivered' }, doc.dispatchId);
  await f.service.status({ To: '+12065550111', MessageSid: doc.messageSid, MessageStatus: 'sent' }, doc.dispatchId);
  assert.equal((await f.service.view('owner')).deliveries[0].status, 'delivered');
});
test('callback arriving during provider POST is retained, not downgraded to accepted', async () => {
  const f = fixture(); await f.verify();
  f.send = async message => { await f.service.status({ To: message.to, MessageSid: 'SM' + '7'.repeat(32), MessageStatus: 'delivered' }, message.dispatchId); return { messageSid: 'SM' + '7'.repeat(32) }; };
  await f.service.sendBrief('owner', 'sms'); assert.equal((await f.service.view('owner')).deliveries[0].status, 'delivered');
});
test('ambiguous provider timeout remains unknown and cannot be resent; budget counts it', async () => {
  const f = fixture(); await f.verify(); f.send = async () => { throw new Error('PRIVATE PROVIDER DATA'); };
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /uncertain/);
  assert.equal((await f.service.view('owner')).deliveries[0].status, 'unknown');
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /already attempted/); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(await f.service.view('owner')), /PRIVATE PROVIDER/);
});
test('global budget bounds calls across owners; rejected attempts are not retried', async () => {
  const f = fixture({ env: { MESSAGING_DAILY_LIMIT: '1' } }); await f.verify(); await f.service.sendBrief('owner', 'sms');
  f.seed('other'); await f.verify('sms', '+12065550112', 'other');
  await assert.rejects(f.service.sendBrief('other', 'sms'), error => error.status === 429); assert.equal(f.calls.length, 1);
});
test('STOP works with provider disabled and START does not silently re-enable consent', async () => {
  const f = fixture(); await f.verify(); await f.service.savePreferences('owner', 'sms', true, '06:30', true);
  f.env.MESSAGING_ENABLED = 'false';
  await f.service.inbound({ From: '+12065550111', Body: 'STOP', MessageSid: 'SM' + '8'.repeat(32) });
  await f.service.inbound({ From: '+12065550111', Body: 'START', MessageSid: 'SM' + '9'.repeat(32) });
  const view = await f.service.view('owner'); assert.equal(view.channels[0].verified, false); assert.equal(view.channels[0].dailyEnabled, false);
});
test('sandbox verification is configured without a template and send uses trusted timestamp only', async () => {
  const f = fixture({ env: { MESSAGING_WHATSAPP_SANDBOX: 'true', TWILIO_WHATSAPP_CONTENT_SID: '' } }); await f.verify('whatsapp');
  await f.service.sendBrief('owner', 'whatsapp');
  assert.equal(f.calls[0].purpose, 'test'); assert.equal(typeof f.calls[0].lastVerifiedInboundAt, 'number');
  assert.equal((await f.service.view('owner')).channels[1].mode, 'sandbox');
});
test('scheduled send generates through internal owner service, honors Pacific time and avoids duplicate daily sends', async () => {
  const f = fixture(); await f.verify(); await f.service.savePreferences('owner', 'sms', true, '06:30', true);
  let result = await f.service.dispatch(); assert.equal(result.accepted, 1); assert.equal(f.prepared, 1);
  result = await f.service.dispatch(); assert.equal(result.accepted, 0); assert.equal(f.calls.length, 1);
  assert.equal(minuteOfDay(Date.parse('2026-11-01T08:30:00Z')), 90); assert.equal(minuteOfDay(Date.parse('2026-11-01T09:30:00Z')), 90);
  assert.equal(dateKey(Date.parse('2026-11-01T08:30:00Z')), dateKey(Date.parse('2026-11-01T09:30:00Z')));
});
test('scheduled sandbox, early/late schedule, missing profile or missing current brief do not send', async () => {
  const f = fixture(); await f.verify(); await f.service.savePreferences('owner', 'sms', true, '09:00', true);
  assert.equal((await f.service.dispatch()).accepted, 0);
  await f.service.savePreferences('owner', 'sms', true, '01:00', true); assert.equal((await f.service.dispatch()).accepted, 0);
  f.docs.delete(f.key('brief-owner-' + dateKey(f.now()), 'owner')); await assert.rejects(f.service.sendBrief('owner', 'sms'), /Prepare/);
  f.docs.delete(f.key('state-owner', 'owner')); await assert.rejects(f.service.sendBrief('owner', 'sms'), /profile/);
  assert.equal(f.calls.length, 0);
});
test('export omits secrets; deleting own data removes verification but preserves attempt quota', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms'); f.seed('other'); await f.verify('sms', '+12065550112', 'other');
  const exported = await exportMessaging(f.container, 'owner'); assert.equal(exported.channels[0].verifiedAt !== null, true);
  assert.doesNotMatch(JSON.stringify(exported), /secret|hash|JOIN|\+12065550111/);
  f.docs.delete(f.key('state-owner', 'owner')); await pruneMessaging(f.container, 'owner');
  assert.equal(f.docs.has(f.key('messaging-owner', 'owner')), false); assert.equal(f.docs.has(f.key('messaging-other', 'other')), true);
  const delivery = [...f.docs.values()].find(x => x.type === 'messagingDelivery'); assert.equal(delivery.status, 'cancelled'); assert.equal(delivery.dispatchId, undefined);
});
test('scheduler endpoint refuses missing secret, browser requests, arbitrary owners and disabled scheduling', async () => {
  const f = fixture(), handler = createMessagingDispatchHandler({ env: f.env, service: f.service });
  async function invoke(headers = {}, body = {}) { const ctx = {}; await handler(ctx, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }); return ctx.res; }
  assert.equal((await invoke()).status, 403);
  const auth = { 'x-farmer-messaging-key': f.env.MESSAGING_DISPATCH_KEY };
  assert.equal((await invoke({ ...auth, origin: f.env.APP_ORIGIN })).status, 403);
  assert.equal((await invoke(auth, { owner: 'someone' })).status, 400);
  f.env.MESSAGING_SCHEDULER_ENABLED = 'false'; assert.equal((await invoke(auth)).status, 503);
  assert.equal(f.calls.length, 0);
});
