'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/messaging-fixture.cjs');
const { pruneMessaging } = require('../api/shared/messaging');
const { createStateHandler } = require('../api/state');
const { createMessagingWebhookHandler } = require('../api/messaging-webhook');
const DIRECTORY = 'messaging-directory';
const phone = '+12065550111';
const sid = digit => 'SM' + digit.repeat(32);
const settings = (f, owner = 'owner') => f.docs.get(f.key(`messaging-${owner}`, owner));
const bindings = f => [...f.docs.values()].filter(d => d.type === 'messagingRecipient');
const delivery = f => [...f.docs.values()].find(d => d.type === 'messagingDelivery');
const stopMessage = digit => ({ From: phone, Body: 'STOP', MessageSid: sid(digit) });
const storageError = code => Object.assign(new Error('Synthetic private storage detail'), { code });

test('persisted unfinished STOP claims block manual and scheduled sends even after provider retries end', async () => {
  for (const scheduled of [false, true]) for (const status of ['processing', 'pending']) {
    const f = fixture(); await f.verify();
    await f.service.savePreferences('owner', 'sms', true, '06:30', true);
    const generation = settings(f).channels.sms.bindingGeneration;
    for (const digit of ['a', 'b']) f.save({ id: `inbound-${digit.repeat(64)}`, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: generation, status, leaseUntil: f.now() - 1 });
    const originalQuery = f.container.items.query; let checked = false;
    f.container.items.query = (spec, options) => {
      if (spec.parameters?.some(p => p.name === '@operation' && p.value === 'stop')) {
        checked = true; assert.match(spec.query, /SELECT TOP 1 c\.id/); assert.equal(options.maxItemCount, 1); assert.equal(options.partitionKey, DIRECTORY);
      }
      return originalQuery(spec, options);
    };
    await assert.rejects(f.service.sendBrief('owner', 'sms', { scheduled }), error => error.status === 409 && /STOP/.test(error.message));
    assert.equal(checked, true); assert.equal(f.calls.length, 0); assert.equal(delivery(f), undefined);
  }
});

test('a STOP claim persisted during the final consent transaction prevents the provider POST', async () => {
  const f = fixture(); await f.verify();
  f.beforeBatch = async operations => {
    const last = operations.at(-1);
    if (last.operationType === 'Replace' && last.resourceBody.type === 'messagingDelivery' && operations.length > 1) {
      f.beforeBatch = null;
      f.save({ id: `inbound-${'a'.repeat(64)}`, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: settings(f).channels.sms.bindingGeneration, status: 'processing', leaseUntil: f.now() + 120000 });
    }
  };
  await assert.rejects(f.service.sendBrief('owner', 'sms'), error => error.status === 409 && /STOP/.test(error.message));
  assert.equal(f.calls.length, 0); assert.equal(delivery(f).status, 'failed');
});

test('old-generation or other-channel STOP receipts never block newly verified consent', async () => {
  const f = fixture(); await f.verify();
  const oldGeneration = settings(f).channels.sms.bindingGeneration;
  f.save({ id: `inbound-${'a'.repeat(64)}`, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: oldGeneration, status: 'processing', leaseUntil: f.now() + 120000 });
  await f.service.stop('owner', 'sms'); await f.verify();
  const generation = settings(f).channels.sms.bindingGeneration;
  assert.notEqual(generation, oldGeneration);
  f.save({ id: `inbound-${'b'.repeat(64)}`, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'whatsapp', targetGeneration: generation, status: 'pending', leaseUntil: 0 });
  await f.service.sendBrief('owner', 'sms');
  assert.equal(f.calls.length, 1); assert.equal(delivery(f).status, 'accepted');
});

test('failed or malformed STOP existence checks fail closed before any provider submission', async () => {
  for (const failureAt of [1, 2]) for (const malformed of [false, true]) {
    const f = fixture(); await f.verify();
    const originalQuery = f.container.items.query; let checks = 0;
    f.container.items.query = (spec, options) => {
      if (spec.parameters?.some(p => p.name === '@operation' && p.value === 'stop') && ++checks === failureAt) return { async fetchAll() { if (malformed) return {}; throw storageError(503); } };
      return originalQuery(spec, options);
    };
    await assert.rejects(f.service.sendBrief('owner', 'sms'));
    assert.equal(f.calls.length, 0); assert.equal(checks, failureAt);
    if (failureAt === 2) assert.equal(delivery(f).status, 'failed');
  }
});

