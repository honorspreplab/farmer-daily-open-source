'use strict';

// Independent provider boundary checks. All identities, credentials and HTTP
// responses below are synthetic; these tests never contact a live calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/shared/calendar-providers');
const connections = require('../api/shared/calendar-connections');
const { createCalendarConnectionsHandler } = require('../api/calendar-connections');

const NOW = Date.parse('2026-10-17T18:00:00Z');
const ENV = Object.freeze({
  APP_ORIGIN: 'https://farm.example.test',
  CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_CALENDAR_CLIENT_ID: 'google-test-client',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'google-private-test-secret&=',
  MICROSOFT_CALENDAR_CLIENT_ID: 'outlook-test-client',
  MICROSOFT_CALENDAR_CLIENT_SECRET: 'outlook-private-test-secret&='
});
const config = provider => providers.configuration(provider, ENV);
const tokens = Object.freeze({ accessToken: 'private-test-access-token', refreshToken: 'private-test-refresh-token', expiresAt: NOW + 3600000 });
const response = (value, options = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' }, ...options });
const tokenResponse = patch => ({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, token_type: 'Bearer', expires_in: 3600, ...patch });
const proposal = patch => ({ id: 'calendar-job-123', externalId: 'd'.repeat(64), preview: { title: 'Check orchard irrigation', allDay: false, date: '2026-10-18', endDate: '2026-10-19', startUtc: '2026-10-18T16:00:00.000Z', endUtc: '2026-10-18T16:30:00.000Z', ...patch } });

test('calendar OAuth requests exclude mail, contacts, drive and broad Google calendar scopes', () => {
  assert.deepEqual(config('google').scope.split(' '), ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created']);
  assert.match(config('outlook').scope, /\bCalendars\.ReadWrite\b/);
  for (const provider of ['google', 'outlook']) assert.doesNotMatch(config(provider).scope, /mail\.|gmail|contacts|drive|\.default|calendars\.readwrite\.shared/i);
  for (const provider of ['__proto__', 'constructor', 'gmail', '', null, {}]) assert.throws(() => providers.providerDefinition(provider), /Choose Google Calendar or Outlook Calendar/);
});

test('calendar configuration is unavailable without every server secret and a bare HTTPS origin', () => {
  for (const provider of ['google', 'outlook']) {
    const valid = config(provider);
    assert.equal(valid.configured, true);
    assert.equal(valid.redirectUri, `${ENV.APP_ORIGIN}/calendar-callback/${provider}`);
    for (const key of ['APP_ORIGIN', 'CALENDAR_TOKEN_KEY', valid.client, valid.secret]) {
      const invalid = providers.configuration(provider, { ...ENV, [key]: '' });
      assert.equal(invalid.configured, false, `${provider}:${key}`);
      assert.ok(invalid.missing.includes(key));
    }
  }
  for (const origin of ['http://farm.example.test', 'https://attacker@farm.example.test', 'https://farm.example.test/path', 'https://farm.example.test/?next=attacker', 'https://farm.example.test/#private', '//farm.example.test']) {
    assert.equal(providers.configuration('google', { ...ENV, APP_ORIGIN: origin }).configured, false, origin);
  }
  for (const key of ['plain-text-secret', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) assert.equal(providers.configuration('google', { ...ENV, CALENDAR_TOKEN_KEY: key }).configured, false);
});

test('authorization links use distinct exact callbacks, code flow and PKCE, without exposing server secrets', () => {
  for (const provider of ['google', 'outlook']) {
    const current = config(provider), link = providers.authorizationUrl(current, 'opaque-attempt-state', 'opaque-pkce-challenge'), url = new URL(link);
    assert.equal(url.origin, new URL(current.authorize).origin);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), `${ENV.APP_ORIGIN}/calendar-callback/${provider}`);
    assert.equal(url.searchParams.get('state'), 'opaque-attempt-state');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), 'opaque-pkce-challenge');
    assert.equal(url.searchParams.has('code_verifier'), false);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.ok(!link.includes(current.clientSecret));
    assert.ok(!link.includes(ENV.CALENDAR_TOKEN_KEY));
    if (provider === 'google') {
      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
    }
  }
});

