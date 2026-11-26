require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountHandler } = require('../api/account');
const { createAdminHandler } = require('../api/management');
const { createStateHandler } = require('../api/state');
const { createBriefHandler } = require('../api/brief');
const { createProtectedWeatherHandler } = require('../api/weather');
const { dateKey } = require('../api/shared/access');
const { locationKey } = require('../api/shared/field-geometry');

const clone = value => value === undefined ? undefined : structuredClone(value);
function fail(code) { const error = new Error('Simulated storage error'); error.code = code; return error; }

function memoryContainer() {
  const docs = new Map();
  let version = 0;
  const queries = [];
  const key = (id, userId) => `${userId}/${id}`;
  function save(doc) {
    const stored = { ...clone(doc), _etag: `version-${++version}` };
    docs.set(key(doc.id, doc.userId), stored);
    return { resource: clone(stored) };
  }
  return {
    docs, queries,
    item(id, userId) {
      return {
        async read() { const resource = docs.get(key(id, userId)); if (!resource) throw fail(404); return { resource: clone(resource) }; },
        async replace(doc, options) {
          const previous = docs.get(key(id, userId));
          if (!previous) throw fail(404);
          assert.equal(options?.accessCondition?.type, 'IfMatch');
          if (options.accessCondition.condition !== previous._etag) throw fail(412);
          assert.equal(doc.userId, userId);
          assert.equal(doc.id, id);
          return save(doc);
        },
        async delete() { if (!docs.delete(key(id, userId))) throw fail(404); }
      };
    },
    items: {
      async create(doc) { if (docs.has(key(doc.id, doc.userId))) throw fail(409); return save(doc); },
      async batch(operations, userId) {
        // Validate every operation before applying any, mirroring Cosmos atomic batches.
        for (let index = 0; index < operations.length; index += 1) {
          const operation = operations[index];
          const stored = docs.get(key(operation.id || operation.resourceBody.id, userId));
          const code = operation.operationType === 'Create' ? (stored ? 409 : 0)
            : !stored ? 404 : stored._etag !== operation.ifMatch ? 412 : 0;
          if (code) return { code, result: operations.map((unused, current) => ({ statusCode: current === index ? code : 424 })) };
          assert.equal(operation.resourceBody.userId, userId);
        }
        return { code: 200, result: operations.map(operation => ({ statusCode: operation.operationType === 'Create' ? 201 : 200, resourceBody: save(operation.resourceBody).resource })) };
      },
      query(spec, options) {
        queries.push({ spec: clone(spec), options: clone(options) });
        const values = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
        const matches = () => [...docs.values()].filter(doc => doc.type === values['@type'] && (!values['@userId'] || doc.userId === values['@userId']));
        return {
          async fetchNext() {
            const all = matches().sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
            const offset = Number(options.continuationToken || 0);
            const result = all.slice(offset, offset + options.maxItemCount).map(doc => Object.fromEntries(
              ['userId', 'email', 'identityProvider', 'joinedAt', 'lastSeenAt', 'plan', 'request'].map(field => [field, clone(doc[field])])
            ));
            return { resources: result, continuationToken: offset + options.maxItemCount < all.length ? String(offset + options.maxItemCount) : undefined };
          },
          async fetchAll() { return { resources: matches().map(clone) }; }
        };
      }
    }
  };
}

