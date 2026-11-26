'use strict';

// All phone numbers, credentials and HTTP responses are synthetic. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const provider = require('../api/shared/message-provider');
const NOW = Date.parse('2026-10-22T18:00:00Z');
const ENV = Object.freeze({ APP_ORIGIN: 'https://farm.example.test', MESSAGING_ENABLED: 'true', TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'b'.repeat(32), TWILIO_SMS_FROM: '+12025550101', TWILIO_WHATSAPP_FROM: 'whatsapp:+12025550102', TWILIO_WHATSAPP_CONTENT_SID: `HX${'c'.repeat(32)}` });
const SID = `SM${'d'.repeat(32)}`, TO = '+12025550103', DISPATCH = 'e'.repeat(64);
const config = patch => provider.configuration({ ...ENV, ...patch });
const sms = patch => ({ channel: 'sms', to: TO, body: 'Farmer Daily: your brief is ready. Reply STOP to stop.', purpose: 'daily-brief', dispatchId: DISPATCH, ...patch });
const wa = patch => sms({ channel: 'whatsapp', templateVariables: { 1: 'October 22', 2: 'Check your low-wind work window.', 3: ENV.APP_ORIGIN }, ...patch });
const json = (value, status = 201, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const result = (patch = {}) => ({ sid: SID, account_sid: ENV.TWILIO_ACCOUNT_SID, from: ENV.TWILIO_SMS_FROM, to: TO, status: 'queued', ...patch });
const signed = (params, options = {}) => {
  const cfg = options.config || config(), kind = options.kind || 'status';
  const url = options.url || provider.callbackUrl(cfg, kind, options.dispatchId);
  const rawBody = new URLSearchParams(params).toString();
  const input = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  return { rawBody, signature: crypto.createHmac('sha1', cfg.authToken).update(input).digest('base64'), contentType: 'application/x-www-form-urlencoded', kind, dispatchId: options.dispatchId };
};
const callback = patch => ({ AccountSid: ENV.TWILIO_ACCOUNT_SID, MessageSid: SID, SmsSid: SID, MessageStatus: 'delivered', SmsStatus: 'delivered', From: ENV.TWILIO_SMS_FROM, To: TO, ...patch });
const inbound = patch => callback({ From: TO, To: ENV.TWILIO_SMS_FROM, MessageStatus: 'received', SmsStatus: 'received', Body: 'STOP', ...patch });

test('messaging is off by default and public configuration exposes no credential or sender', () => {
  for (const enabled of [undefined, '', 'false', 'TRUE', '1', true]) assert.equal(config({ MESSAGING_ENABLED: enabled }).enabled, false);
  const publicConfig = provider.publicConfiguration(ENV);
  assert.equal(publicConfig.channels.sms.ready, true);
  assert.equal(publicConfig.channels.whatsapp.ready, true);
  for (const privateValue of [ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_AUTH_TOKEN, ENV.TWILIO_SMS_FROM, ENV.TWILIO_WHATSAPP_FROM]) assert.ok(!JSON.stringify(publicConfig).includes(privateValue));
});

test('configuration validates HTTPS public origin and independent channel credentials', () => {
  for (const origin of ['http://farm.example.test', 'https://user:secret@farm.example.test', 'https://farm.example.test/path', 'https://farm.example.test/?x=1', 'https://farm.example.test/#frag', 'https://farm.example.test:444', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://farm.local', 'https://farm.localhost', 'https://farm_invalid.example.test', ' https://farm.example.test']) {
    assert.equal(config({ APP_ORIGIN: origin }).configured, false, origin);
  }
  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) assert.equal(config({ [key]: 'not-a-credential' }).configured, false);
  assert.equal(config({ TWILIO_MESSAGING_SERVICE_SID: 'invalid' }).configured, false);
  const smsOnly = config({ TWILIO_WHATSAPP_FROM: '', TWILIO_WHATSAPP_CONTENT_SID: '' });
  assert.equal(smsOnly.channels.sms.ready, true);
  assert.equal(smsOnly.channels.whatsapp.ready, false);
  assert.equal(config({ TWILIO_SMS_FROM: '202 555 0101' }).channels.sms.ready, false);
  assert.equal(config({ TWILIO_WHATSAPP_FROM: '+12025550102' }).whatsappFrom, ENV.TWILIO_WHATSAPP_FROM);
});

test('disabled, unconfigured and invalid requests never invoke the provider', async () => {
  let calls = 0; const fetch = async () => { calls++; return json(result()); };
  for (const [cfg, message] of [
    [config({ MESSAGING_ENABLED: '' }), sms()], [config({ TWILIO_AUTH_TOKEN: '' }), sms()],
    [config(), sms({ channel: 'email' })], [config(), sms({ purpose: 'bulk' })], [config(), sms({ to: 'https://evil.test' })],
    [config(), sms({ to: ENV.TWILIO_SMS_FROM })], [config(), sms({ body: '' })], [config(), sms({ body: 'x'.repeat(1601) })],
    [config(), sms({ body: 'private\u0000' })], [config(), sms({ dispatchId: '../secret' })],
    [{ ...config(), accountSid: '../other-account' }, sms()], [{ ...config(), origin: 'https://attacker.test/path' }, sms()]
  ]) await assert.rejects(provider.sendMessage(fetch, cfg, message), error => error instanceof provider.MessageProviderError && error.outcome === 'not-sent');
  assert.equal(calls, 0);
});

test('SMS uses only fixed HTTPS endpoint, URL-encoded form, bounded timeout and no redirect', async () => {
  let capture; const cfg = config({ TWILIO_MESSAGING_SERVICE_SID: `MG${'1'.repeat(32)}` });
  const sent = await provider.sendMessage(async (url, options) => { capture = { url, options }; return json(result()); }, cfg, sms({ body: 'Rain & wind + frost?\nReply STOP.' }));
  assert.equal(capture.url, `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
  assert.equal(capture.options.method, 'POST');
  assert.equal(capture.options.redirect, 'error');
  assert.ok(capture.options.signal instanceof AbortSignal);
  assert.equal(capture.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(capture.options.headers.Authorization, `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`);
  const form = new URLSearchParams(capture.options.body);
  assert.equal(form.get('Body'), 'Rain & wind + frost?\nReply STOP.');
  assert.equal(form.get('To'), TO); assert.equal(form.get('From'), cfg.smsFrom);
  assert.equal(form.get('StatusCallback'), `${cfg.origin}/api/messaging-webhook/status?dispatch=${DISPATCH}`);
  assert.equal(form.get('MessagingServiceSid'), cfg.messagingServiceSid);
  assert.deepEqual(sent, { messageSid: SID, status: 'queued', accepted: true, delivered: false });
});

test('scheduled WhatsApp always uses approved ContentSid variables, never a free-form Body', async () => {
  let capture;
  const sent = await provider.sendMessage(async (_, options) => { capture = new URLSearchParams(options.body); return json(result({ to: `whatsapp:${TO}`, from: ENV.TWILIO_WHATSAPP_FROM })); }, config(), wa());
  assert.equal(capture.get('ContentSid'), ENV.TWILIO_WHATSAPP_CONTENT_SID);
  assert.deepEqual(JSON.parse(capture.get('ContentVariables')), wa().templateVariables);
  assert.equal(capture.has('Body'), false);
  assert.equal(sent.delivered, false);
  let calls = 0;
  await assert.rejects(provider.sendMessage(async () => { calls++; }, config({ TWILIO_WHATSAPP_CONTENT_SID: '', MESSAGING_WHATSAPP_SANDBOX: 'true' }), wa({ now: NOW, lastVerifiedInboundAt: NOW - 1000 })), error => error.code === 'whatsapp-template-required');
  assert.equal(calls, 0);
});

test('WhatsApp free-form test requires explicit sandbox and verified inbound within 24 hours', async () => {
  const cfg = config({ TWILIO_WHATSAPP_CONTENT_SID: '', MESSAGING_WHATSAPP_SANDBOX: 'true' });
  let calls = 0; const fetch = async (_, options) => { calls++; const form = new URLSearchParams(options.body); assert.equal(form.get('Body'), sms().body); assert.equal(form.has('ContentSid'), false); return json(result({ to: `whatsapp:${TO}`, from: ENV.TWILIO_WHATSAPP_FROM })); };
  for (const timestamp of [undefined, null, '2026-10-22', NOW + 1, NOW - 86400000, NaN]) await assert.rejects(provider.sendMessage(fetch, cfg, wa({ purpose: 'test', now: NOW, lastVerifiedInboundAt: timestamp })), error => error.code === 'whatsapp-template-required');
  await assert.rejects(provider.sendMessage(fetch, { ...cfg, sandboxEnabled: false }, wa({ purpose: 'test', now: NOW, lastVerifiedInboundAt: NOW })), provider.MessageProviderError);
  assert.equal(calls, 0);
  await provider.sendMessage(fetch, cfg, wa({ purpose: 'test', now: NOW, lastVerifiedInboundAt: NOW - 1000 }));
  assert.equal(calls, 1);
});

test('template variables cannot inject unsupported placeholders or unbounded content', async () => {
  let calls = 0;
  for (const variables of [null, [], {}, { bad: 'x' }, { 0: 'x' }, { 1: '' }, { 1: 'x\ny' }, { 1: 'x'.repeat(801) }, { 1: 42 }, Object.assign(Object.create({ 2: 'inherited' }), { 1: 'x' })]) {
    await assert.rejects(provider.sendMessage(async () => { calls++; }, config(), wa({ templateVariables: variables })), error => error.outcome === 'not-sent');
  }
  assert.equal(calls, 0);
});

test('provider errors distinguish rejection from uncertain outcomes, never retry or leak', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(provider.sendMessage(async () => { calls++; return json({ message: `private ${ENV.TWILIO_AUTH_TOKEN} ${TO}`, code: 99999 }, status); }, config(), sms()), error => {
      assert.equal(error.outcome, status < 500 && status !== 408 ? 'rejected' : 'unknown');
      assert.equal(error.providerStatus, status); assert.ok(!JSON.stringify(error).includes(TO)); assert.ok(!error.message.includes(ENV.TWILIO_AUTH_TOKEN)); return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(provider.sendMessage(async () => { calls++; throw new Error(`private connection ${ENV.TWILIO_AUTH_TOKEN}`); }, config(), sms()), error => error.outcome === 'unknown' && !error.message.includes(ENV.TWILIO_AUTH_TOKEN));
  assert.equal(calls, 1);
});

test('success responses are bounded and must match account, channel, sender, recipient and SID', async () => {
  const invalid = [
    () => json(result(), 200), () => json(result({ sid: 'invalid' })), () => json(result({ account_sid: `AC${'0'.repeat(32)}` })),
    () => json(result({ from: '+12025550109' })), () => json(result({ to: '+12025550109' })), () => json(result({ status: 'magic' })),
    () => json(result({ padding: 'x'.repeat(65536) })), () => json(result(), 201, { 'Content-Length': '65537' }),
    () => json(result(), 201, { 'Content-Type': 'text/html' }), () => new Response('{broken', { status: 201, headers: { 'Content-Type': 'application/json' } }),
    () => json(null), () => json([])
  ];
  for (const make of invalid) await assert.rejects(provider.sendMessage(async () => make(), config(), sms()), error => error.outcome === 'unknown');
  const accepted = await provider.sendMessage(async () => json(result({ status: 'delivered' })), config(), sms());
  assert.equal(accepted.delivered, false, 'API acceptance alone must not be called a receipt');
});

test('valid callbacks authenticate every future field and exact configured dispatch URL', () => {
  const params = callback({ NewFutureField: 'wind + rain & later', RawDlrDoneDate: '2610221100' });
  const request = signed(params, { dispatchId: DISPATCH });
  const checked = provider.verifyWebhook(request, config());
  assert.equal(checked.NewFutureField, params.NewFutureField);
  assert.equal(provider.validateWebhookIdentity(checked, config(), { kind: 'status', expectedTo: TO, expectedFrom: ENV.TWILIO_SMS_FROM, expectedMessageSid: SID }).delivered, true);
  assert.throws(() => provider.verifyWebhook({ ...request, dispatchId: 'f'.repeat(64) }, config()), provider.MessageWebhookError);
  assert.throws(() => provider.verifyWebhook({ ...request, rawBody: request.rawBody.replace('wind', 'snow') }, config()), provider.MessageWebhookError);
  assert.throws(() => provider.verifyWebhook(signed(params, { url: 'https://attacker.test/api/messaging-webhook/status' }), config()), provider.MessageWebhookError);
});

test('webhook signatures accept the documented HMAC algorithm, not a body-only MAC', () => {
  // Published Twilio vector; independent assertion keeps sort/concatenation exact.
  const vector = { From: '+14158675310', Digits: '1234', CallSid: 'CA1234567890ABCDE', To: '+18005551212', Caller: '+14158675310' };
  assert.equal(provider.signatureForForm('12345', 'https://example.com/myapp.php?foo=1&bar=2', vector).toString('base64'), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
  const request = signed(callback());
  request.signature = crypto.createHmac('sha1', ENV.TWILIO_AUTH_TOKEN).update(request.rawBody).digest('base64');
  assert.throws(() => provider.verifyWebhook(request, config()), provider.MessageWebhookError);
});

test('webhook parser rejects duplicates, encoded duplicate aliases, malformed UTF-8 and oversized forms', () => {
  const type = 'application/x-www-form-urlencoded';
  for (const body of ['A=1&A=2', 'A=1&%41=2', 'A=%ZZ', 'A=%C0%AF', 'A=1&', '=x', 'A', 'A=' + 'x'.repeat(8193), 'A=' + 'x'.repeat(65537), Array.from({ length: 129 }, (_, index) => `A${index}=1`).join('&'), Buffer.from([65, 61, 0xff])]) assert.throws(() => provider.parseForm(body, type), provider.MessageWebhookError);
  assert.throws(() => provider.parseForm({ A: '1' }, type), provider.MessageWebhookError);
  assert.throws(() => provider.parseForm('A=1', 'application/json'), provider.MessageWebhookError);
  const parsed = provider.parseForm('__proto__=safe&A=a%2Bb+c', `${type}; charset=utf-8`);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.__proto__, 'safe'); assert.equal(parsed.A, 'a+b c');
});

test('signed callbacks must still match the configured account and sender identity', () => {
  for (const patch of [{ AccountSid: `AC${'0'.repeat(32)}` }, { From: '+12025550109' }, { MessageSid: 'invalid' }, { SmsSid: `SM${'0'.repeat(32)}` }, { MessageStatus: 'magic' }, { SmsStatus: 'failed' }, { ErrorCode: 'private provider error' }, { To: `whatsapp:${TO}` }]) assert.throws(() => provider.verifyWebhook(signed(callback(patch)), config()), provider.MessageWebhookError);
  const verified = provider.verifyWebhook(signed(callback()), config());
  for (const expected of [{ expectedTo: '+12025550109' }, { expectedFrom: '+12025550109' }, { expectedMessageSid: `SM${'0'.repeat(32)}` }]) assert.throws(() => provider.validateWebhookIdentity(verified, config(), { kind: 'status', ...expected }), provider.MessageWebhookError);
  for (const signature of ['', 'not-a-signature', 'a'.repeat(100), Buffer.alloc(20).toString('base64'), [signed(callback()).signature]]) assert.throws(() => provider.verifyWebhook({ ...signed(callback()), signature }, config()), provider.MessageWebhookError);
});

test('inbound callbacks remain authenticatable when sending is disabled and expose opt-out safely', () => {
  const cfg = config({ MESSAGING_ENABLED: 'false' });
  const params = provider.verifyWebhook(signed(inbound({ OptOutType: 'STOP' }), { kind: 'inbound', config: cfg }), cfg);
  const checked = provider.validateWebhookIdentity(params, cfg, { kind: 'inbound' });
  assert.equal(checked.phone, TO); assert.equal(checked.optOutType, 'STOP'); assert.equal(checked.body, 'STOP'); assert.equal(checked.delivered, false);
  assert.throws(() => provider.verifyWebhook(signed(inbound({ To: '+12025550109' }), { kind: 'inbound' }), cfg), provider.MessageWebhookError);
  assert.throws(() => provider.verifyWebhook(signed(inbound(), { kind: 'inbound', dispatchId: DISPATCH }), cfg), provider.MessageWebhookError);
  const whatsapp = inbound({ From: `whatsapp:${TO}`, To: ENV.TWILIO_WHATSAPP_FROM, Body: 'LINK 123456' });
  assert.equal(provider.validateWebhookIdentity(provider.verifyWebhook(signed(whatsapp, { kind: 'inbound' }), cfg), cfg, { kind: 'inbound' }).channel, 'whatsapp');
});

test('streamed responses stop reading as soon as the size limit is exceeded', async () => {
  let canceled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32768)); },
    cancel() { canceled = true; }
  });
  await assert.rejects(provider.sendMessage(async () => new Response(stream, { status: 201, headers: { 'Content-Type': 'application/json' } }), config(), sms()), error => error.outcome === 'unknown');
  assert.equal(canceled, true);
});

test('redirects, aborts and malformed provider responses stay uncertain without retrying', async () => {
  for (const fetch of [
    async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }),
    async () => { throw new DOMException('Private upstream details', 'AbortError'); },
    async () => ({ ok: true, status: 201, headers: new Headers({ 'content-type': 'application/json' }), text: async () => 'x'.repeat(65537) })
  ]) {
    let calls = 0;
    await assert.rejects(provider.sendMessage(async (...args) => { calls++; return fetch(...args); }, config(), sms()), error => error.outcome === 'unknown' && !error.message.includes('Private'));
    assert.equal(calls, 1);
  }
});