test('a crashed in-progress STOP is never acknowledged until completed and can recover after its lease', async () => {
  const f = fixture(); await f.verify();
  const message = stopMessage('e'), receiptId = `inbound-${crypto.createHash('sha256').update(message.MessageSid).digest('hex')}`;
  f.save({ id: receiptId, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: settings(f).channels.sms.bindingGeneration, status: 'processing', leaseUntil: f.now() + 120000 });
  await assert.rejects(f.service.inbound(message), error => error.status === 503);
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(f.docs.get(f.key(receiptId, DIRECTORY)).status, 'processing');
  f.setTime(f.now() + 120001);
  await f.service.inbound(message);
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
  assert.equal(f.docs.get(f.key(receiptId, DIRECTORY)).status, 'completed');
  await f.service.inbound(message);
  assert.equal(f.calls.length, 0);
});

test('inbound receipt create and lease-claim races stay retryable instead of acknowledging unapplied STOP', async () => {
  for (const race of ['create', 'replace']) {
    const f = fixture(); await f.verify();
    const message = stopMessage('e'), receiptId = `inbound-${crypto.createHash('sha256').update(message.MessageSid).digest('hex')}`;
    const receipt = { id: receiptId, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: settings(f).channels.sms.bindingGeneration, status: 'pending', leaseUntil: 0 };
    if (race === 'create') {
      const original = f.container.items.create;
      f.container.items.create = async doc => { if (doc.id === receiptId) { f.container.items.create = original; f.save(receipt); throw storageError(409); } return original(doc); };
    } else {
      f.save(receipt);
      const original = f.container.item;
      f.container.item = (id, owner) => {
        const item = original(id, owner);
        if (id === receiptId) item.replace = async () => { f.container.item = original; throw storageError(412); };
        return item;
      };
    }
    await assert.rejects(f.service.inbound(message), error => error.status === 503, race);
    assert.equal((await f.service.view('owner')).channels[0].verified, true);
    await f.service.inbound(message);
    assert.equal((await f.service.view('owner')).channels[0].verified, false);
    assert.equal(f.docs.get(f.key(receiptId, DIRECTORY)).status, 'completed');
  }
});

test('concurrent sent and delivered receipts retain the final delivery upgrade', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const sent = delivery(f), params = { To: phone, MessageSid: sent.messageSid };
  await Promise.all([
    f.service.status({ ...params, MessageStatus: 'sent' }, sent.dispatchId),
    f.service.status({ ...params, MessageStatus: 'delivered' }, sent.dispatchId)
  ]);
  assert.equal(delivery(f).status, 'delivered');
  await Promise.all([
    f.service.status({ ...params, MessageStatus: 'read' }, sent.dispatchId),
    f.service.status({ ...params, MessageStatus: 'queued' }, sent.dispatchId)
  ]);
  assert.equal(delivery(f).status, 'read');
  assert.equal(f.calls.length, 1, 'receipt persistence retries never resend messages');
});

test('persistent receipt storage contention returns 503 and a later retry can finish the upgrade', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const sent = delivery(f), original = f.container.items.batch; let races = 0;
  f.container.items.batch = async (operations, owner) => {
    if (operations.at(-1).resourceBody.type === 'messagingDelivery') { races++; f.save({ ...delivery(f), updatedAt: new Date(f.now()).toISOString() }); }
    return original(operations, owner);
  };
  const params = { To: phone, MessageSid: sent.messageSid, MessageStatus: 'delivered' };
  await assert.rejects(f.service.status(params, sent.dispatchId), error => error.status === 503);
  assert.equal(races, 5); assert.equal(delivery(f).status, 'accepted');
  f.container.items.batch = original;
  await f.service.status(params, sent.dispatchId);
  assert.equal(delivery(f).status, 'delivered'); assert.equal(f.calls.length, 1);
});

test('deletion during a receipt CAS retry wins without recreating dispatch or recipient metadata', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const sent = delivery(f);
  f.beforeBatch = async operations => {
    if (operations.at(-1).resourceBody.type === 'messagingDelivery') { f.beforeBatch = null; await pruneMessaging(f.container, 'owner'); }
  };
  await f.service.status({ To: phone, MessageSid: sent.messageSid, MessageStatus: 'delivered' }, sent.dispatchId);
  assert.equal(delivery(f).status, 'cancelled'); assert.equal(delivery(f).dispatchId, undefined); assert.equal(delivery(f).recipientHash, undefined);
});

