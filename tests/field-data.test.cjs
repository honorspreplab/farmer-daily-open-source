require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldDataService, contextId } = require('../api/shared/field-data');
const { createFieldDataHandler } = require('../api/field-data');
const { createStateHandler } = require('../api/state');
const { locationKey } = require('../api/shared/field-geometry');
const NOW = Date.parse('2026-10-03T17:00:00Z');
const owner = 'geo-farmer';
const field = { id: 'block-a', name: 'Private Block A', crop: 'Apples', location: { latitude: 47.68, longitude: -122.2 }, dataConsent: true };
const clone = value => structuredClone(value);
const error = code => Object.assign(new Error('Fixture storage error'), { code });

function fixture({ fetchOverride, weatherOverride, timeoutMs = 40 } = {}) {
  const documents = new Map(), calls = [], accesses = [];
  let version = 0, timestamp = NOW, beforeBatch;
  const key = (id, userId) => `${userId}/${id}`;
  function save(doc) { const stored = { ...clone(doc), _etag: String(++version) }; documents.set(key(doc.id, doc.userId), stored); return { resource: clone(stored) }; }
  const container = {
    item(id, userId) {
      accesses.push({ id, userId });
      return {
        async read() { const stored = documents.get(key(id, userId)); if (!stored) throw error(404); return { resource: clone(stored) }; },
        async replace(doc, options) { const stored = documents.get(key(id, userId)); if (!stored) throw error(404); if (options?.accessCondition?.condition !== stored._etag) throw error(412); return save(doc); },
        async delete(options) { const stored = documents.get(key(id, userId)); if (!stored) throw error(404); if (options?.accessCondition && options.accessCondition.condition !== stored._etag) throw error(412); documents.delete(key(id, userId)); }
      };
    },
    items: {
      async create(doc) { if (documents.has(key(doc.id, doc.userId))) throw error(409); return save(doc); },
      query(spec, options) {
        const parameters = Object.fromEntries(spec.parameters.map(item => [item.name, item.value]));
        const directory = parameters['@type'] === 'messagingRecipient';
        if (directory) {
          assert.equal(options.partitionKey, 'messaging-directory');
          assert.equal(typeof parameters['@bindingOwner'], 'string');
          assert.match(spec.query, /c\.owner = @bindingOwner/);
        } else assert.equal(parameters['@userId'] || parameters['@owner'], options.partitionKey);
        return { async fetchAll() { return { resources: [...documents.values()].filter(doc => doc.userId === options.partitionKey && doc.type === parameters['@type'] && (!directory || doc.owner === parameters['@bindingOwner'])).map(clone) }; } };
      },
      async batch(operations, userId) {
        if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; await hook(); }
        for (const op of operations) {
          const id = op.id || op.resourceBody.id, stored = documents.get(key(id, userId));
          assert.equal(op.resourceBody.userId, userId);
          if (op.operationType === 'Create' && stored) throw error(409);
          if (op.operationType === 'Replace' && (!stored || stored._etag !== op.ifMatch)) throw error(stored ? 412 : 404);
        }
        return { code: 200, result: operations.map(op => ({ statusCode: 200, resourceBody: save(op.resourceBody).resource })) };
      }
    }
  };
  save({ id: `state-${owner}`, userId: owner, type: 'state', state: { fields: [clone(field)], profile: { firstName: 'Sam' } } });
  save({ id: `account-${owner}`, userId: owner, type: 'account', email: 'geo@example.test', identityProvider: 'aad', plan: 'free', request: null });
  const weather = async (context, req) => { calls.push({ weather: clone(req.query) }); if (weatherOverride) return weatherOverride(context, req); context.res = { status: 200, body: { source: { id: 'nws' }, fetchedAt: new Date(timestamp).toISOString(), hourly: [], daily: [] } }; };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (fetchOverride) return fetchOverride(url, options);
    return response(url.startsWith('https://epqs.') ? { value: 91.7 } : alerts(timestamp));
  };
  const service = createFieldDataService({ getContainer: () => container, fetchImpl, now: () => timestamp, weatherHandler: weather, timeoutMs });
  const handler = createFieldDataHandler({ getContainer: () => container, now: () => timestamp, fieldDataService: service });
  const stateHandler = createStateHandler({ getContainer: () => container, now: () => timestamp });
  async function request(target, method = 'GET', body, query = {}, userId = owner, email = 'geo@example.test') {
    const context = { log: { error() {} } };
    await target(context, { method, body, query, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json',
      ...(userId ? { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId, userDetails: email, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64') } : {}) } });
    return context.res;
  }
  return { documents, calls, accesses, container, save, service, setNow: value => { timestamp = value; }, beforeBatch: callback => { beforeBatch = callback; },
    state: () => documents.get(key(`state-${owner}`, owner)),
    field: () => clone(documents.get(key(`state-${owner}`, owner)).state.fields[0]),
    request: (query = { fieldId: field.id }, userId = owner, email) => request(handler, 'GET', undefined, query, userId, email),
    stateRequest: (method, body, query = {}) => request(stateHandler, method, body, query)
  };
}
function response(body) { return { ok: true, headers: { get() { return null; } }, async json() { return clone(body); } }; }
function alerts(timestamp, features = []) { return { type: 'FeatureCollection', updated: new Date(timestamp).toISOString(), features }; }
function alert(timestamp, changes = {}) {
  return { id: 'https://api.weather.gov/alerts/urn:oid:example', properties: { id: 'urn:oid:example', status: 'Actual', event: 'Wind Advisory', severity: 'Moderate', headline: 'Wind Advisory issued', description: 'Wind may affect field work.', instruction: 'Read official instructions.', effective: new Date(timestamp - 60000).toISOString(), expires: new Date(timestamp + 3600000).toISOString(), ...changes } };
}

test('Free field data uses only stored consented coordinates and privately caches elevation', async () => {
  const f = fixture();
  const result = await f.request({ fieldId: field.id, lat: '0', lon: '0', userId: 'other' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.elevation.feet, 91.7);
  assert.equal(result.body.elevation.meters, 91.7 * 0.3048);
  assert.equal(result.body.alerts.status, 'live');
  assert.equal(result.body.weatherStatus, 'live');
  assert.ok(f.calls.some(call => call.url === 'https://epqs.nationalmap.gov/v1/json?x=-122.2&y=47.68&units=Feet&wkid=4326&includeDate=false'));
  assert.ok(f.calls.filter(call => call.url).every(call => call.options.redirect === 'error' && !call.url.includes('Private') && !call.url.includes('Apples')));
  const firstCount = f.calls.filter(call => call.url).length;
  await f.request();
  assert.equal(f.calls.filter(call => call.url).length, firstCount);
  const exported = await f.stateRequest('GET', undefined, { export: '1' });
  assert.equal(exported.body.derivedFieldData.length, 1);
  assert.equal(exported.body.derivedFieldData[0].fieldId, field.id);
  assert.equal((await f.stateRequest('GET')).body.derivedFieldData, undefined);
});

test('source outages are partial results and missing elevation is never converted to zero', async () => {
  for (const value of [null, -1000000, '91.7', Infinity]) {
    const f = fixture({ fetchOverride: async url => response(url.startsWith('https://epqs.') ? { value } : alerts(NOW)) });
    const result = await f.request();
    assert.equal(result.status, 200); assert.equal(result.body.elevation.status, 'unavailable'); assert.equal(result.body.elevation.feet, null); assert.equal(result.body.weatherStatus, 'live');
  }
  const f = fixture({ fetchOverride: async () => { throw new Error('Offline'); }, weatherOverride: async context => { context.res = { status: 503 }; } });
  const result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.weatherStatus, 'unavailable'); assert.equal(result.body.alerts.status, 'unavailable'); assert.equal(result.body.elevation.status, 'unavailable');
});

test('external calls time out even if a provider does not implement abort', async () => {
  const f = fixture({ fetchOverride: () => new Promise(() => {}), timeoutMs: 5 });
  const result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.elevation.status, 'unavailable'); assert.equal(result.body.alerts.status, 'unavailable');
});

test('brief-only elevation lookup reads a valid cache without fetching or writing, while explicit field refresh still enriches it', async () => {
  const f = fixture();
  const cold = await f.service.getFieldData({userId:owner,field:f.field(),cacheOnlyElevation:true});
  assert.equal(cold.elevation.status,'unavailable'); assert.equal(cold.elevation.feet,null);
  assert.equal(f.calls.filter(call=>call.url?.startsWith('https://epqs.')).length,0);
  assert.equal([...f.documents.values()].filter(doc=>doc.type==='fieldContext').length,0);
  assert.equal((await f.request()).body.elevation.status,'loaded');
  const stored=(await f.container.item(contextId(owner,field.id),owner).read()).resource;
  const cached=await f.service.getFieldData({userId:owner,field:f.field(),cacheOnlyElevation:true});
  assert.equal(cached.elevation.feet,91.7);
  assert.equal(f.calls.filter(call=>call.url?.startsWith('https://epqs.')).length,1);
  assert.deepEqual((await f.container.item(contextId(owner,field.id),owner).read()).resource,stored);
  f.setNow(NOW+366*86400000);
  assert.equal((await f.service.getFieldData({userId:owner,field:f.field(),cacheOnlyElevation:true})).elevation.status,'unavailable');
  assert.equal(f.calls.filter(call=>call.url?.startsWith('https://epqs.')).length,1);
});

test('an expired brief source budget prevents a late-start field lookup from sending external requests', async () => {
  const f=fixture(), controller=new AbortController(); controller.abort();
  await assert.rejects(f.service.getFieldData({userId:owner,field:f.field(),cacheOnlyElevation:true,signal:controller.signal}),{name:'AbortError'});
  assert.equal(f.calls.length,0);
});

test('alerts preserve official instructions; stale, expired, invalid and unexpected feeds are unavailable rather than no alerts', async () => {
  const f = fixture({ fetchOverride: async url => response(url.startsWith('https://epqs.') ? { value: 30 } : alerts(NOW, [alert(NOW)])) });
  const result = await f.request();
  assert.equal(result.body.alerts.items[0].instruction, 'Read official instructions.');
  assert.equal((await f.request()).body.alerts.status, 'cached');
  for (const bad of [{}, alerts(NOW - 3600000), alerts(NOW, [alert(NOW, { expires: new Date(NOW - 1000).toISOString() })]), alerts(NOW, [alert(NOW, { status: 'Test' })]), alerts(NOW, [{ ...alert(NOW), id: 'https://evil.example/alerts/one' }])]) {
    const broken = fixture({ fetchOverride: async url => response(url.startsWith('https://epqs.') ? { value: 30 } : bad) });
    assert.equal((await broken.request()).body.alerts.status, 'unavailable');
  }
});

test('optional alert sent times preserve normalized ISO timestamps and reject malformed or future notices', async () => {
  for (const [sent, expected] of [
    [undefined, undefined],
    ['2026-10-03T09:59:00-07:00', '2026-10-03T16:59:00.000Z'],
    [new Date(NOW + 60000).toISOString(), new Date(NOW + 60000).toISOString()]
  ]) {
    const f = fixture({ fetchOverride: async url => response(url.startsWith('https://epqs.') ? { value: 30 } : alerts(NOW, [alert(NOW, { sent })])) });
    const result = await f.request();
    assert.equal(result.body.alerts.status, 'live');
    assert.equal(result.body.alerts.items[0].sent, expected);
    assert.equal(Object.hasOwn(result.body.alerts.items[0], 'sent'), sent !== undefined);
  }
  for (const sent of [null, NOW, '', 'yesterday', '2026-10-03T17:00:00', '2026-02-30T17:00:00Z', '2026-10-03T24:00:00Z', new Date(NOW + 60001).toISOString()]) {
    const f = fixture({ fetchOverride: async url => response(url.startsWith('https://epqs.') ? { value: 30 } : alerts(NOW, [alert(NOW, { sent })])) });
    const result = await f.request();
    assert.equal(result.body.alerts.status, 'unavailable', JSON.stringify(sent));
    assert.deepEqual(result.body.alerts.items, []);
    assert.equal(result.body.weatherStatus, 'live', 'Invalid alert metadata does not discard weather');
  }
});

test('field location changes re-fetch elevation; manual refresh does not refetch stable elevation', async () => {
  const f = fixture();
  await f.request();
  await f.request({ fieldId: field.id, refresh: '1' });
  assert.equal(f.calls.filter(call => call.url?.startsWith('https://epqs.')).length, 1);
  const changed = { ...f.field(), location: { latitude: 47.69, longitude: -122.2 } };
  assert.equal((await f.stateRequest('PUT', { fields: [changed] })).status, 200);
  assert.equal([...f.documents.values()].filter(doc => doc.type === 'fieldContext').length, 0);
  await f.request();
  assert.equal(f.calls.filter(call => call.url?.startsWith('https://epqs.')).length, 2);
  f.setNow(NOW + 366 * 86400000);
  await f.request();
  assert.equal(f.calls.filter(call => call.url?.startsWith('https://epqs.')).length, 3);
});

test('no external request without field consent or a saved location, and admin cannot access another farm', async () => {
  const f = fixture();
  assert.equal((await f.request({}, null)).status, 401);
  assert.equal((await f.request({ fieldId: field.id, userId: owner }, 'admin-id', 'admin1@example.invalid')).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.stateRequest('PUT', { fields: [{ ...field, dataConsent: false }] })).status, 200);
  assert.equal((await f.request()).status, 409);
  const legacy = { id: field.id, name: field.name, crop: field.crop, dataConsent: true };
  await f.stateRequest('PUT', { fields: [legacy] });
  assert.equal((await f.request()).status, 409);
  assert.equal(f.calls.length, 0);
});

test('removing fields or deleting farm data removes derived context and an in-flight response cannot resurrect it', async () => {
  const f = fixture();
  await f.request();
  assert.ok(f.documents.has(`${owner}/${contextId(owner, field.id)}`));
  await f.stateRequest('PUT', { fields: [] });
  assert.ok(!f.documents.has(`${owner}/${contextId(owner, field.id)}`));
  await f.stateRequest('PUT', { fields: [field] });
  f.beforeBatch(async () => { await f.stateRequest('DELETE'); });
  assert.equal((await f.request()).status, 409);
  assert.equal([...f.documents.values()].filter(doc => ['state','fieldContext'].includes(doc.type)).length, 0);
  assert.equal((await f.stateRequest('GET')).status, 204);
});

test('consent withdrawal during fetch blocks cache persistence and the response', async () => {
  const f = fixture();
  f.beforeBatch(async () => { await f.stateRequest('PUT', { fields: [{ ...field, dataConsent: false }] }); });
  assert.equal((await f.request()).status, 409);
  assert.equal([...f.documents.values()].filter(doc => doc.type === 'fieldContext').length, 0);
});

test('owner export includes only its current derived context; deletion and consent changes never touch another partition', async () => {
  const f = fixture();
  await f.request();
  const foreign = { id: contextId('other-farmer', field.id), userId: 'other-farmer', type: 'fieldContext', fieldId: field.id, locationKey: locationKey(field), elevation: { status: 'loaded', feet: 9876, meters: 3010, fetchedAt: new Date(NOW).toISOString() } };
  f.save(foreign);
  const exported = await f.stateRequest('GET', undefined, { export: '1' });
  assert.equal(exported.body.derivedFieldData.length, 1);
  assert.equal(exported.body.derivedFieldData[0].elevation.feet, 91.7);
  await f.stateRequest('PUT', { fields: [{ ...field, dataConsent: false }] });
  assert.equal((await f.stateRequest('GET', undefined, { export: '1' })).body.derivedFieldData, undefined);
  assert.ok(f.documents.has(`other-farmer/${foreign.id}`));
  await f.stateRequest('PUT', { fields: [field] });
  await f.request();
  await f.stateRequest('DELETE');
  assert.ok(!f.documents.has(`${owner}/${contextId(owner, field.id)}`));
  assert.ok(f.documents.has(`other-farmer/${foreign.id}`));
});

test('concurrent field cache writes retry ETags without losing private state', async () => {
  const f = fixture();
  const fields = Array.from({length:5}, (_, i) => ({ ...field, id: `block-${i}`, location: { latitude: 47.68 + i / 1000, longitude: -122.2 } }));
  await f.stateRequest('PUT', { fields });
  const results = await Promise.all(fields.map(item => f.service.getFieldData({ userId: owner, field: item })));
  assert.equal(results.length, 5);
  assert.equal([...f.documents.values()].filter(doc => doc.type === 'fieldContext').length, 5);
  assert.deepEqual(f.state().state.fields, fields);
  assert.equal(results[0].locationKey, locationKey(fields[0]));
});
