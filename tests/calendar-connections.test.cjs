'use strict';
require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarConnectionsHandler } = require('../api/calendar-connections');
const shared = require('../api/shared/calendar-connections');
const { configuration } = require('../api/shared/calendar-providers');
const NOW = Date.parse('2026-10-17T16:00:00Z'), OWNER = 'calendar-owner';
const ENV = { APP_ORIGIN: 'https://farmer.example.test', CALENDAR_TOKEN_KEY: Buffer.alloc(32, 71).toString('base64'), GOOGLE_CALENDAR_CLIENT_ID: 'google-client', GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret', MICROSOFT_CALENDAR_CLIENT_ID: 'microsoft-client', MICROSOFT_CALENDAR_CLIENT_SECRET: 'microsoft-secret' };
const clone = value => structuredClone(value);
const failure = code => Object.assign(new Error('PRIVATE PROVIDER DETAIL'), { code });
const task = patch => ({ id: 'task-1', name: 'Check orchard irrigation', date: '2026-10-18', time: '09:30', done: false, notes: 'Do not send this private note', place: 'Private field address', ...patch });
function fixture(env = ENV) {
  const documents = new Map(), requests = [], batches = [];
  let version = 0, timestamp = NOW, batchHook, fetchHook, cookieJar = '';
  const key = (id, owner) => `${owner}/${id}`;
  const save = document => { const resource = { ...clone(document), _etag: String(++version) }; documents.set(key(resource.id, resource.userId), resource); return { resource: clone(resource) }; };
  const current = (id, owner = OWNER) => clone(documents.get(key(id, owner)));
  const container = { item(id, owner) { return {
    async read() { const resource = current(id, owner); if (!resource) throw failure(404); return { resource }; },
    async delete(options) { const resource = current(id, owner); if (!resource) throw failure(404); if (resource._etag !== options?.accessCondition?.condition) throw failure(412); documents.delete(key(id, owner)); },
    async replace(document, options) { const resource = current(id, owner); if (!resource) throw failure(404); if (resource._etag !== options?.accessCondition?.condition) throw failure(412); return save(document); }
  }; }, items: {
    async create(document) { if (current(document.id, document.userId)) throw failure(409); return save(document); },
    async batch(operations, owner) {
      batches.push(clone(operations));
      if (batchHook) { const hook = batchHook; batchHook = null; await hook(); }
      for (const operation of operations) {
        assert.equal(operation.resourceBody.userId, owner);
        const resource = current(operation.id || operation.resourceBody.id, owner);
        if (operation.operationType === 'Create' && resource) throw failure(409);
        if (operation.operationType === 'Replace' && (!resource || resource._etag !== operation.ifMatch)) throw failure(resource ? 412 : 404);
      }
      return { code: 200, result: operations.map(operation => ({ statusCode: 200, resourceBody: save(operation.resourceBody).resource })) };
    }
  } };
  const account = (owner = OWNER, patch = {}) => ({ id: `account-${owner}`, userId: owner, type: 'account', identityProvider: 'aad', email: owner === 'admin' ? 'admin1@example.invalid' : 'farmer@example.test', plan: 'premium', request: { status: 'approved' }, ...patch });
  save(account()); save({ id: `state-${OWNER}`, userId: OWNER, state: { profile: { firstName: 'Private farmer' }, tasks: [task()] } });
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, options) {
    requests.push({ url, options: clone(options) });
    if (fetchHook) { const result = await fetchHook(url, options); if (result !== undefined) return result; }
    if (url.includes('/token')) return json({ access_token: 'PRIVATE_ACCESS_TOKEN', refresh_token: 'PRIVATE_REFRESH_TOKEN', token_type: 'Bearer', expires_in: 3600, scope: url.includes('googleapis') ? 'openid email https://www.googleapis.com/auth/calendar.app.created' : 'User.Read Calendars.ReadWrite' });
    if (url.includes('/userinfo')) return json({ sub: 'google-subject', email: 'connected-google@example.test', email_verified: true });
    if (url.includes('/me?')) return json({ id: 'outlook-subject', mail: 'connected-outlook@example.test' });
    if (url.endsWith('/calendars')) return json({ id: url.includes('googleapis') ? 'google-calendar' : 'outlook-calendar', name: 'Farmer Daily' });
    if (url.includes('/events')) { const body = JSON.parse(options.body); return json({ id: body.id || 'outlook-event', htmlLink: 'https://calendar.google.com/calendar/event?eid=mock', webLink: 'https://outlook.live.com/calendar/item/mock' }); }
    throw new Error('Unexpected mock network endpoint');
  }
  const handler = createCalendarConnectionsHandler({ getContainer: () => container, now: () => timestamp, fetchImpl, env });
  async function call(method = 'GET', body, { owner = OWNER, headers = {}, identity = {} } = {}) {
    const context = { log: { error() {} } };
    const principal = { userId: owner, identityProvider: 'aad', userDetails: owner === 'admin' ? 'admin1@example.invalid' : 'farmer@example.test', userRoles: ['authenticated'], ...identity };
    await handler(context, { method, body, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', cookie: cookieJar, ...(owner ? { 'x-farmer-account-id': owner, 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64') } : {}), ...headers } });
    if (context.res.headers['Set-Cookie']) cookieJar = context.res.headers['Set-Cookie'].split(';')[0];
    return context.res;
  }
  const action = (action, values = {}, options) => call('POST', { action, ...values }, options);
  async function begin(provider = 'google') { const response = await action('begin', { provider, allowCalendarCreation: true }); assert.equal(response.status, 200, JSON.stringify(response.body)); return { response, state: new URL(response.body.authorizationUrl).searchParams.get('state'), cookie: cookieJar }; }
  async function connect(provider = 'google') { const flow = await begin(provider); const response = await action('complete', { provider, code: 'private-authorization-code', state: flow.state }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response; }
  const prepare = async provider => { const response = await action('prepare', { provider: provider || 'google', taskId: 'task-1' }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.proposal; };
  return { documents, requests, batches, save, current, account, container, call, action, begin, connect, prepare, state: () => current(`state-${OWNER}`), calendar: () => current(`calendar-${OWNER}`), setNow: value => { timestamp = value; }, hook: fn => { batchHook = fn; }, onFetch: fn => { fetchHook = fn; } };
}

test('calendar metadata requires trusted owner identity and mandatory current-account header', async () => {
  const f = fixture();
  assert.equal((await f.call('GET', null, { owner: null })).status, 401);
  assert.equal((await f.call('GET', null, { identity: { identityProvider: 'google' } })).status, 401);
  assert.equal((await f.call('GET', null, { headers: { 'x-farmer-account-id': '' } })).status, 409);
  assert.equal((await f.call('GET', null, { headers: { 'x-farmer-account-id': 'other' } })).status, 409);
  const response = await f.call(); assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.body.providers.length, 2);
  assert.equal(f.calendar(), undefined); assert.equal(f.requests.length, 0);
});
test('missing provider configuration is honest and environment names are administrator-only', async () => {
  const f = fixture({});
  const regular = await f.call(); assert.equal(regular.body.providers[0].configured, false); assert.equal(regular.body.providers[0].setupRequired, undefined);
  assert.equal((await f.action('begin', { provider: 'google', allowCalendarCreation: true })).status, 503);
  f.save(f.account('admin')); const admin = await f.call('GET', null, { owner: 'admin' });
  assert.ok(admin.body.providers[0].setupRequired.includes('CALENDAR_TOKEN_KEY')); assert.ok(admin.body.providers[0].setupRequired.includes('APP_ORIGIN')); assert.equal(f.requests.length, 0);
});
test('Google OAuth uses PKCE, distinct callback, encrypted verifier, browser cookie and one-time state', async () => {
  const f = fixture(), flow = await f.begin(), url = new URL(flow.response.body.authorizationUrl), pending = f.calendar().pending.google;
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), `${ENV.APP_ORIGIN}/calendar-callback/google`);
  assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(flow.response.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/); assert.match(flow.response.headers['Set-Cookie'], /Max-Age=600/);
  assert.notEqual(pending.stateHash, flow.state); assert.ok(!JSON.stringify(pending).includes(flow.state));
  const verifier = shared.decrypt(pending.verifier, configuration('google', ENV).key, OWNER, 'google').verifier;
  assert.equal(url.searchParams.get('code_challenge'), Buffer.from(shared.hash(verifier), 'hex').toString('base64url'));
  const response = await f.action('complete', { provider: 'google', state: flow.state, code: 'secret-code' });
  assert.equal(response.status, 200); assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
  const raw = JSON.stringify(f.calendar()); assert.ok(!raw.includes('PRIVATE_ACCESS_TOKEN')); assert.ok(!raw.includes('PRIVATE_REFRESH_TOKEN')); assert.ok(!raw.includes('secret-code')); assert.equal(f.calendar().pending.google, undefined);
  const count = f.requests.length; assert.equal((await f.action('complete', { provider: 'google', state: flow.state, code: 'secret-code' }, { headers: { cookie: flow.cookie } })).status, 409); assert.equal(f.requests.length, count);
});
test('OAuth rejects wrong provider, state, browser, expiry and owner without token exchange', async () => {
  for (const mode of ['provider', 'state', 'browser', 'expiry', 'owner']) {
    const f = fixture(), flow = await f.begin();
    if (mode === 'expiry') f.setNow(NOW + shared.FLOW_MS + 1);
    if (mode === 'owner') { f.save(f.account('other')); f.save({ id: 'state-other', userId: 'other', state: { profile: {} } }); }
    const response = await f.action('complete', { provider: mode === 'provider' ? 'outlook' : 'google', state: mode === 'state' ? 'different-state' : flow.state, code: 'secret-code' }, { owner: mode === 'owner' ? 'other' : OWNER, headers: mode === 'browser' ? { cookie: 'fd_calendar_google=wrong' } : { cookie: flow.cookie } });
    assert.equal(response.status, 409, mode); assert.equal(f.requests.length, 0, mode);
  }
});
test('calendar creation requires explicit consent and never automatically repeats an ambiguous creation', async () => {
  const f = fixture(); assert.equal((await f.action('begin', { provider: 'google' })).status, 400);
  const flow = await f.begin(); f.onFetch(url => { if (url.endsWith('/calendars')) throw new Error('provider disconnected after creation'); });
  const response = await f.action('complete', { provider: 'google', code: 'secret-code', state: flow.state });
  assert.equal(response.status, 409); assert.equal(f.calendar().pending.google.status, 'uncertain');
  assert.equal((await f.action('begin', { provider: 'google', allowCalendarCreation: true })).status, 409);
  assert.equal(f.requests.filter(item => item.url.endsWith('/calendars')).length, 1);
  assert.equal((await f.call()).body.providers[0].needsReconnect, true);
});
test('both providers connect independently and expose only sanitized metadata', async () => {
  const f = fixture(); await f.connect('google'); await f.connect('outlook');
  const response = await f.call(); assert.ok(response.body.providers.every(provider => provider.connected));
  assert.equal(response.body.providers[0].accountLabel, 'connected-google@example.test'); assert.equal(response.body.providers[1].accountLabel, 'connected-outlook@example.test');
  assert.ok(!JSON.stringify(response.body).includes('PRIVATE_')); assert.ok(!JSON.stringify(response.body).includes('calendarId')); assert.ok(!JSON.stringify(response.body).includes('generation'));
  assert.equal((await f.action('begin', { provider: 'google', allowCalendarCreation: true })).status, 409);
});
test('Google task approval copies minimal exact snapshot once with private visibility, no reminders or guests', async () => {
  const f = fixture(); await f.connect(); const proposal = await f.prepare();
  assert.equal(proposal.preview.startUtc, '2026-10-18T16:30:00.000Z'); assert.equal(proposal.preview.endUtc, '2026-10-18T17:30:00.000Z'); assert.equal(proposal.preview.timeZone, 'America/Los_Angeles');
  assert.ok(!JSON.stringify(proposal).includes('private note')); assert.ok(!JSON.stringify(proposal).includes('Private field address')); assert.equal(f.requests.filter(request => request.url.includes('/events')).length, 0);
  assert.equal((await f.action('execute', { proposalId: proposal.id })).status, 400);
  const result = await f.action('execute', { proposalId: proposal.id, approved: true }); assert.equal(result.status, 200); assert.equal(result.body.proposal.status, 'executed');
  const request = f.requests.find(item => item.url.includes('/events')), event = JSON.parse(request.options.body);
  assert.match(event.id, /^[a-f0-9]{64}$/); assert.equal(event.summary, task().name); assert.equal(event.visibility, 'private'); assert.deepEqual(event.reminders, { useDefault: false }); assert.equal(event.attendees, undefined); assert.equal(event.description, undefined); assert.equal(event.location, undefined); assert.ok(request.url.endsWith('sendUpdates=none'));
  const repeated = await f.action('execute', { proposalId: proposal.id, approved: true }); assert.equal(repeated.status, 200); assert.equal(repeated.body.result.alreadyExecuted, true); assert.equal(f.requests.filter(request => request.url.includes('/events')).length, 1);
  assert.equal((await f.action('prepare', { provider: 'google', taskId: 'task-1' })).status, 409);
});
test('Outlook all-day copies use exclusive next date, Pacific zone and transaction ID without invites', async () => {
  const f = fixture(), state = f.state(); state.state.tasks[0].time = ''; f.save(state); await f.connect('outlook');
  const proposal = await f.prepare('outlook'); assert.equal(proposal.preview.allDay, true); assert.equal(proposal.preview.endDate, '2026-10-19');
  assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 200);
  const event = JSON.parse(f.requests.find(item => item.url.includes('/events')).options.body);
  assert.equal(event.transactionId, proposal.id); assert.equal(event.sensitivity, 'private'); assert.equal(event.isReminderOn, false); assert.equal(event.isAllDay, true); assert.equal(event.start.timeZone, 'Pacific Standard Time'); assert.equal(event.end.dateTime, '2026-10-19T00:00:00'); assert.equal(event.attendees, undefined);
});
test('changed task, stale proposal, completed task and connection generation cannot execute', async () => {
  for (const mode of ['changed', 'expired', 'done', 'generation']) {
    const f = fixture(); await f.connect(); const proposal = await f.prepare();
    if (mode === 'expired') f.setNow(NOW + shared.FLOW_MS + 1);
    else if (mode === 'generation') { const doc = f.calendar(); doc.connections.google.generation = 'replacement'; f.save(doc); }
    else { const state = f.state(); if (mode === 'done') state.state.tasks[0].done = true; else state.state.tasks[0].name = 'Changed task'; f.save(state); }
    assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 409, mode); assert.equal(f.requests.filter(item => item.url.includes('/events')).length, 0);
  }
});
test('simultaneous task edits, farm deletion, approval revocation and disconnect abort send atomically', async () => {
  for (const mode of ['state', 'delete', 'approval', 'disconnect']) {
    const f = fixture(); await f.connect(); const proposal = await f.prepare();
    f.hook(() => {
      if (mode === 'state') { const state = f.state(); state.state.tasks[0].name = 'Changed'; f.save(state); }
      if (mode === 'delete') f.documents.delete(`${OWNER}/state-${OWNER}`);
      if (mode === 'approval') f.save(f.account(OWNER, { plan: 'free', request: null }));
      if (mode === 'disconnect') { const doc = f.calendar(); delete doc.connections.google; f.save(doc); }
    });
    assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 409, mode); assert.equal(f.requests.filter(item => item.url.includes('/events')).length, 0);
  }
});
test('ambiguous provider event response is retained as unknown and never resent or removable', async () => {
  const f = fixture(); await f.connect(); const proposal = await f.prepare(); f.onFetch(url => { if (url.includes('/events')) throw new Error('private network failure'); });
  const response = await f.action('execute', { proposalId: proposal.id, approved: true }); assert.equal(response.status, 409); assert.ok(!JSON.stringify(response).includes('private network failure'));
  assert.equal(f.calendar().proposals[0].status, 'unknown');
  assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 409); assert.equal((await f.action('deleteProposal', { proposalId: proposal.id })).status, 409); assert.equal((await f.action('cancel', { proposalId: proposal.id })).status, 409);
  assert.equal(f.requests.filter(item => item.url.includes('/events')).length, 1);
});
test('disconnect or deletion during an event response cannot resurrect tokens or record a false success', async () => {
  for (const mode of ['disconnect', 'delete']) {
    const f = fixture(); await f.connect(); const proposal = await f.prepare();
    f.onFetch(url => { if (url.includes('/events')) { if (mode === 'delete') { f.documents.delete(`${OWNER}/state-${OWNER}`); f.documents.delete(`${OWNER}/calendar-${OWNER}`); } else { const doc = f.calendar(); delete doc.connections.google; f.save(doc); } } });
    assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 409);
    assert.equal(f.calendar()?.connections.google, undefined); assert.equal(f.calendar()?.proposals[0]?.status === 'executed', false); assert.equal(f.requests.filter(item => item.url.includes('/events')).length, 1);
  }
});
test('expired access tokens refresh server-side and token failure never starts an event write', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); await f.connect(); const doc = f.calendar(), config = configuration('google', ENV), tokens = shared.decrypt(doc.connections.google.secret, config.key, OWNER, 'google'); tokens.expiresAt = NOW - 1; doc.connections.google.secret = shared.encrypt(tokens, config.key, OWNER, 'google'); f.save(doc);
    const proposal = await f.prepare(); if (fail) f.onFetch(url => { if (url.includes('/token')) return new Response('PRIVATE_ERROR', { status: 400 }); });
    const response = await f.action('execute', { proposalId: proposal.id, approved: true }); assert.equal(response.status, fail ? 409 : 200);
    assert.equal(f.requests.filter(item => item.url.includes('/events')).length, fail ? 0 : 1);
    if (fail) { assert.equal(f.calendar().connections.google.needsReconnect, true); assert.equal(f.calendar().proposals[0].status, 'failed'); }
  }
});
test('downgraded users can view and remove credentials without starting new calendar actions', async () => {
  const f = fixture(); await f.connect(); const proposal = await f.prepare(); f.save(f.account(OWNER, { plan: 'free', request: null }));
  const response = await f.call(); assert.equal(response.status, 200); assert.equal(response.body.canConnect, false); assert.equal(response.body.providers[0].connected, true);
  assert.equal((await f.action('execute', { proposalId: proposal.id, approved: true })).status, 403);
  assert.equal((await f.action('prepare', { provider: 'google', taskId: 'task-1' })).status, 403);
  const disconnected = await f.action('disconnect', { provider: 'google' }); assert.equal(disconnected.status, 200); assert.equal(f.calendar().connections.google, undefined); assert.equal(f.calendar().proposals[0].status, 'cancelled');
  assert.match(disconnected.headers['Set-Cookie'], /Max-Age=0/); assert.equal((await f.action('deleteProposal', { proposalId: proposal.id })).status, 200);
});
test('exports exclude secrets and pending OAuth data; cleanup conditionally deletes owner credentials', async () => {
  const f = fixture(); await f.connect(); await f.prepare(); await f.begin('outlook');
  const exported = await shared.exportCalendarConnections(f.container, OWNER), text = JSON.stringify(exported);
  for (const secret of ['PRIVATE_', 'tokenSecret', 'stateHash', 'browserHash', 'verifier', 'generation', 'taskHash', 'providerAccountId']) assert.ok(!text.includes(secret), secret);
  assert.equal(exported.connections.length, 1); assert.equal(exported.proposals.length, 1);
  await shared.pruneCalendarConnections(f.container, OWNER); assert.equal(f.calendar(), undefined); await shared.pruneCalendarConnections(f.container, OWNER);
});
test('request shape, origin, media type and owner overrides are rejected without external writes', async () => {
  const f = fixture();
  for (const [body, options, expected] of [
    [{ action: 'begin', provider: 'google', allowCalendarCreation: true, userId: 'victim' }, {}, 400],
    [{ action: 'begin', provider: '__proto__', allowCalendarCreation: true }, {}, 400],
    [{ action: 'begin', provider: 'google', allowCalendarCreation: true }, { headers: { origin: 'https://evil.example.test' } }, 403],
    [{ action: 'begin', provider: 'google', allowCalendarCreation: true }, { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ action: 'begin', provider: 'google', allowCalendarCreation: true }, { headers: { 'content-type': 'text/plain' } }, 415]
  ]) assert.equal((await f.call('POST', body, options)).status, expected);
  assert.equal((await f.call('DELETE')).status, 405); assert.equal(f.requests.length, 0);
});
test('calendar time conversion rejects DST gaps and overlaps and handles real Pacific dates', () => {
  assert.equal(new Date(shared.pacificInstant('2026-10-18', '09:30')).toISOString(), '2026-10-18T16:30:00.000Z');
  assert.equal(new Date(shared.pacificInstant('2026-12-18', '09:30')).toISOString(), '2026-12-18T17:30:00.000Z');
  assert.throws(() => shared.pacificInstant('2027-03-14', '02:30'), error => error.status === 400);
  assert.throws(() => shared.pacificInstant('2026-11-01', '01:30'), error => error.status === 400);
});
