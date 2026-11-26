'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMessagingWebhookHandler } = require('../api/messaging-webhook');

// Synthetic fixtures only; none of these tests contact a provider or database.
const ENV = Object.freeze({ APP_ORIGIN: 'https://farm.example.test', MESSAGING_ENABLED: 'true', TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'b'.repeat(32), TWILIO_SMS_FROM: '+12025550101', TWILIO_WHATSAPP_FROM: 'whatsapp:+12025550102', TWILIO_WHATSAPP_CONTENT_SID: `HX${'c'.repeat(32)}` });
const PHONE = '+12025550103', SID = `SM${'d'.repeat(32)}`, DISPATCH = 'e'.repeat(64);
const fields = (kind, patch = {}) => ({ AccountSid: ENV.TWILIO_ACCOUNT_SID, MessageSid: SID, From: kind === 'status' ? ENV.TWILIO_SMS_FROM : PHONE, To: kind === 'status' ? PHONE : ENV.TWILIO_SMS_FROM, ...(kind === 'status' ? { MessageStatus: 'delivered' } : { SmsStatus: 'received', Body: 'STOP', OptOutType: 'STOP' }), ...patch });
function request(kind = 'status', patch = {}) {
  const params = fields(kind, patch);
  const url = `${ENV.APP_ORIGIN}/api/messaging-webhook/${kind}${kind === 'status' ? `?dispatch=${DISPATCH}` : ''}`;
  const input = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  return { method: 'POST', params: { kind }, url, query: kind === 'status' ? { dispatch: DISPATCH } : {}, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': crypto.createHmac('sha1', ENV.TWILIO_AUTH_TOKEN).update(input).digest('base64') }, rawBody: new URLSearchParams(params).toString() };
}
function fixture(options = {}) {
  const calls = [];
  const service = { async inbound(params) { calls.push({ kind: 'inbound', params }); }, async status(params, dispatchId) { calls.push({ kind: 'status', params, dispatchId }); } };
  const handler = createMessagingWebhookHandler({ env: ENV, service, ...options });
  return { calls, async run(req) { const context = { log: { error() { throw new Error('Callback must not log private errors'); } } }; await handler(context, req); return context.res; } };
}
function rejected(res) { assert.equal(res.status, 403); assert.deepEqual(res.body, { error: 'Invalid messaging callback.' }); assert.match(res.headers['Cache-Control'], /no-store/); assert.equal(res.headers.Location, undefined); }

test('anonymous callback binding permits only POST on the exact dedicated route', () => {
  const binding = require('../api/messaging-webhook/function.json').bindings.find(item => item.type === 'httpTrigger');
  assert.equal(binding.authLevel, 'anonymous'); assert.deepEqual(binding.methods, ['post']); assert.equal(binding.route, 'messaging-webhook/{kind}');
});

test('signed status callback passes exact dispatch ID and additional future parameters', async () => {
  const f = fixture(), res = await f.run(request('status', { FutureProviderField: 'additional + data' }));
  assert.equal(res.status, 204); assert.equal(Object.hasOwn(res, 'body'), false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].dispatchId, DISPATCH);
  assert.equal(f.calls[0].params.MessageSid, SID); assert.equal(f.calls[0].params.FutureProviderField, 'additional + data');
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('signed STOP works while sending is disabled and returns empty TwiML without a reply', async () => {
  const f = fixture({ env: { ...ENV, MESSAGING_ENABLED: 'false' } });
  const res = await f.run(request('inbound'));
  assert.equal(res.status, 200); assert.equal(res.body, '<Response/>'); assert.match(res.headers['Content-Type'], /^application\/xml/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.OptOutType, 'STOP'); assert.equal(f.calls[0].params.Body, 'STOP');
  assert.doesNotMatch(res.body, /<Message|<Redirect|<Say/);
});

test('WhatsApp inbound and read callbacks are validated against the WhatsApp sender', async () => {
  const f = fixture();
  const incoming = request('inbound', { From: `whatsapp:${PHONE}`, To: ENV.TWILIO_WHATSAPP_FROM, Body: 'JOIN 0123456789abcdef0123456789abcdef', OptOutType: '' });
  assert.equal((await f.run(incoming)).status, 200);
  assert.equal((await f.run(request('status', { From: ENV.TWILIO_WHATSAPP_FROM, To: `whatsapp:${PHONE}`, MessageStatus: 'read' }))).status, 204);
  assert.equal(f.calls.length, 2);
});

test('handler uses raw body verbatim, accepting string fallback but never parsed objects', async () => {
  const f = fixture();
  const parsed = request(); parsed.body = { unexpected: 'ignored' };
  assert.equal((await f.run(parsed)).status, 204);
  const fallback = request(); fallback.body = fallback.rawBody; delete fallback.rawBody;
  assert.equal((await f.run(fallback)).status, 204);
  const buffered = request(); buffered.rawBody = Buffer.from(buffered.rawBody);
  assert.equal((await f.run(buffered)).status, 204);
  const reconstructed = request(); reconstructed.body = fields('status'); delete reconstructed.rawBody;
  rejected(await f.run(reconstructed));
  const invalidRaw = request(); invalidRaw.body = invalidRaw.rawBody; invalidRaw.rawBody = { invalid: true };
  rejected(await f.run(invalidRaw));
  assert.equal(f.calls.length, 3);
});

test('bad or absent signatures, tampered bodies and spoofed sender accounts never reach service', async () => {
  const f = fixture();
  for (const change of [
    req => delete req.headers['x-twilio-signature'], req => { req.headers['x-twilio-signature'] = 'invalid'; },
    req => { req.rawBody += '&Extra=changed'; }, req => { req.rawBody += '&AccountSid=duplicate'; },
    req => { req.headers['content-type'] = 'application/json'; }, req => { req.headers['x-twilio-signature'] = [req.headers['x-twilio-signature']]; }
  ]) { const req = request(); change(req); rejected(await f.run(req)); }
  for (const patch of [{ AccountSid: `AC${'0'.repeat(32)}` }, { From: '+12025550109' }, { To: 'not-a-phone' }, { MessageStatus: 'invented-state' }]) rejected(await f.run(request('status', patch)));
  assert.equal(f.calls.length, 0);
});

test('status callback rejects duplicate, unexpected, encoded or malformed query strings', async () => {
  const f = fixture(), prefix = `${ENV.APP_ORIGIN}/api/messaging-webhook/status`;
  for (const query of ['', '?', `?dispatch=${DISPATCH}&dispatch=${DISPATCH}`, `?dispatch=${DISPATCH}&extra=1`, `?%64ispatch=${DISPATCH}`, `?dispatch=%65${DISPATCH.slice(1)}`, '?dispatch=%ZZ', '?dispatch=%C0%AF', '?dispatch=short', `?dispatch=${DISPATCH}&`, `?dispatch=${DISPATCH}#fragment`]) {
    const req = request(); req.url = prefix + query; rejected(await f.run(req));
  }
  for (const query of [{}, { dispatch: [DISPATCH, DISPATCH] }, { dispatch: DISPATCH, extra: '1' }, { dispatch: 'f'.repeat(64) }, new URLSearchParams(`dispatch=${DISPATCH}&dispatch=${DISPATCH}`)]) {
    const req = request(); req.query = query; rejected(await f.run(req));
  }
  assert.equal(f.calls.length, 0);
});

test('inbound callbacks reject every query and malformed or normalized alternate routes', async () => {
  const f = fixture();
  for (const suffix of ['?', '?extra=1', `?dispatch=${DISPATCH}`, '#fragment']) { const req = request('inbound'); req.url += suffix; rejected(await f.run(req)); }
  const withQuery = request('inbound'); withQuery.query = { ignored: 'not-allowed' }; rejected(await f.run(withQuery));
  for (const path of ['/api/messaging-webhook/status/', '/api/messaging-webhook/%73tatus', '/api/other/../messaging-webhook/status', '/api/messaging-webhook/inbound', '/wrong']) {
    const req = request(); req.url = `${ENV.APP_ORIGIN}${path}?dispatch=${DISPATCH}`; rejected(await f.run(req));
  }
  const badKind = request(); badKind.params.kind = 'other'; rejected(await f.run(badKind));
  assert.equal(f.calls.length, 0);
});

test('backend proxy origin is not trusted for signatures, while raw route/query remain exact', async () => {
  const f = fixture();
  const proxied = request(); proxied.url = `http://internal.functions.test/api/messaging-webhook/status?dispatch=${DISPATCH}`; proxied.headers.host = 'untrusted.test'; proxied.headers['x-forwarded-host'] = 'untrusted.test';
  assert.equal((await f.run(proxied)).status, 204);
  const forged = request();
  const alternateUrl = `https://untrusted.test/api/messaging-webhook/status?dispatch=${DISPATCH}`;
  const body = fields('status');
  forged.headers['x-twilio-signature'] = crypto.createHmac('sha1', ENV.TWILIO_AUTH_TOKEN).update(alternateUrl + Object.keys(body).sort().map(key => key + body[key]).join('')).digest('base64');
  rejected(await f.run(forged));
  assert.equal(f.calls.length, 1);
});

test('query object fallback is strict when host provides no raw URL', async () => {
  const f = fixture();
  const status = request(); delete status.url;
  assert.equal((await f.run(status)).status, 204);
  const inbound = request('inbound'); delete inbound.url;
  assert.equal((await f.run(inbound)).status, 200);
  const missing = request(); delete missing.url; delete missing.query; rejected(await f.run(missing));
  const duplicate = request(); delete duplicate.url; duplicate.query = new URLSearchParams(`dispatch=${DISPATCH}&dispatch=${DISPATCH}`); rejected(await f.run(duplicate));
  assert.equal(f.calls.length, 2);
});

test('unknown dispatches and provider statuses are handled without exposing ownership or retrying sends', async () => {
  const f = fixture();
  // The service safely ignores unknown dispatch IDs. HTTP response stays empty.
  for (const status of ['accepted', 'queued', 'sending', 'sent', 'failed', 'undelivered', 'canceled', 'scheduled']) assert.equal((await f.run(request('status', { MessageStatus: status }))).status, 204);
  rejected(await f.run(request('status', { MessageStatus: 'unknown' })));
  assert.equal(f.calls.length, 8);
});

test('service failures return only generic 503 errors without private body, phone or diagnostics', async () => {
  const sensitive = `${PHONE} private-database-token ${ENV.TWILIO_AUTH_TOKEN}`;
  const f = fixture({ service: { async inbound() { throw new Error(sensitive); }, async status() { throw new Error(sensitive); } } });
  for (const kind of ['status', 'inbound']) {
    const res = await f.run(request(kind));
    assert.equal(res.status, 503); assert.deepEqual(res.body, { error: 'Messaging service temporarily unavailable.' });
    assert.ok(!JSON.stringify(res).includes(PHONE)); assert.ok(!JSON.stringify(res).includes(ENV.TWILIO_AUTH_TOKEN)); assert.equal(res.headers.Location, undefined); assert.match(res.headers['Cache-Control'], /no-store/);
  }
});

test('unsupported HTTP methods return 405 and never invoke verification or the service', async () => {
  const f = fixture();
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await f.run({ ...request(), method });
    assert.equal(res.status, 405); assert.equal(res.headers.Allow, 'POST');
  }
  assert.equal(f.calls.length, 0);
});