test('provider networking rejects untrusted endpoints before invoking fetch', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return response({}); };
  for (const endpoint of ['http://graph.microsoft.com/v1.0/me', 'https://graph.microsoft.com.evil.test/me', 'https://evil.test/calendar', 'https://name:password@graph.microsoft.com/me', 'https://graph.microsoft.com:444/me', 'file:///private-tokens']) {
    await assert.rejects(providers.providerJson(fetch, endpoint), /Invalid calendar endpoint/);
  }
  assert.equal(calls, 0);
});

test('provider requests enforce bounded time and forbid following redirects', async () => {
  let captured;
  const result = await providers.providerJson(async (url, options) => { captured = { url, options }; return response({ id: 'safe' }); }, 'https://graph.microsoft.com/v1.0/me', { redirect: 'follow' });
  assert.equal(result.id, 'safe');
  assert.equal(captured.options.redirect, 'error');
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test('provider failures never expose response bodies, tokens, or network error details', async () => {
  const sensitive = `provider-private-${tokens.accessToken}`;
  for (const fetch of [async () => response({ error: sensitive }, { status: 401 }), async () => { throw new Error(sensitive); }]) {
    await assert.rejects(providers.providerJson(fetch, 'https://graph.microsoft.com/v1.0/me'), error => {
      assert.ok(error instanceof providers.ProviderError);
      assert.equal(error.message, 'Calendar provider did not confirm this operation');
      assert.ok(!JSON.stringify(error).includes(sensitive));
      return true;
    });
  }
});

test('provider JSON rejects oversized, invalid and non-object responses', async () => {
  const responses = [
    () => response({ x: 'a'.repeat(65536) }),
    () => response({}, { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }),
    () => new Response('<html>private error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    () => response([]), () => response(null)
  ];
  for (const makeResponse of responses) await assert.rejects(providers.providerJson(async () => makeResponse(), 'https://www.googleapis.com/calendar/v3/calendars'), providers.ProviderError);
});

test('code exchange puts secret and PKCE verifier only in the server-side form body', async () => {
  let captured;
  const result = await providers.redeem(async (url, options) => { captured = { url, options }; return response(tokenResponse({ scope: config('google').scope })); }, config('google'), 'one-use-auth-code', 'private-pkce-verifier', NOW);
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('client_secret'), ENV.GOOGLE_CALENDAR_CLIENT_SECRET);
  assert.equal(form.get('code_verifier'), 'private-pkce-verifier');
  assert.equal(form.get('code'), 'one-use-auth-code');
  assert.equal(form.get('redirect_uri'), `${ENV.APP_ORIGIN}/calendar-callback/google`);
  assert.deepEqual(result, tokens);
});

test('refresh preserves the existing refresh token when omitted and validates token lifetimes', async () => {
  const result = await providers.refresh(async () => response(tokenResponse({ refresh_token: undefined, access_token: 'new-test-access' })), config('outlook'), tokens, NOW);
  assert.equal(result.refreshToken, tokens.refreshToken);
  assert.equal(result.accessToken, 'new-test-access');
  for (const patch of [{ access_token: '' }, { refresh_token: '' }, { token_type: 'mac' }, { expires_in: 0 }, { expires_in: -1 }, { expires_in: 'not-a-number' }, { expires_in: 86401 }]) assert.throws(() => providers.normalizeTokens(tokenResponse(patch), config('google'), NOW), providers.ProviderError);
  assert.throws(() => providers.normalizeTokens(tokenResponse({ scope: 'openid email' }), config('google'), NOW), providers.ProviderError);
  assert.throws(() => providers.normalizeTokens(tokenResponse({ scope: 'User.Read' }), config('outlook'), NOW), providers.ProviderError);
});

test('Google identity comes from authenticated provider userinfo and requires verified email', async () => {
  let captured;
  const result = await providers.identity(async (url, options) => { captured = { url, options }; return response({ sub: 'test-subject', email: 'farmer@example.test', email_verified: true, unrelated: 'discarded' }); }, config('google'), tokens);
  assert.equal(captured.url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(captured.options.headers.Authorization, `Bearer ${tokens.accessToken}`);
  assert.deepEqual(result, { id: 'test-subject', label: 'farmer@example.test' });
  await assert.rejects(providers.identity(async () => response({ sub: 'test-subject', email: 'farmer@example.test', email_verified: false }), config('google'), tokens), providers.ProviderError);
});

test('calendar creation is restricted to one named secondary calendar and does not share it', async () => {
  for (const provider of ['google', 'outlook']) {
    let captured;
    const result = await providers.createCalendar(async (url, options) => { captured = { url, options }; return response({ id: 'app-calendar-id', token: 'ignored' }); }, config(provider), tokens);
    assert.equal(captured.options.method, 'POST');
    const body = JSON.parse(captured.options.body);
    assert.equal(body.summary || body.name, 'Farmer Daily');
    assert.equal(body.acl, undefined);
    assert.equal(body.attendees, undefined);
    assert.deepEqual(result, { id: 'app-calendar-id', name: 'Farmer Daily' });
  }
});

test('Google event writes retain deterministic IDs and avoid invitations, locations and private notes', async () => {
  let captured;
  const item = proposal(), result = await providers.createEvent(async (url, options) => { captured = { url, options }; return response({ id: item.externalId, htmlLink: 'https://calendar.google.com/calendar/event?eid=test' }); }, config('google'), { calendarId: 'app-calendar@example.test' }, tokens, item);
  assert.equal(new URL(captured.url).searchParams.get('sendUpdates'), 'none');
  assert.match(captured.url, /app-calendar%40example.test\/events/);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.id, item.externalId);
  assert.equal(body.visibility, 'private');
  assert.deepEqual(body.reminders, { useDefault: false });
  assert.equal(body.start.dateTime, item.preview.startUtc);
  assert.equal(body.start.timeZone, 'America/Los_Angeles');
  for (const key of ['attendees', 'location', 'description', 'attachments', 'conferenceData']) assert.equal(body[key], undefined);
  assert.equal(result.eventId, item.externalId);
});

test('Outlook events use transaction IDs and exclusive Pacific all-day end dates', async () => {
  let captured;
  const item = proposal({ allDay: true, date: '2026-11-01', endDate: '2026-11-02' });
  await providers.createEvent(async (url, options) => { captured = { url, options }; return response({ id: 'outlook-created-event', webLink: 'https://outlook.live.com/calendar/item/test' }); }, config('outlook'), { calendarId: 'app-calendar-id' }, tokens, item);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.transactionId, item.id);
  assert.equal(body.sensitivity, 'private');
  assert.equal(body.isReminderOn, false);
  assert.equal(body.isAllDay, true);
  assert.deepEqual(body.start, { dateTime: '2026-11-01T00:00:00', timeZone: 'Pacific Standard Time' });
  assert.deepEqual(body.end, { dateTime: '2026-11-02T00:00:00', timeZone: 'Pacific Standard Time' });
  for (const key of ['attendees', 'location', 'body', 'attachments', 'isOnlineMeeting']) assert.equal(body[key], undefined);
});

test('calendar result links reject script URLs, credentials and untrusted domains', async () => {
  for (const provider of ['google', 'outlook']) for (const link of ['javascript:alert(1)', 'http://calendar.google.com/event', 'https://calendar.google.com.evil.test/event', 'https://user:pass@calendar.google.com/event', 'https://evil.test/event']) {
    const item = proposal();
    const result = await providers.createEvent(async () => response({ id: provider === 'google' ? item.externalId : 'outlook-event', htmlLink: link, webLink: link }), config(provider), { calendarId: 'app-calendar-id' }, tokens, item);
    assert.equal(result.eventUrl, null);
  }
});

test('calendar token envelopes use unique IVs and authenticate both account owner and provider', () => {
  const key = Buffer.from(ENV.CALENDAR_TOKEN_KEY, 'base64');
  const first = connections.encrypt(tokens, key, 'owner-a', 'google');
  const second = connections.encrypt(tokens, key, 'owner-a', 'google');
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.ok(!JSON.stringify(first).includes(tokens.refreshToken));
  assert.deepEqual(connections.decrypt(first, key, 'owner-a', 'google'), tokens);
  for (const [testKey, owner, provider] of [[key, 'owner-b', 'google'], [key, 'owner-a', 'outlook'], [Buffer.alloc(32, 8), 'owner-a', 'google']]) assert.throws(() => connections.decrypt(first, testKey, owner, provider), /cannot be opened/);
});

test('tampered or malformed encrypted credentials fail closed without exposing plaintext', () => {
  const key = Buffer.from(ENV.CALENDAR_TOKEN_KEY, 'base64'), original = connections.encrypt(tokens, key, 'owner-a', 'google');
  for (const patch of [{ v: 2 }, { iv: '' }, { tag: Buffer.alloc(16).toString('base64') }, { data: Buffer.from('tampered ciphertext').toString('base64') }, { data: 'a'.repeat(60001) }]) {
    assert.throws(() => connections.decrypt({ ...original, ...patch }, key, 'owner-a', 'google'), error => {
      assert.ok(!error.message.includes(tokens.accessToken));
      assert.equal(error.status, 409);
      return true;
    });
  }
});

test('browser connection cookies are short-lived, secure, HttpOnly and API-path scoped', () => {
  const cookie = connections.cookie('google', 'opaque-browser-proof');
  assert.match(cookie, /fd_calendar_google=opaque-browser-proof/);
  assert.match(cookie, /Path=\/api\/calendar-connections/);
  assert.match(cookie, /Max-Age=600(?:;|$)/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(connections.cookie('google'), /Max-Age=0(?:;|$)/);
  assert.equal(connections.cookieValue({ headers: { cookie: 'unrelated=1; fd_calendar_google=opaque-browser-proof; fd_calendar_outlook=another-browser-proof' } }, 'google'), 'opaque-browser-proof');
  assert.equal(connections.cookieValue({ headers: { cookie: 'fd_calendar_outlook=another-browser-proof' } }, 'google'), '');
  assert.equal(connections.matchesHash('opaque-browser-proof', connections.hash('opaque-browser-proof')), true);
  assert.equal(connections.matchesHash('different-browser', connections.hash('opaque-browser-proof')), false);
  assert.equal(connections.matchesHash('opaque-browser-proof', 'not-a-hash'), false);
});

test('Pacific time conversion handles both offsets and rejects DST gaps and repeated times', () => {
  assert.equal(new Date(connections.pacificInstant('2026-10-18', '09:00')).toISOString(), '2026-10-18T16:00:00.000Z');
  assert.equal(new Date(connections.pacificInstant('2026-12-18', '09:00')).toISOString(), '2026-12-18T17:00:00.000Z');
  assert.throws(() => connections.pacificInstant('2027-03-14', '02:30'), /daylight-saving/);
  assert.throws(() => connections.pacificInstant('2026-11-01', '01:30'), /daylight-saving/);
});

test('review snapshots contain only the approved task title, schedule and destination', () => {
  const task = { id: 'task-a', name: 'Inspect seedlings', date: '2026-10-18', time: '09:00', done: false, notes: 'Sensitive diagnosis', location: 'Private exact farm address', coordinates: [47, -122] };
  const result = connections.taskSnapshot({ profile: { email: 'private@example.test' }, tasks: [task] }, 'task-a', { calendarName: 'Farmer Daily', accountLabel: 'calendar@example.test' }, NOW);
  assert.equal(result.preview.title, task.name);
  assert.equal(result.preview.startUtc, '2026-10-18T16:00:00.000Z');
  assert.equal(result.preview.endUtc, '2026-10-18T17:00:00.000Z');
  for (const secret of ['Sensitive diagnosis', 'Private exact farm address', 'private@example.test', 'coordinates']) assert.ok(!JSON.stringify(result.preview).includes(secret));
  for (const patch of [{ done: true }, { date: '2026-02-30' }, { date: '2026-10-16' }, { date: '2030-10-18' }, { time: '25:00' }, { name: 'x\u0000y' }]) assert.throws(() => connections.taskSnapshot({ tasks: [{ ...task, ...patch }] }, 'task-a', { calendarName: 'Farmer Daily', accountLabel: 'calendar@example.test' }, NOW));
});

test('public calendar state and exported data omit credentials, PKCE state and internal identifiers', async () => {
  const key = Buffer.from(ENV.CALENDAR_TOKEN_KEY, 'base64'), document = connections.emptyDocument('owner-a');
  document.connections.google = { generation: 'private-generation', status: 'connected', secret: connections.encrypt(tokens, key, 'owner-a', 'google'), calendarId: 'private-provider-calendar-id', providerAccountId: 'private-provider-subject', accountLabel: 'calendar@example.test', calendarName: 'Farmer Daily', connectedAt: '2026-10-17T18:00:00Z' };
  document.pending.outlook = { stateHash: 'private-state-hash', browserHash: 'private-browser-hash', verifier: 'private-pkce-verifier', tokenSecret: 'private-pending-token', status: 'awaiting' };
  document.proposals.push({ id: 'proposal-a', provider: 'google', status: 'pending', preview: { title: 'Inspect seedlings' }, taskHash: 'private-task-hash', externalId: 'private-event-id', generation: 'private-generation' });
  const container = { item: (id, owner) => { assert.equal(id, 'calendar-owner-a'); assert.equal(owner, 'owner-a'); return { read: async () => ({ resource: document }) }; } };
  const views = [connections.publicView(document, { env: ENV }), await connections.exportCalendarConnections(container, 'owner-a')];
  for (const view of views) {
    const encoded = JSON.stringify(view);
    for (const secret of ['private-generation', 'private-provider-calendar-id', 'private-provider-subject', 'private-state-hash', 'private-browser-hash', 'private-pkce-verifier', 'private-pending-token', 'private-task-hash', 'private-event-id', tokens.accessToken, tokens.refreshToken, document.connections.google.secret.data]) assert.ok(!encoded.includes(secret), secret);
    assert.ok(encoded.includes('Inspect seedlings'));
  }
  const regular = connections.publicView(document, { env: {} });
  const admin = connections.publicView(document, { env: {}, isAdmin: true });
  assert.equal(regular.providers[0].setupRequired, undefined);
  assert.ok(admin.providers[0].setupRequired.includes('CALENDAR_TOKEN_KEY'));
});

test('private calendar records reject another owner and conditional cleanup never crosses partitions', async () => {
  const document = { ...connections.emptyDocument('owner-a'), _etag: 'revision-a' };
  assert.throws(() => connections.checkedDocument(document, 'owner-b'), /Invalid private calendar record/);
  const calls = [];
  await connections.pruneCalendarConnections({ item: (id, owner) => {
    calls.push({ id, owner });
    assert.equal(id, 'calendar-owner-a');
    assert.equal(owner, 'owner-a');
    return { read: async () => ({ resource: document }), delete: async options => assert.deepEqual(options, { accessCondition: { type: 'IfMatch', condition: 'revision-a' } }) };
  } }, 'owner-a');
  assert.equal(calls.length, 2);
});

function privateHandlerFixture() {
  const owner = 'security-owner', documents = new Map(), requests = [], reads = [];
  let revision = 0, timestamp = NOW, fetchHook;
  const clone = value => structuredClone(value);
  const failure = code => Object.assign(new Error('private storage details'), { code });
  const key = (id, partition) => `${partition}/${id}`;
  function save(document) { const value = { ...clone(document), _etag: String(++revision) }; documents.set(key(value.id, value.userId), value); return { resource: clone(value) }; }
  const container = { item(id, partition) { reads.push({ id, partition }); return {
    async read() { const value = documents.get(key(id, partition)); if (!value) throw failure(404); return { resource: clone(value) }; },
    async replace(document, options) { const value = documents.get(key(id, partition)); if (!value) throw failure(404); if (value._etag !== options?.accessCondition?.condition) throw failure(412); return save(document); }
  }; }, items: {
    async create(document) { if (documents.has(key(document.id, document.userId))) throw failure(409); return save(document); },
    async batch(operations, partition) {
      for (const operation of operations) {
        const body = operation.resourceBody;
        assert.equal(body.userId, partition);
        const existing = documents.get(key(operation.id || body.id, partition));
        if (operation.operationType === 'Create' && existing) throw failure(409);
        if (operation.operationType === 'Replace' && (!existing || existing._etag !== operation.ifMatch)) throw failure(existing ? 412 : 404);
      }
      return { code: 200, result: operations.map(operation => ({ statusCode: 200, resourceBody: save(operation.resourceBody).resource })) };
    }
  } };
  const account = () => clone(documents.get(key(`account-${owner}`, owner)));
  const state = () => clone(documents.get(key(`state-${owner}`, owner)));
  const calendar = () => clone(documents.get(key(`calendar-${owner}`, owner)));
  save({ id: `account-${owner}`, userId: owner, type: 'account', email: 'farmer@example.test', identityProvider: 'aad', plan: 'premium', request: { status: 'approved' } });
  save({ id: `state-${owner}`, userId: owner, type: 'state', state: { profile: { firstName: 'Test farmer' }, fields: [], tasks: [{ id: 'task-a', name: 'Inspect seedlings', date: '2026-10-18', time: '09:00', done: false }] } });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (fetchHook) { const hook = fetchHook; fetchHook = null; await hook(url); }
    if (url === 'https://oauth2.googleapis.com/token') return response(tokenResponse({ scope: config('google').scope }));
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return response({ sub: 'provider-subject', email: 'calendar@example.test', email_verified: true });
    if (url === 'https://www.googleapis.com/calendar/v3/calendars') return response({ id: 'provider-created-calendar' });
    if (url.includes('/events?')) return response({ id: JSON.parse(options.body).id });
    throw new Error('Unexpected synthetic request');
  };
  const handler = createCalendarConnectionsHandler({ getContainer: () => container, now: () => timestamp, fetchImpl, env: ENV });
  async function call(body, options = {}) {
    const user = options.owner === undefined ? owner : options.owner;
    const context = { log: { error() {} } };
    const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...(user ? { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: user, userDetails: 'farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64'), 'x-farmer-account-id': user } : {}), ...options.headers };
    await handler(context, { method: options.method || 'POST', body, headers, query: options.query || {} });
    return context.res;
  }
  async function begin() {
    const result = await call({ action: 'begin', provider: 'google', allowCalendarCreation: true });
    assert.equal(result.status, 200);
    return { state: new URL(result.body.authorizationUrl).searchParams.get('state'), cookie: result.headers['Set-Cookie'].split(';')[0] };
  }
  async function connect() {
    const attempt = await begin();
    const result = await call({ action: 'complete', provider: 'google', code: 'test-auth-code', state: attempt.state }, { headers: { cookie: attempt.cookie } });
    assert.equal(result.status, 200);
    return attempt;
  }
  return { owner, documents, requests, reads, save, account, state, calendar, call, begin, connect, setNow: value => { timestamp = value; }, hook: fn => { fetchHook = fn; } };
}

