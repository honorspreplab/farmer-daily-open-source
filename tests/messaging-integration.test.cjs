'use strict';

// Full application -> transport -> signed webhook integration. HTTP and Cosmos
// are replaced only at their outer boundaries; no real messages or data leave.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/messaging-fixture.cjs');
const { createMessagingService } = require('../api/shared/messaging');
const { createMessagingHandler } = require('../api/messaging');
const { createMessagingWebhookHandler } = require('../api/messaging-webhook');
const { createMessagingDispatchHandler } = require('../api/messaging-dispatch');
const { dateKey } = require('../api/shared/access');

function integration(options = {}) {
  const f = fixture(options), requests = [];
  let serial = 1000, prepared = 0;
  const sid = () => `SM${String(++serial).padStart(32, '0')}`;
  const fetchImpl = async (url, request) => {
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${f.env.TWILIO_ACCOUNT_SID}/Messages.json`);
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    const form = new URLSearchParams(request.body), messageSid = sid();
    const capture = { url, request, form, messageSid };
    requests.push(capture);
    if (f.failAfterSubmit) throw new Error('Synthetic lost provider response');
    return new Response(JSON.stringify({ sid: messageSid, account_sid: f.env.TWILIO_ACCOUNT_SID, from: form.get('From'), to: form.get('To'), status: 'queued' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  // Deliberately omit `transport`: exercise the real provider adapter, not the
  // helper fixture's stub transport, with only fetch mocked at the network edge.
  const service = createMessagingService({ getContainer: () => f.container, env: f.env, now: f.now, fetchImpl, briefHandler: { async forOwner(owner) { prepared++; return f.docs.get(f.key(`brief-${owner}-${dateKey(f.now())}`, owner))?.brief; } } });
  const handler = createMessagingHandler({ getContainer: () => f.container, env: f.env, now: f.now, service });
  const webhook = createMessagingWebhookHandler({ env: f.env, service });
  const dispatch = createMessagingDispatchHandler({ env: f.env, service });
  const context = () => ({ log: { error() {} } });
  async function call(body, owner = 'owner') {
    const ctx = context();
    const principal = { userId: owner, userDetails: `${owner}@example.test`, identityProvider: 'aad', userRoles: ['authenticated'] };
    await handler(ctx, { method: body ? 'POST' : 'GET', body, headers: { 'content-type': 'application/json', 'x-farmer-account-id': owner, 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64') } });
    return ctx.res;
  }
  async function callback(kind, params, url = `${f.env.APP_ORIGIN}/api/messaging-webhook/${kind}`) {
    const input = url + Object.keys(params).sort().map(key => key + params[key]).join('');
    const ctx = context();
    await webhook(ctx, { method: 'POST', params: { kind }, url, query: Object.fromEntries(new URL(url).searchParams), rawBody: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': crypto.createHmac('sha1', f.env.TWILIO_AUTH_TOKEN).update(input).digest('base64') } });
    return ctx.res;
  }
  function inboundFields(channel, phone, body) {
    return { AccountSid: f.env.TWILIO_ACCOUNT_SID, MessageSid: sid(), SmsStatus: 'received', From: channel === 'whatsapp' ? `whatsapp:${phone}` : phone, To: channel === 'whatsapp' ? f.env.TWILIO_WHATSAPP_FROM : f.env.TWILIO_SMS_FROM, Body: body };
  }
  async function verify(channel, phone, owner = 'owner') {
    const started = await call({ action: 'beginVerification', channel, phone, consent: true }, owner);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const row = started.body.channels.find(item => item.id === channel);
    assert.equal(row.verified, false); assert.match(row.verification.command, /^JOIN [0-9a-f]{32}$/);
    const accepted = await callback('inbound', inboundFields(channel, phone, row.verification.command));
    assert.equal(accepted.status, 200); assert.equal(accepted.body, '<Response/>');
    const view = await call(undefined, owner);
    assert.equal(view.body.channels.find(item => item.id === channel).verified, true);
  }
  async function status(capture, state, patch = {}) {
    return callback('status', { AccountSid: f.env.TWILIO_ACCOUNT_SID, MessageSid: capture.messageSid, MessageStatus: state, From: capture.form.get('From'), To: capture.form.get('To'), ...patch }, capture.form.get('StatusCallback'));
  }
  return { ...f, service, handler, webhook, dispatch, requests, call, callback, inboundFields, verify, status, setFailAfterSubmit: value => { f.failAfterSubmit = value; }, prepared: () => prepared };
}

test('SMS full chain verifies own number, sends encoded brief, records delivery and honors signed STOP', async () => {
  const f = integration(), phone = '+12065550111';
  await f.verify('sms', phone);
  assert.equal(f.requests.length, 0, 'JOIN verification must never send an outbound SMS');
  assert.equal((await f.call({ action: 'sendBrief', channel: 'sms', approved: false })).status, 400);
  assert.equal((await f.call({ action: 'sendBrief', channel: 'sms', approved: true })).status, 409, 'manual sends require the reviewed preview token');
  assert.equal(f.requests.length, 0);
  const approvalToken = (await f.call()).body.channels.find(item => item.id === 'sms').approvalToken;
  const result = await f.call({ action: 'sendBrief', channel: 'sms', approved: true, approvalToken });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.deliveries[0].status, 'accepted');
  assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0, 'real adapter, not helper stub, must be exercised');
  const sent = f.requests[0], form = sent.form;
  assert.equal(sent.request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form.get('To'), phone); assert.equal(form.get('From'), f.env.TWILIO_SMS_FROM);
  assert.match(form.get('Body'), /Farmer Daily 2026-10-22: Test block: Wind forecast changed to 8 mph\./);
  assert.match(form.get('Body'), /Reply STOP to unsubscribe\./);
  assert.equal(form.has('ContentSid'), false);
  assert.match(form.get('StatusCallback'), /\/api\/messaging-webhook\/status\?dispatch=[0-9a-f]{64}$/);
  assert.equal((await f.status(sent, 'delivered')).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'delivered');
  assert.equal((await f.status(sent, 'queued')).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'delivered', 'late queued callback must not regress receipt');
  const stop = await f.callback('inbound', { ...f.inboundFields('sms', phone, 'STOP'), OptOutType: 'STOP' });
  assert.equal(stop.status, 200); assert.equal(stop.body, '<Response/>');
  const stopped = (await f.call()).body.channels.find(item => item.id === 'sms');
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.verified, false); assert.equal(stopped.dailyEnabled, false);
  assert.equal((await f.call({ action: 'sendBrief', channel: 'sms', approved: true, approvalToken })).status, 409);
  assert.equal(f.requests.length, 1, 'STOP and duplicate attempts cannot trigger additional provider POSTs');
});

test('sandbox WhatsApp full chain converts verified inbound time and sends only a manual in-window test', async () => {
  const f = integration({ env: { MESSAGING_WHATSAPP_SANDBOX: 'true', TWILIO_WHATSAPP_CONTENT_SID: '' } });
  await f.verify('whatsapp', '+12065550112');
  f.setTime(f.now() + 60000);
  const approvalToken = (await f.call()).body.channels.find(item => item.id === 'whatsapp').approvalToken;
  const result = await f.call({ action: 'sendBrief', channel: 'whatsapp', approved: true, approvalToken });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].form.get('To'), 'whatsapp:+12065550112');
  assert.ok(f.requests[0].form.get('Body'));
  assert.equal(f.requests[0].form.has('ContentSid'), false);
  assert.equal(result.body.deliveries[0].status, 'accepted');
  assert.equal((await f.status(f.requests[0], 'read')).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'read');
  // Test validates Date.parse(lastInboundAt): the real adapter rejects an ISO
  // string, so bypassing conversion in the service would fail before fetch.
  assert.equal(typeof f.docs.get(f.key('messaging-owner', 'owner')).channels.whatsapp.lastInboundAt, 'string');
});

test('real scheduler runner follows opaque dual-channel cursors with at most one provider POST per invocation', async () => {
  const f = integration();
  f.seed('second');
  for (const [owner, channel, phone] of [['owner', 'sms', '+12065550111'], ['owner', 'whatsapp', '+12065550112'], ['second', 'sms', '+12065550113']]) {
    await f.verify(channel, phone, owner);
    const preferences = await f.call({ action: 'savePreferences', channel, dailyEnabled: true, briefTime: '06:30', consent: true }, owner);
    assert.equal(preferences.status, 200, JSON.stringify(preferences.body));
  }
  const { runMessagingSchedule } = await import('../scripts/run-messaging-schedule.mjs');
  const pages = [];
  const outcome = await runMessagingSchedule({ env: { ...f.env, FARMER_MESSAGING_SCHEDULE_ENABLED: 'true' }, now: f.now, fetchImpl: async (url, options) => {
    assert.equal(url, `${f.env.APP_ORIGIN}/api/messaging-dispatch`);
    const before = f.requests.length, body = JSON.parse(options.body), ctx = { log: { error() {} } };
    if (body.cursor) assert.match(body.cursor, /^[A-Za-z0-9_-]+$/);
    await f.dispatch(ctx, { method: options.method, body, headers: options.headers });
    assert.equal(ctx.res.status, 200, JSON.stringify(ctx.res.body));
    assert.ok(f.requests.length - before <= 1, 'one managed HTTP invocation must never issue two transport POSTs');
    pages.push({ requestCursor: body.cursor, response: ctx.res.body });
    return new Response(JSON.stringify(ctx.res.body), { status: ctx.res.status, headers: ctx.res.headers });
  } });
  assert.equal(outcome.complete, true); assert.equal(outcome.accepted, 3); assert.equal(outcome.failed, 0);
  assert.equal(f.requests.length, 3); assert.equal(f.prepared(), 3);
  assert.equal(pages.length, 4, 'three one-POST pages are followed by a bounded end-of-scan query');
  assert.match(pages[0].response.nextCursor, /^[a-f0-9]{64}$/, 'external cursors are opaque server-checkpoint revisions, not caller-controlled row positions');
  assert.equal(pages[1].requestCursor, pages[0].response.nextCursor);
  assert.equal(pages.at(-1).response.nextCursor, null);
  const whatsapp = f.requests.find(item => item.form.get('To').startsWith('whatsapp:'));
  assert.equal(whatsapp.form.get('ContentSid'), f.env.TWILIO_WHATSAPP_CONTENT_SID);
  assert.equal(whatsapp.form.has('Body'), false);
  const variables = JSON.parse(whatsapp.form.get('ContentVariables'));
  assert.equal(variables['1'], '2026-10-22'); assert.match(variables['2'], /Wind forecast changed/); assert.equal(variables['3'], `${f.env.APP_ORIGIN}/`);
  const replay = await f.service.dispatch();
  assert.equal(replay.accepted, 0); assert.equal(f.requests.length, 3, 'a repeated scheduler pass must not resend an attempted day');
});

test('ambiguous real transport result is not retried and a later signed receipt reconciles only its original recipient', async () => {
  const f = integration();
  await f.verify('sms', '+12065550111');
  f.setFailAfterSubmit(true);
  const approvalToken = (await f.call()).body.channels.find(item => item.id === 'sms').approvalToken;
  const result = await f.call({ action: 'sendBrief', channel: 'sms', approved: true, approvalToken });
  assert.equal(result.status, 409); assert.equal(f.requests.length, 1);
  assert.equal((await f.call()).body.deliveries[0].status, 'unknown');
  f.setFailAfterSubmit(false);
  assert.equal((await f.call({ action: 'sendBrief', channel: 'sms', approved: true, approvalToken })).status, 409);
  assert.equal(f.requests.length, 1);
  const sent = f.requests[0];
  assert.equal((await f.status(sent, 'delivered', { To: '+12065550199' })).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'unknown', 'signature alone cannot override the stored recipient binding');
  assert.equal((await f.status(sent, 'delivered')).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'delivered');
  assert.equal((await f.status(sent, 'read', { MessageSid: `SM${'f'.repeat(32)}` })).status, 204);
  assert.equal((await f.call()).body.deliveries[0].status, 'delivered', 'a different SID cannot steal an already-bound dispatch');
  assert.equal(f.requests.length, 1);
});