test('HTTP callbacks return 503 rather than acknowledgement for both unapplied STOP and unsaved delivery receipt', async () => {
  for (const kind of ['inbound', 'status']) {
    const f = fixture(); await f.verify();
    let params, url = `${f.env.APP_ORIGIN}/api/messaging-webhook/${kind}`;
    if (kind === 'inbound') {
      params = { AccountSid: f.env.TWILIO_ACCOUNT_SID, From: phone, To: f.env.TWILIO_SMS_FROM, MessageSid: sid('e'), SmsStatus: 'received', Body: 'STOP' };
      const receiptId = `inbound-${crypto.createHash('sha256').update(params.MessageSid).digest('hex')}`;
      f.save({ id: receiptId, userId: DIRECTORY, type: 'messagingInboundReceipt', operation: 'stop', channel: 'sms', targetGeneration: settings(f).channels.sms.bindingGeneration, status: 'processing', leaseUntil: f.now() + 120000 });
    } else {
      await f.service.sendBrief('owner', 'sms');
      const current = delivery(f);
      params = { AccountSid: f.env.TWILIO_ACCOUNT_SID, From: f.env.TWILIO_SMS_FROM, To: phone, MessageSid: current.messageSid, MessageStatus: 'delivered' };
      url += `?dispatch=${current.dispatchId}`;
      f.beforeBatch = async operations => { if (operations.at(-1).resourceBody.type === 'messagingDelivery') f.save({ ...delivery(f) }); };
    }
    const signature = crypto.createHmac('sha1', f.env.TWILIO_AUTH_TOKEN).update(url + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64');
    const req = { method: 'POST', params: { kind }, url, query: Object.fromEntries(new URL(url).searchParams), rawBody: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature } };
    const handler = createMessagingWebhookHandler({ env: f.env, service: f.service }), first = {};
    await handler(first, req);
    assert.equal(first.res.status, 503, kind);
    assert.deepEqual(first.res.body, { error: 'Messaging service temporarily unavailable.' });
    assert.match(first.res.headers['Cache-Control'], /no-store/);
    f.beforeBatch = null; f.setTime(f.now() + 120001);
    const retry = {}; await handler(retry, req);
    assert.equal(retry.res.status, kind === 'inbound' ? 200 : 204);
    if (kind === 'inbound') { assert.equal(retry.res.body, '<Response/>'); assert.equal((await f.service.view('owner')).channels[0].verified, false); }
    else assert.equal(delivery(f).status, 'delivered');
  }
});

test('failed JOIN owner transaction releases its own reservation and cannot survive farm deletion as an orphan', async () => {
  const f = fixture();
  await f.service.beginVerification('owner', 'sms', phone, true);
  const command = (await f.service.view('owner')).channels[0].verification.command;
  f.beforeBatch = async operations => {
    if (operations.at(-1).resourceBody?.channels?.sms?.verifiedAt) {
      f.beforeBatch = null;
      f.docs.delete(f.key('state-owner', 'owner'));
    }
  };
  await assert.rejects(f.service.inbound({ From: phone, Body: command, MessageSid: sid('a') }), error => error.status === 409);
  assert.equal(bindings(f).length, 0);
  assert.equal(settings(f).channels.sms.verifiedAt, undefined);
  await pruneMessaging(f.container, 'owner');
  assert.equal(settings(f), undefined);
});

test('a stop finishing its old reservation release cannot erase a concurrently reverified number', async () => {
  const f = fixture(); await f.verify();
  const originalGeneration = settings(f).channels.sms.bindingGeneration;
  f.beforeDelete = async (id, owner) => {
    if (owner === DIRECTORY && id.startsWith('recipient-')) {
      f.beforeDelete = null;
      await f.verify();
    }
  };
  await f.service.stop('owner', 'sms');
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(bindings(f).length, 1);
  assert.notEqual(bindings(f)[0].generation, originalGeneration);
  assert.equal(bindings(f)[0].generation, settings(f).channels.sms.bindingGeneration);
  await f.service.inbound(stopMessage('b'));
  assert.equal((await f.service.view('owner')).channels[0].verified, false, 'the new reservation remains discoverable by STOP');
  assert.equal(bindings(f).length, 0);
});

