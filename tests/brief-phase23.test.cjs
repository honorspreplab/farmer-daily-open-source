const test = require('node:test');
const assert = require('node:assert/strict');
const { createBriefHandler } = require('../api/brief');
const { normalizeGeometry, locationKey } = require('../api/shared/field-geometry');
const { SOURCES, TTL } = require('../api/shared/context-providers');
const NOW = Date.parse('2026-10-07T18:00:00Z'), owner = 'farmer', iso = value => new Date(value).toISOString(), clone = value => structuredClone(value);
const field = { id: 'field-0', name: 'Private orchard', crop: 'Apples', dataConsent: true, contextConsent: true, satelliteConsent: true, ...normalizeGeometry({ boundary: { type: 'Polygon', coordinates: [[[-120.36, 47.35], [-120.359, 47.35], [-120.359, 47.351], [-120.36, 47.351], [-120.36, 47.35]]] } }) };
function memory() {
  const docs = new Map(); let version = 0, beforeBatch;
  const key = (id, userId) => `${userId}/${id}`, failure = code => Object.assign(new Error('fixture'), { code });
  const save = value => { const doc = { ...clone(value), _etag: `v${++version}` }; docs.set(key(doc.id, doc.userId), doc); return clone(doc); };
  return { docs, save, beforeBatch(callback) { beforeBatch = callback; }, item(id, userId) { return {
    async read() { const doc = docs.get(key(id, userId)); if (!doc) throw failure(404); return { resource: clone(doc) }; },
    async delete() { if (!docs.delete(key(id, userId))) throw failure(404); },
    async replace(doc, options) { const existing = docs.get(key(id, userId)); if (!existing || existing._etag !== options?.accessCondition?.condition) throw failure(412); return { resource: save(doc) }; }
  }; }, items: {
    async create(doc) { if (docs.has(key(doc.id, doc.userId))) throw failure(409); return { resource: save(doc) }; },
    async batch(operations, userId) {
      if (beforeBatch) { const callback = beforeBatch; beforeBatch = null; await callback(); }
      for (const operation of operations) { const existing = docs.get(key(operation.id || operation.resourceBody.id, userId)); assert.equal(operation.resourceBody.userId, userId); if (operation.operationType === 'Create' && existing) throw failure(409); if (operation.operationType === 'Replace' && (!existing || existing._etag !== operation.ifMatch)) throw failure(412); }
      return { code: 200, result: operations.map(op => ({ statusCode: 200, resourceBody: save(op.resourceBody) })) };
    }
  } };
}
function weather(item, timestamp = NOW) { return { fieldId: item.id, locationKey: locationKey(item), weatherStatus: 'live', elevation: { status: 'loaded', feet: 900, meters: 274 }, alerts: { status: 'live', items: [], fetchedAt: iso(timestamp) },
  weather: { source: { id: 'nws', name: 'NWS', url: 'https://forecast.weather.gov/MapClick.php?lat=47.35&lon=-120.36' }, fetchedAt: iso(timestamp), hourly: [{ startTime: iso(timestamp - 60000), endTime: iso(timestamp + 3540000), temperature: 60, temperatureUnit: 'F', windSpeed: '4 mph', probabilityOfPrecipitation: { value: 10 }, relativeHumidity: { value: 60 } }] } }; }