const farmer = { userId: 'farmer-1', userDetails: 'farmer@example.test', identityProvider: 'aad', userRoles: ['anonymous', 'authenticated'] };
const admin = { userId: 'admin-1', userDetails: 'admin1@example.invalid', identityProvider: 'aad', userRoles: ['anonymous', 'authenticated'] };
function request(method = 'GET', identity = farmer, body, query = {}, headers = {}) {
  return {
    method, query, body,
    headers: {
      host: 'calm-desert-02e51f41e.1.azurestaticapps.net',
      ...(identity ? { 'x-ms-client-principal': Buffer.from(JSON.stringify(identity)).toString('base64') } : {}),
      ...(['POST', 'PUT'].includes(method) ? { 'content-type': 'application/json', origin: 'https://calm-desert-02e51f41e.1.azurestaticapps.net' } : {}),
      ...headers
    }
  };
}
async function call(handler, req) { const context = { log: { error() {}, warn() {} } }; await handler(context, req); assert.equal(context.res.headers['Cache-Control'], 'no-store'); return context.res; }
function fixture() {
  const container = memoryContainer();
  let timestamp = Date.parse('2026-09-27T16:00:00Z');
  const options = { getContainer: () => container, now: () => timestamp };
  let weatherCalls = 0;
  let unavailable = false;
  const weatherHandler = async (context, req) => {
    weatherCalls += 1;
    assert.deepEqual(req.query, { lat: '47.6769', lon: '-122.206' });
    const tomorrow = new Date(Date.parse(`${dateKey(timestamp)}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    context.res = unavailable ? { status: 503 } : { status: 200, body: {
      fetchedAt: new Date(timestamp).toISOString(), updated: new Date(timestamp).toISOString(),
      hourly: [{ temperature: 62, temperatureUnit: 'F', startTime: new Date(timestamp - 1000).toISOString(), endTime: new Date(timestamp + 3600000).toISOString(), shortForecast: 'Cloudy', windSpeed: '4 mph', windDirection: 'NW' }],
      daily: [{ temperature: 66, temperatureUnit: 'F', isDaytime: true, startTime: `${tomorrow}T16:00:00Z`, endTime: `${tomorrow}T23:00:00Z`, shortForecast: 'Partly cloudy' }],
      source: { name: 'NOAA / National Weather Service', id: 'nws', url: 'https://forecast.weather.gov/MapClick.php?lat=47.6769&lon=-122.206' }, stale: false
    } };
  };
  const fieldDataService = { async getFieldData({ userId, field }) {
    assert.ok(userId === farmer.userId || userId === admin.userId);
    const context = {};
    await weatherHandler(context, { query: { lat: String(field.location.latitude), lon: String(field.location.longitude) } });
    return { fieldId: field.id, locationKey: locationKey(field), location: field.location,
      weather: context.res.status === 200 ? context.res.body : null, weatherStatus: unavailable ? 'unavailable' : 'live',
      alerts: { status: unavailable ? 'unavailable' : 'live', items: [], fetchedAt: new Date(timestamp).toISOString() },
      elevation: { status: 'unavailable', feet: null, meters: null } };
  } };
  return {
    container, options,
    account: createAccountHandler(options), admin: createAdminHandler(options), state: createStateHandler(options),
    brief: createBriefHandler({ ...options, weatherHandler, fieldDataService }), weather: createProtectedWeatherHandler({ ...options, weatherHandler }),
    setTime(value) { timestamp = Date.parse(value); }, setUnavailable(value) { unavailable = value; }, weatherCalls: () => weatherCalls
  };
}
const profile = { firstName: 'Sam', priorityField: 'West orchard', crops: ['Apples'], locationId: 'kirkland', address: 'Private address' };
const field = { id: 'west-orchard', name: 'West orchard', crop: 'Apples', location: { latitude: 47.6769, longitude: -122.206 }, dataConsent: true };
async function savedProfile(f, identity = farmer, extra = {}) { return call(f.state, request('PUT', identity, { profile, fields: [field], theme: 'field', ...extra })); }
async function approve(f, identity = farmer) {
  const pending = await call(f.account, request('POST', identity, { action: 'request-premium', reason: 'Farm planning' }));
  return call(f.admin, request('POST', admin, { action: 'approve', userId: identity.userId, requestId: pending.body.request.id }));
}

test('unauthenticated APIs reject access and any authenticated Microsoft user joins Free', async () => {
  const f = fixture();
  for (const handler of [f.account, f.admin, f.state, f.brief, f.weather]) assert.equal((await call(handler, request('GET', null))).status, 401);
  const joined = await call(f.account, request());
  assert.equal(joined.status, 200);
  assert.equal(joined.body.plan, 'free');
  assert.equal(joined.body.isAdmin, false);
  assert.equal(joined.body.user.joinedAt, '2026-09-27T16:00:00.000Z');
  assert.equal((await call(f.admin, request())).status, 403);
  assert.equal((await call(f.weather, request('GET', farmer, undefined, { lat: '47.6769', lon: '-122.206' }))).status, 200);
  assert.equal(f.weatherCalls(), 1);
});

test('all three exact administrators are Premium using trusted aad identities, with normalized casing', async () => {
  const f = fixture();
  const emails = [' admin1@example.invalid ', 'admin2@example.invalid', 'admin3@example.invalid'];
  for (const [index, email] of emails.entries()) {
    const identity = { ...admin, userId: `admin-${index}`, userDetails: email };
    const response = await call(f.account, request('GET', identity));
    assert.equal(response.body.isAdmin, true);
    assert.equal(response.body.plan, 'premium');
    assert.equal((await call(f.admin, request('GET', identity))).status, 200);
  }
  assert.equal((await call(f.account, request('GET', { ...admin, identityProvider: 'github' }))).status, 401);
  assert.equal((await call(f.account, request('GET', { ...admin, userRoles: ['anonymous'] }))).status, 401);
  assert.equal((await call(f.account, request('GET', { ...farmer, userDetails: 'admin1@example.invalid.attacker.test' }))).body.isAdmin, false);
});

test('profile email and client entitlements cannot grant administrator or Premium access', async () => {
  const f = fixture();
  assert.equal((await call(f.state, request('PUT', farmer, { profile: { ...profile, email: admin.userDetails, isAdmin: true, plan: 'premium' }, theme: 'field' }))).status, 200);
  for (const field of ['plan', 'isAdmin', 'request', 'userId']) {
    assert.equal((await call(f.state, request('PUT', farmer, { profile, [field]: 'premium' }))).status, 400);
  }
  const result = await call(f.account, request());
  assert.equal(result.body.plan, 'free');
  assert.equal(result.body.isAdmin, false);
  assert.equal((await call(f.admin, request('POST', farmer, { action: 'approve', userId: farmer.userId, requestId: 'fake' }))).status, 403);
});

test('Premium requests are idempotent during concurrent requests; approval unlocks Frontier features', async () => {
  const f = fixture();
  assert.equal((await call(f.state, request('PUT', farmer, { jobs: [] }))).status, 403);
  const results = await Promise.all(Array.from({ length: 8 }, () => call(f.account, request('POST', farmer, { action: 'request-premium', reason: 'Use jobs' }))));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(new Set(results.map(result => result.body.request.id)).size, 1);
  const pending = results[0].body.request;
  const accepted = await call(f.admin, request('POST', admin, { action: 'approve', userId: farmer.userId, requestId: pending.id }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.user.plan, 'premium');
  assert.equal(accepted.body.user.request.decidedBy, admin.userDetails);
  const stored = (await f.container.item(`account-${farmer.userId}`, farmer.userId).read()).resource;
  assert.equal(stored.requestHistory.length, 1);
  assert.equal(stored.requestHistory[0].decidedByUserId, admin.userId);
  assert.equal((await call(f.weather, request('GET', farmer, undefined, { lat: '47.6769', lon: '-122.206' }))).status, 200);
  assert.equal((await call(f.state, request('PUT', farmer, { jobs: [], observations: [] }))).status, 200);
  assert.equal((await call(f.account, request('POST', farmer, { action: 'request-premium' }))).body.request.id, pending.id);
});

test('two admins cannot overwrite a decision; declined users may make a new request', async () => {
  const f = fixture();
  const pending = (await call(f.account, request('POST', farmer, { action: 'request-premium' }))).body.request;
  const decisions = await Promise.all(['approve', 'decline'].map(action => call(f.admin, request('POST', admin, { action, userId: farmer.userId, requestId: pending.id }))));
  assert.deepEqual(decisions.map(result => result.status).sort(), [200, 409]);
  const another = { ...farmer, userId: 'farmer-declined' };
  const first = (await call(f.account, request('POST', another, { action: 'request-premium' }))).body.request;
  assert.equal((await call(f.admin, request('POST', admin, { action: 'decline', userId: another.userId, requestId: first.id }))).status, 200);
  const second = (await call(f.account, request('POST', another, { action: 'request-premium', reason: 'Please reconsider' }))).body.request;
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'pending');
  assert.equal((await call(f.admin, request('POST', admin, { action: 'approve', userId: another.userId, requestId: first.id }))).status, 409);
});

test('admin directory paginates only account metadata and non-admin cannot enumerate users', async () => {
  const f = fixture();
  await savedProfile(f);
  for (let index = 0; index < 52; index += 1) await call(f.account, request('GET', { ...farmer, userId: `directory-${index}` }));
  const first = await call(f.admin, request('GET', admin));
  assert.equal(first.body.users.length, 50);
  assert.ok(first.body.cursor);
  const second = await call(f.admin, request('GET', admin, undefined, { cursor: first.body.cursor }));
  assert.equal(second.body.users.length, 4);
  assert.equal(second.body.cursor, null);
  assert.ok(!JSON.stringify(first.body).includes(profile.address));
  assert.ok(first.body.users.every(user => !('profile' in user) && !('state' in user) && !('requestHistory' in user)));
  assert.equal((await call(f.admin, request())).status, 403);
});

test('Free state hides Premium arrays and preserves them when saving profile; own export remains available', async () => {
  const f = fixture();
  await f.container.items.create({ id: `state-${farmer.userId}`, userId: farmer.userId, type: 'state', state: { profile, theme: 'field', tasks: [{ name: 'Private task' }], jobs: [{ title: 'Old job' }] } });
  const normal = await call(f.state, request());
  assert.equal(normal.body.tasks[0].name, 'Private task');
  assert.equal(normal.body.jobs, undefined);
  assert.equal((await savedProfile(f)).status, 200);
  const exported = await call(f.state, request('GET', farmer, undefined, { export: '1' }));
  assert.equal(exported.body.tasks[0].name, 'Private task');
  assert.equal(exported.body.jobs[0].title, 'Old job');
  for (const field of ['observations', 'jobs', 'jobEvents']) assert.equal((await call(f.state, request('PUT', farmer, { profile, [field]: [] }))).status, 403);
  assert.equal((await call(f.state, request('PUT', farmer, { tasks: [] }))).status, 200);
  const other = await call(f.state, request('GET', { ...farmer, userId: 'different-user' }, undefined, { export: '1', userId: farmer.userId }));
  assert.equal(other.status, 204);
  assert.equal(other.body, undefined);
});

test('first sign-in and deleted profiles have an explicit empty-state response on every plan', async () => {
  for (const identity of [farmer, admin]) {
    const f = fixture();
    assert.equal((await call(f.account, request('GET', identity))).status, 200);
    for (const query of [{}, { export: '1' }]) {
      const empty = await call(f.state, request('GET', identity, undefined, query));
      assert.equal(empty.status, 204);
      assert.equal(Object.hasOwn(empty, 'body'), false, 'No ambiguous null/empty JSON body');
    }
    assert.equal(f.container.docs.has(`${identity.userId}/state-${identity.userId}`), false);
    await savedProfile(f, identity);
    const saved = await call(f.state, request('GET', identity));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.profile.firstName, profile.firstName);
    await call(f.state, request('DELETE', identity));
    const deleted = await call(f.state, request('GET', identity));
    assert.equal(deleted.status, 204);
    assert.equal(Object.hasOwn(deleted, 'body'), false);
    assert.equal((await call(f.account, request('GET', identity))).status, 200, 'Farm deletion does not remove account access');
  }
});

test('Free daily brief is one server-owned saved snapshot across concurrent calls and devices, with bounded explicit refresh', async () => {
  const f = fixture();
  assert.equal((await savedProfile(f)).status, 200);
  const missing = await call(f.brief, request());
  assert.equal(missing.body.brief, null);
  const generated = await Promise.all(Array.from({ length: 6 }, () => call(f.brief, request('POST', farmer, { locationId: 'yakima', date: '2099-01-01', lat: '0', lon: '0' }))));
  assert.ok(generated.every(response => response.status === 200));
  assert.equal(f.weatherCalls(), 1, 'Concurrent requests share one field-data lookup');
  assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 1);
  assert.ok(generated.every(response => JSON.stringify(response.body.brief) === JSON.stringify(generated[0].body.brief)));
  assert.equal(generated[0].body.brief.fieldSummaries[0].fieldId, field.id);
  assert.equal(generated[0].body.brief.fieldSummaries[0].sourceId, 'nws');
  assert.equal(generated[0].body.brief.fieldSummaries[0].locationKey, locationKey(field));
  assert.equal(generated[0].body.brief.coverage.reviewedFields, 1);
  assert.ok(generated[0].body.brief.advisories.some(item => item.fieldId === field.id));
  assert.ok(!JSON.stringify(generated[0].body.brief).includes(profile.address));
  const calls = f.weatherCalls();
  await call(f.state, request('PUT', farmer, { profile: { ...profile, locationId: 'yakima' } }));
  const repeated = await call(f.brief, request('POST', farmer, {}));
  assert.equal(repeated.body.brief.fieldSummaries[0].locationKey, locationKey(field));
  assert.equal(repeated.body.reused, true);
  assert.equal(f.weatherCalls(), calls);
  const rapidRefresh = await call(f.brief, request('POST', farmer, { refresh: true }));
  assert.equal(rapidRefresh.status, 200);
  assert.equal(rapidRefresh.body.reused, true);
  assert.equal(f.weatherCalls(), calls);
  f.setTime('2026-09-27T16:01:01Z');
  const refreshed = await call(f.brief, request('POST', farmer, { refresh: true }));
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.reused, false);
  assert.equal(f.weatherCalls(), calls + 1);
  assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 1);
});

test('daily snapshot date uses Pacific midnight, including daylight-saving boundary; client dates cannot change it', async () => {
  const f = fixture();
  await savedProfile(f);
  f.setTime('2026-09-28T06:59:59Z');
  assert.equal((await call(f.brief, request('POST', farmer, {}))).body.date, '2026-09-27');
  f.setTime('2026-09-28T07:00:01Z');
  const next = await call(f.brief, request('POST', farmer, { date: '2026-09-27' }));
  assert.equal(next.body.date, '2026-09-28');
  assert.equal(next.body.reused, false);
  assert.equal(dateKey(Date.parse('2026-11-01T08:59:00Z')), '2026-11-01');
  assert.equal(dateKey(Date.parse('2026-11-01T09:01:00Z')), '2026-11-01');
});

test('weather failures remain explicit unavailable priorities and Free can refresh after recovery', async () => {
  const f = fixture();
  await savedProfile(f);
  f.setUnavailable(true);
  const unavailable = await call(f.brief, request('POST', farmer, {}));
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.body.brief.advisories[0].kind, 'unavailable');
  assert.equal(unavailable.body.brief.coverage.weatherAvailableFields, 0);
  f.setUnavailable(false);
  f.setTime('2026-09-27T16:01:01Z');
  const recovered = await call(f.brief, request('POST', farmer, { refresh: true }));
  assert.equal(recovered.body.reused, false);
  assert.equal(recovered.body.brief.advisories[0].kind, 'conditions');
  assert.equal(recovered.body.brief.coverage.weatherAvailableFields, 1);
});

test('missing fields produce setup guidance instead of using client or community coordinates', async () => {
  const f = fixture();
  assert.equal((await call(f.brief, request('POST', farmer, { locationId: 'kirkland' }))).status, 409);
  await call(f.state, request('PUT', farmer, { profile: { ...profile, locationId: '__proto__' } }));
  const setup = await call(f.brief, request('POST', farmer, { locationId: 'kirkland', lat: '47.6', lon: '-122.2' }));
  assert.equal(setup.status, 200);
  assert.equal(setup.body.brief.advisories[0].kind, 'setup');
  assert.equal(setup.body.brief.coverage.reviewedFields, 0);
  assert.equal(f.weatherCalls(), 0);
});

test('approved Premium and admins can refresh their own brief', async () => {
  const f = fixture();
  await approve(f);
  await savedProfile(f);
  const first = await call(f.brief, request('POST', farmer, {}));
  f.setTime('2026-09-27T17:00:00Z');
  const refreshed = await call(f.brief, request('POST', farmer, { refresh: true }));
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.brief.createdAt, first.body.brief.createdAt);
  await savedProfile(f, admin);
  assert.equal((await call(f.brief, request('POST', admin, { refresh: true }))).status, 200);
});

test('deleting farm data redacts briefs and leaves only its daily tombstone plus account/audit', async () => {
  const f = fixture();
  await savedProfile(f);
  await call(f.brief, request('POST', farmer, {}));
  await call(f.account, request('POST', farmer, { action: 'request-premium' }));
  assert.equal((await call(f.state, request('DELETE'))).status, 204);
  assert.equal((await call(f.state, request())).status, 204);
  const tombstone = await call(f.brief, request('GET', farmer));
  assert.equal(tombstone.body.deleted, true);
  assert.equal(tombstone.body.used, true);
  assert.equal(tombstone.body.brief, null);
  assert.equal((await call(f.brief, request('POST', farmer, {}))).status, 409, 'A new farm setup is required before creating private brief content again');
  assert.equal((await call(f.account, request())).body.request.status, 'pending');
  const remaining = JSON.stringify([...f.container.docs.values()]);
  assert.ok(!remaining.includes(profile.address));
  assert.ok(!remaining.includes(profile.priorityField));
});

test('mutations reject cross-site requests, invalid JSON media types, oversized reasons and oversized state', async () => {
  const f = fixture();
  assert.equal((await call(f.account, request('POST', farmer, { action: 'request-premium' }, {}, { origin: 'https://attacker.test' }))).status, 403);
  assert.equal((await call(f.account, request('POST', farmer, { action: 'request-premium' }, {}, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await call(f.account, request('POST', farmer, { action: 'request-premium' }, {}, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await call(f.account, request('POST', farmer, { action: 'request-premium', reason: 'x'.repeat(1001) }))).status, 400);
  assert.equal((await call(f.state, request('PUT', farmer, { profile: { note: 'x'.repeat(512 * 1024) } }))).status, 413);
});

test('storage failures fail closed even for administrators', async () => {
  const unavailable = () => { throw new Error('Unavailable'); };
  const account = createAccountHandler({ getContainer: unavailable });
  const weather = createProtectedWeatherHandler({ getContainer: unavailable, weatherHandler: () => assert.fail('must not run') });
  assert.equal((await call(account, request('GET', admin))).status, 503);
  assert.equal((await call(weather, request('GET', admin))).status, 503);
});

test('stale-tab account header mismatch blocks account changes and private access before storage', async () => {
  const f = fixture();
  for (const handler of [f.account, f.state, f.brief, f.weather]) {
    assert.equal((await call(handler, request('GET', farmer, undefined, {}, { 'x-farmer-account-id': 'other-account' }))).status, 409);
  }
  assert.equal((await call(f.state, request('PUT', farmer, { profile }, {}, { 'x-farmer-account-id': 'other-account' }))).status, 409);
  assert.equal(f.container.docs.size, 0);
});

test('deletion during in-flight brief generation cannot recreate private data', async () => {
  const f = fixture();
  await savedProfile(f);
  let releaseWeather;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pausedWeather = new Promise(resolve => { releaseWeather = resolve; });
  const brief = createBriefHandler({ ...f.options, fieldDataService: { getFieldData: async ({ userId, field: selected }) => {
    assert.equal(userId, farmer.userId);
    assert.equal(selected.id, field.id);
    markStarted();
    await pausedWeather;
    return { fieldId: field.id, weatherStatus: 'unavailable', weather: null, alerts: { status: 'unavailable', items: [] }, elevation: { status: 'unavailable' } };
  } } });
  const inFlight = call(brief, request('POST', farmer, {}));
  await started;
  assert.equal((await call(f.state, request('DELETE'))).status, 204);
  releaseWeather();
  assert.equal((await inFlight).status, 409);
  assert.ok(!JSON.stringify([...f.container.docs.values()]).includes(profile.priorityField));
  assert.equal((await call(f.brief, request())).body.used, false);
});