test('replaying a completed old STOP cannot unsubscribe a freshly verified connection', async () => {
  const f = fixture(); await f.verify();
  const message = stopMessage('a');
  await f.service.inbound(message);
  await f.verify();
  const freshGeneration = settings(f).channels.sms.bindingGeneration;
  await f.service.inbound(message);
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(settings(f).channels.sms.bindingGeneration, freshGeneration);
  const receipts = [...f.docs.values()].filter(d => d.type === 'messagingInboundReceipt');
  assert.ok(receipts.every(d => d.status === 'completed'));
  assert.doesNotMatch(JSON.stringify(receipts), /\+12065550111|JOIN|SMa{32}|"owner"|"Body"/);
  await f.service.inbound(stopMessage('b'));
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
});

test('retrying a partially completed STOP remains bound to the old verification generation', async () => {
  const f = fixture(); await f.verify();
  f.beforeDelete = async (id, owner) => {
    if (owner === DIRECTORY && id.startsWith('recipient-')) { f.beforeDelete = null; throw storageError(500); }
  };
  const message = stopMessage('a');
  await assert.rejects(f.service.inbound(message), error => error.code === 500);
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
  assert.equal(bindings(f).length, 1, 'failed cleanup retains only an encrypted-free reservation pointer');
  await f.verify();
  await f.service.inbound(message);
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(bindings(f)[0].generation, settings(f).channels.sms.bindingGeneration);
});

test('deletion retries redact delivery metadata even after settings were already removed', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const originalItem = f.container.item;
  let fail = true;
  f.container.item = (id, owner) => {
    const item = originalItem(id, owner), replace = item.replace;
    item.replace = async (value, options) => {
      if (fail && value.type === 'messagingDelivery') { fail = false; throw storageError(500); }
      return replace(value, options);
    };
    return item;
  };
  await assert.rejects(pruneMessaging(f.container, 'owner'), error => error.code === 500);
  assert.equal(settings(f), undefined);
  assert.ok(delivery(f).dispatchId);
  await pruneMessaging(f.container, 'owner');
  assert.equal(delivery(f).status, 'cancelled');
  assert.equal(delivery(f).dispatchId, undefined);
  assert.equal(delivery(f).recipientHash, undefined);
  assert.equal(delivery(f).messageSid, undefined);
});

test('deletion retries an ETag race with a late delivery callback and keeps its daily attempt marker', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  const originalItem = f.container.item;
  let race = true;
  f.container.item = (id, owner) => {
    const item = originalItem(id, owner), replace = item.replace;
    item.replace = async (value, options) => {
      if (race && value.type === 'messagingDelivery') { race = false; f.save({ ...delivery(f), status: 'delivered' }); }
      return replace(value, options);
    };
    return item;
  };
  await pruneMessaging(f.container, 'owner');
  assert.equal(delivery(f).status, 'cancelled');
  assert.equal(delivery(f).recipientHash, undefined);
  await f.verify();
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /already attempted/);
  assert.equal(f.calls.length, 1);
});

test('deletion reclaims only this owner orphan reservations even when settings do not exist', async () => {
  const f = fixture();
  f.save({ id: 'recipient-sms-orphan-owner', userId: DIRECTORY, type: 'messagingRecipient', owner: 'owner', channel: 'sms', generation: 'old' });
  f.save({ id: 'recipient-sms-orphan-other', userId: DIRECTORY, type: 'messagingRecipient', owner: 'other', channel: 'sms', generation: 'other' });
  await pruneMessaging(f.container, 'owner');
  assert.deepEqual(bindings(f).map(d => d.owner), ['other']);
});

