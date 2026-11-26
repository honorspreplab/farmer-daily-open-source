require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldGrid, normalizeScene, assetUrl, createBudget, analyzePixels, compareScenes, inside, interiorCell, readBand } = require('../api/shared/satellite-raster');
const { createSatelliteService, contextId, exportSatelliteContexts, pruneSatelliteContexts, cropHistory } = require('../api/shared/satellite');
const { createSatelliteHandler } = require('../api/field-satellite');
const NOW = Date.parse('2026-10-07T18:00:00Z'), owner = 'satellite-owner';
const clone = value => structuredClone(value);
const field = { id: 'field-a', crop: 'Apples', name: 'Private apple field', satelliteConsent: true, boundary: { type: 'Polygon', coordinates: [[[-120.36, 47.35], [-120.359, 47.35], [-120.359, 47.351], [-120.36, 47.351], [-120.36, 47.35]]] } };
function scene(date = '2026-10-05T19:00:00Z') {
  const id = `S2B_10TFT_${date.slice(0, 10).replaceAll('-', '')}_0_L2A`, assets = {};
  for (const [band, file] of Object.entries({ red: 'B04', nir: 'B08', rededge1: 'B05', nir08: 'B8A', scl: 'SCL' })) {
    const res = ['red', 'nir'].includes(band) ? 10 : 20;
    assets[band] = { href: `https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/T/FT/2026/10/${id}/${file}.tif`, type: 'image/tiff; application=geotiff; profile=cloud-optimized', gsd: res, 'proj:shape': [109800 / res, 109800 / res], 'proj:transform': [res, 0, 600000, 0, -res, 5300040], 'raster:bands': [{ nodata: 0, data_type: band === 'scl' ? 'uint8' : 'uint16', spatial_resolution: res, ...(band !== 'scl' ? { scale: 0.0001, offset: -0.1 } : {}) }] };
  }
  return { type: 'Feature', collection: 'sentinel-2-l2a', id, properties: { datetime: date, 'proj:epsg': 32610 }, assets };
}
function bands(grid, override = {}) {
  return Object.fromEntries(Object.entries({ red: 0.1, nir: 0.5, rededge1: 0.2, nir08: 0.5, scl: 4, ...override }).map(([key, value]) => [key, new Float64Array(grid.width * grid.height).fill(value)]));
}
function response(body, status = 200, headers = {}) { const bytes = Buffer.from(JSON.stringify(body)); return { ok: status < 400, status, headers: { get: key => headers[key] || null }, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } }; }
function fixture({ fetchImpl, readBandImpl, getLandsatImpl, timeoutMs = 1000 } = {}) {
  const documents = new Map(), calls = []; let version = 0, beforeBatch, clock = NOW;
  const key = (id, userId) => `${userId}/${id}`, err = code => Object.assign(new Error('fixture'), { code });
  const save = document => { const value = { ...clone(document), _etag: String(++version) }; documents.set(key(value.id, value.userId), value); return { resource: clone(value) }; };
  const container = { item(id, userId) { return {
    async read() { const value = documents.get(key(id, userId)); if (!value) throw err(404); return { resource: clone(value) }; },
    async delete(options) { const value = documents.get(key(id, userId)); if (!value) throw err(404); if (options?.accessCondition && options.accessCondition.condition !== value._etag) throw err(412); documents.delete(key(id, userId)); },
    async replace(document, options) { const value = documents.get(key(id, userId)); if (!value || value._etag !== options?.accessCondition?.condition) throw err(412); return save(document); }
  }; }, items: {
    query(spec, options) { const params = Object.fromEntries(spec.parameters.map(item => [item.name, item.value])); assert.equal(params['@userId'], options.partitionKey); return { async fetchAll() { return { resources: [...documents.values()].filter(doc => doc.userId === options.partitionKey && doc.type === params['@type']).map(clone) }; } }; },
    async create(document) { return save(document); },
    async batch(operations, userId) {
      if (beforeBatch) { const callback = beforeBatch; beforeBatch = null; await callback(); }
      for (const op of operations) { const value = documents.get(key(op.id || op.resourceBody.id, userId)); assert.equal(op.resourceBody.userId, userId); if (op.operationType === 'Create' && value) throw err(409); if (op.operationType === 'Replace' && (!value || value._etag !== op.ifMatch)) throw err(412); }
      return { code: 200, result: operations.map(op => ({ statusCode: 200, resourceBody: save(op.resourceBody).resource })) };
    }
  } };
  save({ id: `state-${owner}`, userId: owner, type: 'state', state: { fields: [clone(field)] } });
  save({ id: `account-${owner}`, userId: owner, type: 'account', email: 'satellite@example.test', identityProvider: 'aad', plan: 'free', request: null });
  const service = createSatelliteService({ getContainer: () => container, now: () => clock, timeoutMs, ...(getLandsatImpl ? { getLandsatImpl } : {}),
    fetchImpl: async (url, options) => { calls.push({ url, options }); if (fetchImpl) return fetchImpl(url, options); if (url.includes('/v1/search')) return response({ type: 'FeatureCollection', features: [scene(), scene('2026-10-01T19:00:00Z')] }); return response({ error: { message: 'Fixture USDA offline' } }); },
    readBandImpl: readBandImpl || (async (asset, source, grid) => bands(grid, source.date.startsWith('2026-10-05') ? { nir: 0.3 } : {})[asset.band]) });
  const handler = createSatelliteHandler({ getContainer: () => container, now: () => clock, satelliteService: service });
  const getField = () => clone(documents.get(key(`state-${owner}`, owner))?.state?.fields?.[0]);
  return { service, container, calls, documents, save, getField, setNow: value => { clock = value; }, beforeBatch: callback => { beforeBatch = callback; },
    async request(userId = owner, email = 'satellite@example.test', query = { fieldId: field.id }) {
      const context = { log: { error() {} } };
      await handler(context, { method: 'GET', query, headers: { host: 'localhost', origin: 'http://localhost', ...(userId ? { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId, userDetails: email, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64') } : {}) } }); return context.res;
    }
  };
}
test('actual polygon mask and calibrated arrays produce NDVI/NDRE summaries and percentile history', () => {
  const source = normalizeScene(scene(), NOW), grid = fieldGrid(field, source.epsg), values = bands(grid), output = analyzePixels(source, grid, values);
  assert.ok(grid.count >= 9); assert.ok(grid.count < grid.width * grid.height);
  assert.equal(output.summary.ndvi, 0.6667); assert.equal(output.summary.ndre, 0.4286); assert.equal(output.summary.p10, 0.6667); assert.equal(output.summary.clearPercent, 100); assert.equal(output.summary.status, 'clear');
  for (let i = 0; i < grid.mask.length; i++) if (!grid.mask[i]) { values.red[i] = 1.4; values.nir[i] = 0; }
  assert.equal(analyzePixels(source, grid, values).summary.ndvi, 0.6667);
});
test('clouds, shadows, snow, water, unknown SCL, nodata and negative reflectance do not become crop indices', () => {
  const source = normalizeScene(scene(), NOW), grid = fieldGrid(field, source.epsg);
  for (const scl of [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 99, NaN]) { const value = analyzePixels(source, grid, bands(grid, { scl })); assert.equal(value.summary.ndvi, null); assert.equal(value.summary.ndre, null); }
  for (const red of [NaN, -0.1, 2]) assert.equal(analyzePixels(source, grid, bands(grid, { red })).summary.ndvi, null);
});
test('tiny, oversized and point-only fields fail conservatively', () => {
  assert.throws(() => fieldGrid({ location: { latitude: 47.35, longitude: -120.35 } }, 32610), /boundary/);
  assert.throws(() => fieldGrid({ boundary: { type: 'Polygon', coordinates: [[[-121, 47], [-120, 47], [-120, 48], [-121, 48], [-121, 47]]] } }, 32610), /too large/);
  const small = { boundary: { type: 'Polygon', coordinates: [[[-120.36, 47.35], [-120.35999, 47.35], [-120.35999, 47.35001], [-120.36, 47.35001], [-120.36, 47.35]]] } };
  const grid = fieldGrid(small, 32610); assert.equal(analyzePixels(normalizeScene(scene(), NOW), grid, bands(grid)).summary.ndvi, null);
});
test('Landsat grids preserve native 15-meter origin offsets without changing the Sentinel grid', () => {
  const sentinel = fieldGrid(field, 32610), landsat = fieldGrid(field, 32610, 30, 15);
  assert.equal(sentinel.resolutionMeters, 20); assert.equal(landsat.resolutionMeters, 30);
  assert.equal(landsat.x % 30, 15); assert.equal(landsat.y % 30, 15); assert.notEqual(sentinel.key, landsat.key);
  assert.throws(() => fieldGrid(field, 32610, 20, 15), /origin/); assert.throws(() => fieldGrid(field, 32610, 10), /resolution/);
});
test('calibration, CRS, grid, source dates and allowlisted COG paths are strictly validated', () => {
  const good = scene(); assert.equal(normalizeScene(good, NOW).assets.red.offset, -0.1);
  for (const change of [s => { delete s.assets.red['raster:bands'][0].scale; }, s => { s.assets.red['raster:bands'][0].offset = -1; }, s => { s.properties['proj:epsg'] = 4326; }, s => { s.assets.red['proj:transform'][1] = 1; }, s => { s.properties.datetime = '2027-01-01'; }, s => { s.assets.red.href = 'https://localhost/B04.tif'; }, s => { s.assets.red['raster:bands'][0].nodata = 65535; }]) { const bad = clone(good); change(bad); assert.throws(() => normalizeScene(bad, NOW)); }
  const url = good.assets.red.href;
  for (const bad of [url.replace('sentinel-cogs.s3.us-west-2.amazonaws.com', 'evil.example'), url + '?secret=1', url.replace('https:', 'http:'), url.replace('/B04.tif', '/../B04.tif'), url.replace('/B04.tif', '/B08.tif'), url.replace('https://', 'https://x@')]) assert.equal(assetUrl(bad, 'red'), null);
});
test('comparison uses shared clear pixels and only overlays complete interior cells', () => {
  const grid = fieldGrid(field, 32610), previous = analyzePixels(normalizeScene(scene('2026-10-01T19:00:00Z'), NOW), grid, bands(grid));
  const values = bands(grid); let flagged = 0;
  for (let i = 0; i < grid.mask.length; i++) if (grid.mask[i] && flagged++ < grid.count / 2) values.nir[i] = 0.15;
  const current = analyzePixels(normalizeScene(scene(), NOW), grid, values), result = compareScenes(previous, current);
  assert.equal(result.change.status, 'detected'); assert.ok(result.change.ndviDelta < -0.1); assert.ok(result.problemAreas.length);
  for (const feature of result.problemAreas) for (const point of feature.geometry.coordinates[0]) assert.ok(inside(grid.transform.forward(point), grid.ring));
  current.grid = { ...grid, key: 'other-grid' }; assert.equal(compareScenes(previous, current).change.status, 'insufficient');
});
test('scouting cells do not bridge a concave notch even when all cell corners are inside', () => {
  const boundary = [[-10, -10], [30, -10], [30, 30], [12, 30], [12, 15], [8, 15], [8, 30], [-10, 30], [-10, -10]], cell = [[0, 20], [20, 20], [20, 0], [0, 0], [0, 20]];
  assert.ok(cell.every(point => inside(point, boundary))); assert.equal(interiorCell(cell, boundary), false);
});
test('real GeoTIFF fixture is range-decoded, scale/offset calibrated and 10m pixels averaged to20m', async () => {
  const { writeArrayBuffer } = await import('../api/node_modules/geotiff/dist-module/geotiff.js');
  const grid = fieldGrid(field, 32610), source = normalizeScene(scene(), NOW), asset = { ...source.assets.red, shape: [64, 64], transform: [10, 0, grid.x, 0, -10, grid.y] };
  const pixels = new Uint16Array(64 * 64).fill(2000); pixels[0] = 6000;
  const file = Buffer.from(writeArrayBuffer(pixels, { width: 64, height: 64, BitsPerSample: [16], SamplesPerPixel: 1, SampleFormat: [1], ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, grid.x, grid.y, 0], ProjectedCSTypeGeoKey: 32610, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, GDAL_NODATA: '0' }));
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, asset.url); assert.equal(options.redirect, 'error');
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range); assert.ok(match);
    const start = Number(match[1]), end = Math.min(Number(match[2]), file.length - 1), bytes = file.subarray(start, end + 1);
    return { ok: true, status: 206, headers: { get: name => name === 'content-range' ? `bytes ${start}-${end}/${file.length}` : String(bytes.length) }, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } };
  };
  const budget = createBudget({ fetchImpl }), result = await readBand(asset, source, grid, budget); budget.close();
  assert.ok(Math.abs(result[0] - 0.2) < 1e-8); assert.ok(Math.abs(result[1] - 0.1) < 1e-8); assert.ok(calls <= 3);
  const fullFile = createBudget({ fetchImpl: async () => response({}, 200) }); await assert.rejects(readBand(asset, source, grid, fullFile), /unavailable/); fullFile.close();
  const wrongCrs = createBudget({ fetchImpl }); await assert.rejects(readBand(asset, { ...source, epsg: 32611 }, grid, wrongCrs), /catalog grid/); wrongCrs.close();
});
test('byte/request/time budgets and strict redirects prevent whole-file or unbounded provider reads', async () => {
  let called = 0;
  const budget = createBudget({ maxRequests: 1, fetchImpl: async (url, options) => { called++; assert.equal(options.redirect, 'error'); return response({ a: 1 }); } });
  await budget.request('https://example.test'); await assert.rejects(budget.request('https://example.test'), /budget/); assert.equal(called, 1); budget.close();
  const timeout = createBudget({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(timeout.request('https://example.test'), /timed out/); timeout.close();
  const over = createBudget({ fetchImpl: async () => response({ text: 'x'.repeat(50) }) }); await assert.rejects(over.request('https://example.test', {}, 10), /byte budget/); over.close();
});
test('Free owners load genuine computed history; private result cache/export contains no pixel arrays', async () => {
  const f = fixture(), result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.body.status, 'live'); assert.equal(result.body.history.length, 2); assert.equal(result.body.change.status, 'detected');
  assert.equal(result.body.history[0].ndvi, 0.6667); assert.equal(result.body.history[1].ndvi, 0.5);
  assert.equal(result.body.source.attribution, 'Contains modified Copernicus Sentinel data 2026');
  assert.ok(f.calls.every(call => !call.url.includes('Private') && !call.url.includes('Apples') && !call.url.includes(owner)));
  const count = f.calls.length; assert.equal((await f.request()).body.status, 'cached'); assert.equal(f.calls.length, count);
  const exported = await exportSatelliteContexts(f.container, owner, [f.getField()]); assert.equal(exported.length, 1); assert.ok(!JSON.stringify(exported).includes('"indices":')); assert.ok(!JSON.stringify(exported).includes('"mask":'));
  assert.equal(exported[0].source.attribution, result.body.source.attribution);
  const cached = await f.service.readCachedSatellite({ userId: owner, field: f.getField() }); assert.equal(cached.change.status, 'detected'); assert.equal(f.calls.length, count);
});
test('legacy weather consent does not grant satellite sharing and administrator cannot read another farm', async () => {
  const f = fixture(); assert.equal((await f.request(null)).status, 401); assert.equal((await f.request('admin-other', 'admin1@example.invalid')).status, 404); assert.equal(f.calls.length, 0);
  f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, satelliteConsent: false, dataConsent: true }] } }); assert.equal((await f.request()).status, 409); assert.equal(f.calls.length, 0);
});
test('malformed/cloud-only catalogs and outages report unavailable/insufficient without synthetic values', async () => {
  for (const fetchImpl of [async () => response({ error: 'unavailable' }), async () => { throw new Error('offline'); }]) { const f = fixture({ fetchImpl }); const result = await f.request(); assert.equal(result.status, 200); assert.equal(result.body.status, 'unavailable'); assert.deepEqual(result.body.history, []); }
  const cloud = fixture({ readBandImpl: async (asset, source, grid) => bands(grid, { scl: 9 })[asset.band] }); const result = await cloud.request(); assert.equal(result.body.status, 'insufficient'); assert.ok(result.body.history.every(item => item.ndvi === null)); assert.deepEqual(result.body.problemAreas, []);
});
test('single-flight requests share work but field revocation at transaction cannot resurrect satellite data', async () => {
  const f = fixture(); await Promise.all([f.request(), f.request()]); assert.equal(f.calls.filter(call => call.url.includes('/v1/search')).length, 1);
  f.setNow(NOW + 2 * 86400000); f.beforeBatch(async () => { f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, satelliteConsent: false }] } }); await pruneSatelliteContexts(f.container, owner, [{ ...field, satelliteConsent: false }]); });
  assert.equal((await f.request()).status, 409); assert.ok(!f.documents.has(`${owner}/${contextId(owner, field.id)}`));
  assert.equal(await f.service.readCachedSatellite({ userId: owner, field }), null);
});
test('field crop/geometry edits invalidate cache/export; pruning stays inside owner partition', async () => {
  const f = fixture(); await f.request(); const edited = { ...f.getField(), crop: 'Wheat' };
  assert.deepEqual(await exportSatelliteContexts(f.container, owner, [edited]), []);
  f.save({ id: 'other-context', userId: 'other', type: 'satelliteContext', fieldId: field.id });
  await pruneSatelliteContexts(f.container, owner, [edited]); assert.ok(f.documents.has('other/other-context')); assert.ok(!f.documents.has(`${owner}/${contextId(owner, field.id)}`));
});
test('brief cache rejects corrupt/future/missing acquisition dates and never calls providers', async () => {
  const f = fixture(); await f.request(); const stored = f.documents.get(`${owner}/${contextId(owner, field.id)}`), count = f.calls.length;
  for (const date of [undefined, 'invalid', '2027-01-01T00:00:00Z']) {
    const edited = clone(stored); edited.result.change.currentDate = date; f.save(edited);
    assert.equal(await f.service.readCachedSatellite({ userId: owner, field: f.getField() }), null);
  }
  assert.equal(f.calls.length, count);
});
test('expired live validity is not served from cache and repeated edited fields hit owner budget', async () => {
  const f = fixture(); await f.request(); const stored = f.documents.get(`${owner}/${contextId(owner, field.id)}`); stored.result.validUntil = new Date(NOW - 1).toISOString(); f.save(stored);
  const count = f.calls.length; await f.request(); assert.ok(f.calls.length > count);
  for (let index = 0; index < 4; index++) { f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, name: `Private renamed ${index}` }] } }); assert.equal((await f.request()).status, 200); }
  f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, name: 'Private renamed final' }] } }); const before = f.calls.length;
  assert.equal((await f.request()).status, 429); assert.equal(f.calls.length, before);
});
test('CDL annual point context locks known published years and reads actual annual resolution', async () => {
  const urls = [], budget = createBudget({ fetchImpl: async url => {
    urls.push(url);
    if (url.includes('/query?')) return response({ features: [{ attributes: { OBJECTID: 40, Year: 2025, LowPS: 10 } }, { attributes: { OBJECTID: 38, Year: 2023, LowPS: 30 } }, { attributes: { OBJECTID: 41, Year: 2027, LowPS: 10 } }] });
    if (url.includes('rasterAttributeTable')) return response({ features: [{ attributes: { Value: 68, Class_Names: 'Apples' } }] });
    const rule = JSON.parse(new URL(url).searchParams.get('mosaicRule')), year = Number(rule.where.split('=')[1]);
    return response({ value: '68', catalogItems: { features: [{ attributes: { OBJECTID: rule.lockRasterIds[0], Year: year } }] } });
  } });
  const items = await cropHistory({ latitude: 47.35, longitude: -120.35 }, budget, NOW); budget.close();
  assert.deepEqual(items.map(item => [item.year, item.resolutionMeters]), [[2023, 30], [2025, 10]]); assert.ok(items.every(item => item.scope === 'representative-point')); assert.ok(urls.every(url => !url.includes('2027')));
});
function nasaResult() {
  const previousDate = '2026-09-21T19:00:00.000Z', currentDate = '2026-10-05T19:00:00.000Z';
  return { source: { id: 'nasa-landsat', name: 'NASA Landsat' }, status: 'live', fetchedAt: new Date(NOW).toISOString(), validUntil: new Date(NOW + 2 * 86400000).toISOString(), resolutionMeters: 30,
    history: [previousDate, currentDate].map((date, i) => ({ date, sourceId: `Landsat-fixture-${i}`, status: 'clear', ndvi: i ? 0.5 : 0.7, ndre: null })),
    change: { status: 'detected', previousDate, currentDate, ndviDelta: -0.2 }, problemAreas: [] };
}
test('NASA is opt-in independently and NASA-only fields never query Sentinel or USDA', async () => {
  let nasaCalls = 0;
  const f = fixture({ getLandsatImpl: async args => { nasaCalls++; assert.equal(args.field.landsatConsent, true); return nasaResult(); } });
  await f.request(); assert.equal(nasaCalls, 0);
  f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, satelliteConsent: false, landsatConsent: true }] } });
  const before = f.calls.length, result = await f.request();
  assert.equal(result.status, 200); assert.equal(nasaCalls, 1); assert.equal(f.calls.length, before);
  assert.equal(result.body.status, 'not_selected'); assert.deepEqual(result.body.history, []); assert.deepEqual(result.body.cropHistory, []);
  assert.equal(result.body.landsat.status, 'live'); assert.equal(result.body.landsat.resolutionMeters, 30);
  const cache = await f.service.readCachedSatellite({ userId: owner, field: f.getField() }); assert.equal(cache.landsat.status, 'cached'); assert.equal(cache.status, 'not_selected');
  const exported = await exportSatelliteContexts(f.container, owner, [f.getField()]); assert.equal(exported[0].landsat.history.length, 2);
  assert.equal((await f.request()).body.landsat.status, 'cached'); assert.equal(nasaCalls, 1);
});
test('an outage in either imagery provider preserves the independent successful source', async () => {
  const sentinel = fixture({ getLandsatImpl: async () => { throw new Error('NASA down'); } });
  sentinel.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, landsatConsent: true }] } });
  const a = await sentinel.request(); assert.equal(a.body.status, 'live'); assert.equal(a.body.landsat.status, 'unavailable'); assert.deepEqual(a.body.landsat.history, []);
  const nasa = fixture({ fetchImpl: async () => { throw new Error('Sentinel down'); }, getLandsatImpl: async () => nasaResult() });
  nasa.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, landsatConsent: true }] } });
  const b = await nasa.request(); assert.equal(b.body.status, 'unavailable'); assert.equal(b.body.landsat.status, 'live');
  assert.equal((await nasa.service.readCachedSatellite({ userId: owner, field: nasa.getField() })).landsat.status, 'cached');
});
test('NASA consent revocation at the transaction rejects derived results and cannot restore a deleted cache', async () => {
  const f = fixture({ getLandsatImpl: async () => nasaResult() });
  f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, landsatConsent: true }] } }); await f.request();
  f.setNow(NOW + 3 * 86400000);
  f.beforeBatch(async () => { f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, landsatConsent: false }] } }); await pruneSatelliteContexts(f.container, owner, [f.getField()]); });
  assert.equal((await f.request()).status, 409); assert.equal(f.documents.has(`${owner}/${contextId(owner, field.id)}`), false);
});
test('NASA cached evidence rejects missing, future and expired acquisition metadata', async () => {
  const f = fixture({ getLandsatImpl: async () => nasaResult() });
  f.save({ id: `state-${owner}`, userId: owner, state: { fields: [{ ...field, satelliteConsent: false, landsatConsent: true }] } }); await f.request();
  const original = clone(f.documents.get(`${owner}/${contextId(owner, field.id)}`));
  for (const edit of [part => { part.change.currentDate = undefined; }, part => { part.change.currentDate = '2027-01-01'; }, part => { part.fetchedAt = '2027-01-01'; }, part => { part.validUntil = new Date(NOW - 1).toISOString(); }, part => { part.history = []; }]) {
    const doc = clone(original); edit(doc.result.landsat); f.save(doc); assert.equal(await f.service.readCachedSatellite({ userId: owner, field: f.getField() }), null);
  }
});
test('optional real COG smoke computes valid indices from public range reads', { skip: !process.env.FARMER_SATELLITE_LIVE_TEST }, async () => {
  const timestamp = Date.now(), budget = createBudget({ timeoutMs: 28000 });
  try {
    const liveField = { boundary: { type: 'Polygon', coordinates: [[[-119.76, 47.10], [-119.758, 47.10], [-119.758, 47.102], [-119.76, 47.102], [-119.76, 47.10]]] } };
    const query = new URLSearchParams({ collections: 'sentinel-2-l2a', bbox: '-119.76,47.10,-119.758,47.102', datetime: `${new Date(timestamp - 30 * 86400000).toISOString()}/${new Date(timestamp).toISOString()}`, limit: '12', sortby: '-properties.datetime' });
    const catalog = JSON.parse((await budget.request(`https://earth-search.aws.element84.com/v1/search?${query}`)).body.toString());
    const chosen = catalog.features.find(item => item.properties['eo:cloud_cover'] < 40); assert.ok(chosen, 'At least one clear-scene candidate returned');
    const source = normalizeScene(chosen, timestamp), grid = fieldGrid(liveField, source.epsg);
    const entries = await Promise.all(Object.entries(source.assets).map(async ([name, asset]) => [name, await readBand(asset, source, grid, budget)]));
    const result = analyzePixels(source, grid, Object.fromEntries(entries));
    console.log('Live satellite pixel smoke:', JSON.stringify({ ...result.summary, budget: budget.stats() }));
    assert.ok(result.summary.coveragePercent > 0); assert.ok(result.summary.validPixels > 0); assert.ok(result.summary.ndvi >= -1 && result.summary.ndvi <= 1);
  } finally { budget.close(); }
});
test('optional full live service returns history and annual crop context within the request budget', { skip: !process.env.FARMER_SATELLITE_LIVE_TEST }, async () => {
  const f = fixture({ fetchImpl: globalThis.fetch, readBandImpl: readBand, timeoutMs: 24000 });
  f.setNow(Date.now());
  const liveField = { ...field, boundary: { type: 'Polygon', coordinates: [[[-119.76, 47.10], [-119.758, 47.10], [-119.758, 47.102], [-119.76, 47.102], [-119.76, 47.10]]] } };
  f.save({ id: `state-${owner}`, userId: owner, type: 'state', state: { fields: [liveField] } });
  const started = Date.now(), result = await f.request();
  console.log('Live complete satellite service:', JSON.stringify({ status: result.body.status, elapsedMs: Date.now() - started, history: result.body.history, change: result.body.change, cropHistory: result.body.cropHistory }));
  assert.equal(result.status, 200); assert.equal(result.body.status, 'live'); assert.ok(result.body.history.length >= 2); assert.equal(result.body.cropHistoryStatus, 'loaded'); assert.equal(result.body.cropHistory.length, 3); assert.ok(Date.now() - started < 30000);
});
test('optional complete dual-source service loads independently dated Sentinel and NASA Landsat results', { skip: !process.env.FARMER_SATELLITE_LIVE_TEST }, async () => {
  const f = fixture({ fetchImpl: globalThis.fetch, readBandImpl: readBand, timeoutMs: 24000 }); f.setNow(Date.now());
  const liveField = { ...field, landsatConsent: true, boundary: { type: 'Polygon', coordinates: [[[-119.76, 47.10], [-119.758, 47.10], [-119.758, 47.102], [-119.76, 47.102], [-119.76, 47.10]]] } };
  f.save({ id: `state-${owner}`, userId: owner, type: 'state', state: { fields: [liveField] } });
  const started = Date.now(), result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.status, 'live'); assert.equal(result.body.landsat.status, 'live');
  assert.equal(result.body.resolutionMeters, 20); assert.equal(result.body.landsat.resolutionMeters, 30);
  assert.ok(result.body.history.every(item => item.sourceId.startsWith('S2'))); assert.ok(result.body.landsat.history.every(item => /^LC0[89]_/.test(item.sourceId) && item.ndre === null));
  assert.ok(result.body.landsat.history.some(item => item.status === 'clear' && Number.isFinite(item.ndvi))); assert.ok(Date.now() - started < 30000);
  assert.doesNotMatch(JSON.stringify(result.body), /sig=|"indices":|"mask":/);
  console.log('Live dual-source result:', JSON.stringify({ sentinelStatus: result.body.status, landsatStatus: result.body.landsat.status, elapsedMs: Date.now() - started, sentinelDates: result.body.history.map(item => item.date), landsatHistory: result.body.landsat.history, landsatChange: result.body.landsat.change }));
});