test('calendar handler rejects missing identity, wrong-owner headers and cross-site mutations without contacting providers', async () => {
  const fixture = privateHandlerFixture();
  const body = { action: 'begin', provider: 'google', allowCalendarCreation: true };
  assert.equal((await fixture.call(body, { owner: null })).status, 401);
  assert.equal((await fixture.call(body, { headers: { 'x-farmer-account-id': 'another-owner' } })).status, 409);
  assert.equal((await fixture.call(body, { headers: { 'x-farmer-account-id': '' } })).status, 409);
  assert.equal((await fixture.call(body, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fixture.call(body, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fixture.call({ ...body, userId: 'another-owner' })).status, 400);
  assert.equal(fixture.requests.length, 0);
  assert.ok(fixture.reads.every(item => item.partition === fixture.owner));
});

test('OAuth completion rejects missing browser proof, swapped state and expiry before redeeming any code', async () => {
  const fixture = privateHandlerFixture(), attempt = await fixture.begin();
  const body = { action: 'complete', provider: 'google', code: 'test-auth-code', state: attempt.state };
  assert.equal((await fixture.call(body)).status, 409);
  assert.equal((await fixture.call(body, { headers: { cookie: 'fd_calendar_google=other-browser-proof' } })).status, 409);
  assert.equal((await fixture.call({ ...body, state: 'another-state' }, { headers: { cookie: attempt.cookie } })).status, 409);
  assert.equal((await fixture.call({ ...body, provider: 'outlook' }, { headers: { cookie: attempt.cookie } })).status, 409);
  fixture.setNow(NOW + connections.FLOW_MS + 1);
  assert.equal((await fixture.call(body, { headers: { cookie: attempt.cookie } })).status, 409);
  assert.equal(fixture.requests.length, 0);
});

test('a completed OAuth attempt cannot redeem its authorization code or create a calendar again', async () => {
  const fixture = privateHandlerFixture(), attempt = await fixture.connect();
  const before = fixture.requests.length;
  const replay = await fixture.call({ action: 'complete', provider: 'google', code: 'test-auth-code', state: attempt.state }, { headers: { cookie: attempt.cookie } });
  assert.equal(replay.status, 409);
  assert.equal(fixture.requests.length, before);
  assert.equal(fixture.requests.filter(item => item.url === 'https://www.googleapis.com/calendar/v3/calendars').length, 1);
});

test('revoking premium during authorization prevents subsequent calendar creation and credential persistence', async () => {
  const fixture = privateHandlerFixture(), attempt = await fixture.begin();
  fixture.hook(async () => fixture.save({ ...fixture.account(), plan: 'free', request: null }));
  const result = await fixture.call({ action: 'complete', provider: 'google', code: 'test-auth-code', state: attempt.state }, { headers: { cookie: attempt.cookie } });
  assert.equal(result.status, 403);
  assert.equal(fixture.requests.filter(item => item.url === 'https://www.googleapis.com/calendar/v3/calendars').length, 0);
  assert.equal(fixture.calendar().connections.google, undefined);
});

test('event confirmation requires exact approval and rejects client-supplied replacements for the reviewed task', async () => {
  const fixture = privateHandlerFixture();
  await fixture.connect();
  const prepared = await fixture.call({ action: 'prepare', provider: 'google', taskId: 'task-a' });
  assert.equal(prepared.status, 200);
  const body = { action: 'execute', proposalId: prepared.body.proposal.id, approved: true }, before = fixture.requests.length;
  assert.equal((await fixture.call({ ...body, approved: false })).status, 400);
  assert.equal((await fixture.call({ ...body, preview: { title: 'Unreviewed title' } })).status, 400);
  const changed = fixture.state(); changed.state.tasks[0].name = 'Changed after review'; fixture.save(changed);
  assert.equal((await fixture.call(body)).status, 409);
  assert.equal(fixture.requests.length, before);
});

test('disconnect during token refresh wins and prevents the event write or credential resurrection', async () => {
  const fixture = privateHandlerFixture();
  await fixture.connect();
  const current = fixture.calendar();
  current.connections.google.secret = connections.encrypt({ ...tokens, expiresAt: NOW - 1 }, Buffer.from(ENV.CALENDAR_TOKEN_KEY, 'base64'), fixture.owner, 'google');
  fixture.save(current);
  const prepared = await fixture.call({ action: 'prepare', provider: 'google', taskId: 'task-a' });
  fixture.hook(async () => { const disconnected = await fixture.call({ action: 'disconnect', provider: 'google' }); assert.equal(disconnected.status, 200); });
  const result = await fixture.call({ action: 'execute', proposalId: prepared.body.proposal.id, approved: true });
  assert.equal(result.status, 409);
  assert.equal(fixture.requests.filter(item => item.url.includes('/events?')).length, 0);
  assert.equal(fixture.calendar().connections.google, undefined);
});