test('a lost recipient reservation before final send prevents contacting the provider', async () => {
  const f = fixture(); await f.verify();
  f.beforeBatch = async operations => {
    if (operations.at(-1).operationType === 'Create' && operations.at(-1).resourceBody.type === 'messagingDelivery') {
      f.beforeBatch = null;
      for (const binding of bindings(f)) f.docs.delete(f.key(binding.id, DIRECTORY));
    }
  };
  await assert.rejects(f.service.sendBrief('owner', 'sms'), /verification changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(delivery(f).status, 'failed');
});

test('independent concurrent owners cannot exceed the shared daily provider-call cap', async () => {
  const f = fixture({ env: { MESSAGING_DAILY_LIMIT: '1' } });
  await f.verify(); f.seed('other'); await f.verify('sms', '+12065550112', 'other');
  const results = await Promise.allSettled([f.service.sendBrief('owner', 'sms'), f.service.sendBrief('other', 'sms')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal([...f.docs.values()].find(d => d.type === 'messagingBudget').count, 1);
});

test('parallel copies of a JOIN challenge preserve the winning binding and cannot attach to another owner', async () => {
  const f = fixture();
  await f.service.beginVerification('owner', 'sms', phone, true);
  const command = (await f.service.view('owner')).channels[0].verification.command;
  await Promise.allSettled([
    f.service.inbound({ From: phone, Body: command, MessageSid: sid('a') }),
    f.service.inbound({ From: phone, Body: command, MessageSid: sid('b') })
  ]);
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(bindings(f).length, 1);
  assert.equal(bindings(f)[0].generation, settings(f).channels.sms.bindingGeneration);
  f.seed('other'); await f.verify('sms', phone, 'other');
  assert.equal((await f.service.view('other')).channels[0].verified, false);
  assert.equal(bindings(f)[0].owner, 'owner');
});

test('lost database acknowledgement after a successful JOIN does not release its committed binding', async () => {
  const f = fixture();
  await f.service.beginVerification('owner', 'sms', phone, true);
  const command = (await f.service.view('owner')).channels[0].verification.command;
  const originalBatch = f.container.items.batch;
  let fail = true;
  f.container.items.batch = async (operations, owner) => {
    const result = await originalBatch(operations, owner);
    if (fail && operations.at(-1).resourceBody.channels?.sms?.verifiedAt) { fail = false; throw storageError(500); }
    return result;
  };
  await f.service.inbound({ From: phone, Body: command, MessageSid: sid('a') });
  assert.equal((await f.service.view('owner')).channels[0].verified, true);
  assert.equal(bindings(f)[0].generation, settings(f).channels.sms.bindingGeneration);
  await f.service.sendBrief('owner', 'sms');
  assert.equal(f.calls.length, 1);
});

test('STOP during the final owner guard transaction prevents the provider call', async () => {
  const f = fixture(); await f.verify();
  f.beforeBatch = async operations => {
    const last = operations.at(-1);
    if (last.operationType === 'Replace' && last.resourceBody.type === 'messagingDelivery' && operations.length > 1) {
      f.beforeBatch = null;
      await f.service.stop('owner', 'sms');
    }
  };
  await assert.rejects(f.service.sendBrief('owner', 'sms'), error => error.status === 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.view('owner')).channels[0].verified, false);
});

test('real state API exports only safe messaging metadata and deletes only the signed-in owner connection', async () => {
  const f = fixture(); await f.verify(); await f.service.sendBrief('owner', 'sms');
  f.seed('other'); await f.verify('sms', '+12065550112', 'other');
  const otherBefore = structuredClone(settings(f, 'other'));
  const handler = createStateHandler({ getContainer: () => f.container, now: f.now });
  async function request(method, query = {}) {
    const context = { log: { error() {} } };
    await handler(context, { method, query, headers: {
      'content-type': 'application/json', 'x-farmer-account-id': 'owner',
      'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: 'owner', userDetails: 'owner@example.test', identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64')
    } });
    return context.res;
  }
  const ordinary = await request('GET');
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.messaging, undefined);
  const exported = await request('GET', { export: '1', userId: 'other' });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.messaging.channels[0].verifiedAt !== null, true);
  assert.match(exported.body.messaging.channels[0].maskedPhone, /0111$/);
  assert.doesNotMatch(JSON.stringify(exported.body), /0112|\+12065550111|secret|recipientHash|bindingGeneration|dispatchId|JOIN/);
  assert.equal((await request('DELETE', { userId: 'other' })).status, 204);
  assert.equal(settings(f), undefined);
  assert.deepEqual(settings(f, 'other'), otherBefore);
  assert.deepEqual(bindings(f).map(d => d.owner), ['other']);
  assert.equal(delivery(f).status, 'cancelled');
  assert.equal(delivery(f).recipientHash, undefined);
  assert.equal(delivery(f).dispatchId, undefined);
  assert.ok(f.docs.has(f.key('account-owner', 'owner')));
  assert.equal((await request('DELETE')).status, 204, 'repeat deletion remains safe after settings disappeared');
  assert.deepEqual(settings(f, 'other'), otherBefore);
});