function context(item) { return { fieldId: item.id, locationKey: locationKey(item), soil: { source: SOURCES.soil, status: 'ready', fetchedAt: iso(NOW), validUntil: iso(NOW + TTL.soil), data: { mapUnits: [{ name: 'Mapped soil' }] } } }; }
function fixture({ fields = [field], getFarmContext, readCachedSatellite, getFieldData, tasks = [] } = {}) {
  const container = memory(), calls = { weather: [], context: [], satellite: [] }; let timestamp = NOW;
  container.save({ id: `state-${owner}`, userId: owner, type: 'state', state: { profile: { firstName: 'Sam', farmName: 'Sunrise', language: 'English', address: 'PRIVATE STREET ADDRESS' }, fields, tasks } });
  const handler = createBriefHandler({ getContainer: () => container, now: () => timestamp, fetchImpl: async () => { throw new Error('Unexpected network request'); },
    fieldDataService: { async getFieldData(args) { assert.equal(args.userId, owner); calls.weather.push(args.field.id); return getFieldData ? getFieldData(args, container) : weather(args.field, timestamp); } },
    farmContextService: { async readCachedFarmContext(args) { assert.equal(args.userId, owner); assert.equal(args.refresh, undefined); calls.context.push(args.field.id); return getFarmContext ? getFarmContext(args, container) : context(args.field); }, async getFarmContext() { assert.fail('Brief must never refresh slow context sources or start cache writes'); } },
    satelliteService: { async readCachedSatellite(args) { assert.equal(args.userId, owner); calls.satellite.push(args.field.id); return readCachedSatellite ? readCachedSatellite(args, container) : null; }, async getSatellite() { assert.fail('Brief must never process imagery or call satellite providers'); } } });
  return { container, calls, handler, setTime(value) { timestamp = value; }, async request(userId = owner, body = {}, method = 'POST') {
    const ctx = { log: { error() {}, warn() {} } };
    await handler(ctx, { method, body, headers: { 'content-type': 'application/json', ...(userId ? { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId, userDetails: `${userId}@example.test`, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64') } : {}) } });
    assert.equal(ctx.res.headers['Cache-Control'], 'no-store'); return ctx.res;
  } };
}
test('daily brief reads opted-in context and satellite caches without refreshing providers and preserves one private snapshot', async () => {
  const f = fixture(), result = await f.request(); assert.equal(result.status, 200); assert.equal(result.body.brief.engine, 'phase123-rules');
  assert.deepEqual(f.calls, { weather: [field.id], context: [field.id], satellite: [field.id] }); assert.ok(result.body.brief.advisories.some(item => item.kind === 'soil-context'));
  assert.ok(!JSON.stringify(result.body.brief).includes('PRIVATE STREET ADDRESS')); const before = clone(f.calls);
  assert.equal((await f.request()).body.reused, true); assert.deepEqual(f.calls, before); assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 1);
});
test('context/satellite have independent permissions and at most three selected fields regardless of weather permission', async () => {
  const fields = Array.from({ length: 7 }, (_, index) => ({ ...field, id: `field-${index}`, name: `Block ${index}`, dataConsent: false }));
  const f = fixture({ fields, tasks: [{ id: 'scout', name: 'Scout', fieldId: 'field-5', done: false }] });
  const saved = (await f.container.item('state-farmer', owner).read()).resource; saved.state.profile.priorityField = 'Block 6'; f.container.save(saved);
  const result = await f.request(); assert.equal(result.status, 200); assert.equal(f.calls.weather.length, 0);
  assert.deepEqual(f.calls.context, ['field-6', 'field-5', 'field-0']); assert.deepEqual(f.calls.satellite, ['field-6', 'field-5', 'field-0']);
  assert.equal(result.body.brief.coverage.contextReviewedFieldIds.length, 3); assert.match(result.body.brief.coverage.notices.join(' '), /3 of 7/);
  const no = fixture({ fields: [{ ...field, contextConsent: false, satelliteConsent: false }] }); assert.equal((await no.request()).status, 200); assert.equal(no.calls.context.length, 0); assert.equal(no.calls.satellite.length, 0); assert.equal(no.calls.weather.length, 1);
});
test('context and cached-imagery failures leave weather brief working with explicit missing-context notices', async () => {
  const f = fixture({ getFarmContext: async () => { throw new Error('Provider down'); }, readCachedSatellite: async () => { throw new Error('Cache down'); } });
  const result = await f.request(); assert.equal(result.status, 200); assert.ok(result.body.brief.advisories.some(item => item.kind === 'conditions'));
  assert.match(result.body.brief.coverage.notices.join(' '), /Farm context was not available/); assert.match(result.body.brief.coverage.notices.join(' '), /not an all-clear/);
});
test('a valid previously processed vegetation decline enters the brief without invoking imagery generation', async () => {
  const day = 86400000, previousDate = iso(NOW - 6 * day), currentDate = iso(NOW - day);
  const f = fixture({ readCachedSatellite: async ({ field }) => ({ fieldId: field.id, locationKey: locationKey(field), status: 'cached', source: { id: 'sentinel-2' }, fetchedAt: iso(NOW), validUntil: iso(NOW + 2 * day),
    history: [{ date: previousDate, status: 'clear', ndvi: 0.7, clearPercent: 100, coveragePercent: 100 }, { date: currentDate, status: 'clear', ndvi: 0.5, clearPercent: 100, coveragePercent: 100 }],
    change: { status: 'detected', previousDate, currentDate, ndviDelta: -0.2, ndviPercent: -28.6, matchedPixels: 100, matchedPercent: 100, confidence: 'medium', affectedAreaAcres: 2 } }) });
  const result = await f.request(); assert.equal(result.status, 200);
  const advice = result.body.brief.advisories.find(item => item.kind === 'satellite-scout'); assert.ok(advice); assert.match(advice.whatChanged, /-0.200 NDVI index points/);
  assert.match(advice.whyItMatters, /not proof of disease/); assert.match(advice.suggestedAction, /scout/); assert.deepEqual(f.calls.satellite, [field.id]);
});
test('anonymous and unrelated accounts cannot trigger owner field tools or read the generated private brief', async () => {
  const f = fixture(); assert.equal((await f.request(null)).status, 401); assert.equal((await f.request('other', { userId: owner, fieldId: field.id })).status, 409);
  assert.deepEqual(f.calls, { weather: [], context: [], satellite: [] }); await f.request(); const other = await f.request('other', {}, 'GET'); assert.equal(other.status, 200); assert.equal(other.body.brief, null);
});
test('owner deletion during context query cannot recreate a brief after source promises settle', async () => {
  let started, release; const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ getFarmContext: async ({ field }) => { started(); await wait; return context(field); } });
  const pending = f.request(); await began; await f.container.item('state-farmer', owner).delete(); release(); assert.equal((await pending).status, 409);
  assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 0);
});
test('satellite-consent revocation during cached read rejects stale private generation, but ETag-only tool writes are allowed', async () => {
  const f = fixture({ readCachedSatellite: async (args, container) => { const state = (await container.item('state-farmer', owner).read()).resource; state.state.fields[0].satelliteConsent = false; container.save(state); return null; } });
  assert.equal((await f.request()).status, 409); assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 0);
  const same = fixture({ getFarmContext: async ({ field }, container) => { const state = (await container.item('state-farmer', owner).read()).resource; container.save(state); return context(field); } }); assert.equal((await same.request()).status, 200);
});
test('late owner deletion at the shared state/brief transaction also fails closed', async () => {
  const f = fixture(); f.container.beforeBatch(async () => { await f.container.item('state-farmer', owner).delete(); });
  assert.equal((await f.request()).status, 409); assert.equal([...f.container.docs.values()].filter(doc => doc.type === 'dailyBrief').length, 0);
});
test('a NASA-only field is selected for cached Landsat evidence without processing imagery in the brief', async () => {
  const day = 86400000, previousDate = iso(NOW - 9 * day), currentDate = iso(NOW - day), selected = { ...field, satelliteConsent: false, landsatConsent: true };
  const f = fixture({ fields: [selected], readCachedSatellite: async ({ field }) => ({ fieldId: field.id, locationKey: locationKey(field), status: 'not_selected', history: [], landsat: { fieldId: field.id, locationKey: locationKey(field), status: 'cached', source: { id: 'nasa-landsat' }, fetchedAt: iso(NOW), validUntil: iso(NOW + day),
    history: [previousDate, currentDate].map((date, i) => ({ date, status: 'clear', ndvi: i ? .5 : .7, clearPercent: 100, coveragePercent: 100 })), change: { status: 'detected', previousDate, currentDate, ndviDelta: -.2, matchedPixels: 20, matchedPercent: 100 } } }) });
  const result = await f.request(); assert.equal(result.status, 200); assert.deepEqual(f.calls.satellite, [field.id]);
  const advisory = result.body.brief.advisories.find(item => item.kind === 'satellite-scout'); assert.ok(advisory); assert.match(advisory.sources[0].name, /NASA\/USGS Landsat/); assert.equal(advisory.validUntil, iso(NOW + day));
});
