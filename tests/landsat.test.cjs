const test = require('node:test');
const assert = require('node:assert/strict');
const { getLandsat, normalizeLandsatScene, analyzeLandsatPixels, readLandsatBand, SOURCE, CATALOG, TOKEN } = require('../api/shared/landsat');
const { fieldGrid, createBudget, compareScenes, inside } = require('../api/shared/satellite-raster');
const NOW = Date.parse('2026-10-11T17:00:00Z');
const field = { id: 'landsat-field', name: 'PRIVATE NAME MUST NOT BE SENT', crop: 'Apples', boundary: { type: 'Polygon', coordinates: [[[-119.760, 47.10], [-119.758, 47.10], [-119.758, 47.102], [-119.760, 47.102], [-119.760, 47.10]]] } };
function scene(date = '2026-10-05T18:43:24Z', platform = 'landsat-9', epsg = 32611) {
  const day = date.slice(0, 10).replaceAll('-', ''), prefix = `LC0${platform.slice(-1)}_L2SP_044027_${day}`, assets = {};
  for (const [key, suffix] of Object.entries({ red: 'SR_B4', nir08: 'SR_B5', qa_pixel: 'QA_PIXEL', qa_radsat: 'QA_RADSAT' })) {
    const reflectance = ['red', 'nir08'].includes(key);
    assets[key] = { href: `https://landsateuwest.blob.core.windows.net/landsat-c2/level-2/standard/oli-tirs/2026/044/027/${prefix}_${day}_02_T1/${prefix}_${day}_02_T1_${suffix}.TIF`, type: 'image/tiff; application=geotiff; profile=cloud-optimized', 'raster:bands': [{ data_type: 'uint16', spatial_resolution: 30, ...(reflectance ? { scale: 0.0000275, offset: -0.2, nodata: 0 } : key === 'qa_pixel' ? { nodata: 1 } : {}) }] };
  }
  return { type: 'Feature', collection: 'landsat-c2-l2', id: `${prefix}_02_T1`, properties: { datetime: date, platform, 'proj:epsg': epsg, 'proj:shape': [8041, 7961], 'proj:transform': [30, 0, 247785, 0, -30, 5376615], 'eo:cloud_cover': 10 }, assets };
}
function arrays(grid, values = {}) { return Object.fromEntries(Object.entries({ red: 0.1, nir: 0.5, qa: 64, saturation: 0, ...values }).map(([key, n]) => [key, new Float64Array(grid.width * grid.height).fill(n)])); }
function response(data, status = 200, headers = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return { ok: status >= 200 && status < 300, status, headers: { get: key => headers[key] || null }, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}
function mock({ scenes = [scene(), scene('2026-09-27T18:43:17Z', 'landsat-8')], token, readBandImpl } = {}) {
  const calls = [];
  return { calls, options: { field, timestamp: NOW, timeoutMs: 3000,
    fetchImpl: async (url, options) => { calls.push({ url, options }); if (url.startsWith(`${CATALOG}/search?`)) return response({ type: 'FeatureCollection', features: scenes }); if (url === TOKEN) return response({ token: token || new URLSearchParams({ sp: 'rl', se: new Date(Date.now() + 3600000).toISOString(), sig: 'public-test-signature' }).toString() }); throw new Error('Unexpected request'); },
    readBandImpl: readBandImpl || (async (asset, source, grid) => arrays(grid, source.date.startsWith('2026-10-05') ? { nir: 0.3 } : {})[asset.band]) } };
}

test('Landsat identifies NASA/USGS products and delivery accurately without claiming HLS', () => {
  assert.equal(SOURCE.id, 'nasa-landsat'); assert.match(SOURCE.name, /NASA\/USGS Landsat 8\/9/); assert.match(SOURCE.name, /Microsoft/); assert.match(SOURCE.attribution, /not NASA HLS/);
  const value = normalizeLandsatScene(scene(), NOW); assert.equal(value.platform, 'landsat-9'); assert.equal(value.assets.red.reflectance, true); assert.equal(value.assets.qa.reflectance, false);
  assert.equal(normalizeLandsatScene(scene('2026-09-27T18:43:17Z', 'landsat-8'), NOW).platform, 'landsat-8');
});

test('Landsat calibration, date, platform, native grid and exact allowlisted band paths are validated', () => {
  for (const edit of [s => { s.collection = 'HLSL30'; }, s => { s.id = s.id.replace('T1', 'T2'); }, s => { s.properties.datetime = '2027-01-01T00:00:00Z'; }, s => { s.properties.datetime = '2026-10-06T18:43:24Z'; }, s => { s.properties.platform = 'landsat-7'; }, s => { s.properties['proj:epsg'] = 4326; }, s => { s.properties['proj:transform'][2] = 247800; }, s => { s.assets.red['raster:bands'][0].scale = 0.0001; }, s => { s.assets.red['raster:bands'][0].offset = 0; }, s => { s.assets.qa_pixel['raster:bands'][0].nodata = 0; }, s => { s.assets.red.href += '?token=x'; }, s => { s.assets.red.href = s.assets.red.href.replace('landsateuwest.blob.core.windows.net', 'evil.example'); }, s => { s.assets.red.href = s.assets.red.href.replace('https:', 'http:'); }, s => { s.assets.red.href = s.assets.red.href.replace('SR_B4', 'SR_B5'); }, s => { s.assets.red.href = s.assets.red.href.replace('https://', 'https://secret@'); }]) {
    const bad = structuredClone(scene()); edit(bad); assert.throws(() => normalizeLandsatScene(bad, NOW));
  }
});

test('Landsat computes real field-masked NDVI, null NDRE and explicit 30m summaries', () => {
  const source = normalizeLandsatScene(scene(), NOW), grid = fieldGrid(field, 32611, 30, 15), pixels = arrays(grid);
  for (let i = 0; i < grid.mask.length; i++) if (!grid.mask[i]) { pixels.red[i] = 1; pixels.nir[i] = 0; }
  const result = analyzeLandsatPixels(source, grid, pixels);
  assert.ok(grid.count >= 9); assert.equal(result.summary.ndvi, 0.6667); assert.equal(result.summary.ndre, null); assert.equal(result.summary.resolutionMeters, 30); assert.equal(result.summary.clearPercent, 100); assert.equal(result.summary.platform, 'landsat-9');
});

test('Landsat rejects cloud, shadow, cirrus, snow, water, fill, medium-confidence flags and saturation', () => {
  const source = normalizeLandsatScene(scene(), NOW), grid = fieldGrid(field, 32611, 30, 15);
  for (const qa of [0, 1, 64 | 2, 64 | 4, 64 | 8, 64 | 16, 64 | 32, 64 | 128, 64 | (2 << 8), 64 | (2 << 10), 64 | (2 << 12), 64 | (2 << 14), NaN, -1, 65536]) assert.equal(analyzeLandsatPixels(source, grid, arrays(grid, { qa })).summary.ndvi, null, `qa ${qa}`);
  for (const saturation of [1, 8, 16, 2048, NaN]) assert.equal(analyzeLandsatPixels(source, grid, arrays(grid, { saturation })).summary.ndvi, null);
  for (const red of [NaN, -0.1, 1.1]) assert.equal(analyzeLandsatPixels(source, grid, arrays(grid, { red })).summary.ndvi, null);
  assert.equal(analyzeLandsatPixels(source, grid, arrays(grid, { red: 0, nir: 0 })).summary.ndvi, null);
});

test('Landsat requires nine clear pixels and 70% clear/90% coverage, not catalog cloud estimates', () => {
  const source = normalizeLandsatScene(scene(), NOW), grid = fieldGrid(field, 32611, 30, 15), pixels = arrays(grid);
  let altered = 0; for (let i = 0; i < grid.mask.length; i++) if (grid.mask[i] && altered++ < grid.count * 0.35) pixels.qa[i] = 8;
  const output = analyzeLandsatPixels(source, grid, pixels); assert.equal(output.summary.ndvi, null); assert.equal(output.summary.status, 'cloudy'); assert.ok(output.summary.cloudPercent > 30);
  const tiny = { boundary: { type: 'Polygon', coordinates: [[[-119.76, 47.1], [-119.75999, 47.1], [-119.75999, 47.10001], [-119.76, 47.10001], [-119.76, 47.1]]] } };
  const tinyGrid = fieldGrid(tiny, 32611, 30, 15); assert.equal(analyzeLandsatPixels(source, tinyGrid, arrays(tinyGrid)).summary.ndvi, null);
});

test('Landsat-only comparison preserves actual 30m scout-cell area and rejects other grids', () => {
  const grid = fieldGrid(field, 32611, 30, 15), prior = analyzeLandsatPixels(normalizeLandsatScene(scene('2026-09-27T18:43:17Z'), NOW), grid, arrays(grid)), pixels = arrays(grid);
  let count = 0; for (let i = 0; i < grid.mask.length; i++) if (grid.mask[i] && count++ < grid.count / 2) pixels.nir[i] = 0.15;
  const current = analyzeLandsatPixels(normalizeLandsatScene(scene(), NOW), grid, pixels), result = compareScenes(prior, current);
  assert.equal(result.change.status, 'detected'); assert.ok(result.problemAreas.length);
  for (const feature of result.problemAreas) { assert.equal(feature.properties.areaAcres, 0.222); for (const point of feature.geometry.coordinates[0]) assert.ok(inside(grid.transform.forward(point), grid.ring)); }
  assert.equal(compareScenes({ ...prior, grid: { ...grid, key: 'sentinel-grid' } }, current).change.status, 'insufficient');
});

test('Landsat fetch sends only a bounding box, limits scenes, uses no account key and never retains temporary tokens', async () => {
  const { options, calls } = mock(), output = await getLandsat(options);
  assert.equal(output.status, 'live'); assert.equal(output.history.length, 2); assert.equal(output.change.status, 'detected'); assert.equal(output.history[0].platform, 'landsat-8');
  assert.equal(calls.length, 2); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[1].url, TOKEN);
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '24'); assert.ok(!JSON.stringify(calls).includes(field.name));
  assert.ok(!JSON.stringify(output).includes('public-test-signature')); assert.ok(!JSON.stringify(output).includes('sig=')); assert.ok(Date.parse(output.validUntil) > NOW);
});

test('Landsat handles adjacent UTM zones without cross-grid comparison or discarding newer clear scenes', async () => {
  const scenes = [scene(), scene('2026-10-04T18:00:00Z', 'landsat-8', 32610), scene('2026-09-27T18:00:00Z', 'landsat-8'), scene('2026-09-26T18:00:00Z', 'landsat-9', 32610)];
  const { options } = mock({ scenes, readBandImpl: async (asset, source, grid) => arrays(grid, source.date.startsWith('2026-10-05') ? { qa: 8 } : {})[asset.band] });
  const output = await getLandsat(options); assert.equal(output.history.length, 4); assert.equal(output.change.currentDate, '2026-10-04T18:00:00.000Z'); assert.equal(output.change.previousDate, '2026-09-26T18:00:00.000Z'); assert.match(output.message, /newest Landsat scene is cloudy/);
});

test('Landsat does not fabricate current values when all scenes are cloudy, stale or unavailable', async () => {
  const cloudy = mock({ readBandImpl: async (asset, source, grid) => arrays(grid, { qa: 8 })[asset.band] });
  const clouds = await getLandsat(cloudy.options); assert.equal(clouds.status, 'insufficient'); assert.ok(clouds.history.every(item => item.ndvi === null)); assert.equal(clouds.change.status, 'insufficient');
  const old = await getLandsat(mock({ scenes: [scene('2026-08-18T18:00:00Z')] }).options); assert.equal(old.status, 'insufficient'); assert.equal(old.history[0].status, 'clear'); assert.equal(old.validUntil, undefined);
  const unavailable = await getLandsat({ field, timestamp: NOW, fetchImpl: async () => { throw new Error('offline'); }, previous: { history: [{ date: '2026-09-27T18:00:00Z', sourceId: 'LC08_OLD', ndvi: 0.5 }] } });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.history.length, 1); assert.equal(unavailable.change.status, 'insufficient'); assert.deepEqual(unavailable.problemAreas, []);
});

test('Landsat declines invalid or excessive catalogs, expired/write tokens and point-only fields', async () => {
  const excessive = await getLandsat(mock({ scenes: Array.from({ length: 25 }, () => scene()) }).options); assert.equal(excessive.status, 'unavailable');
  for (const token of [new URLSearchParams({ sp: 'rw', se: new Date(Date.now() + 3600000).toISOString(), sig: 'bad-permission' }).toString(), 'sp=r&se=2020-01-01&sig=expired-token', 'sp=r&se=nonsense&sig=invalid-date']) {
    const result = await getLandsat(mock({ token }).options); assert.equal(result.status, 'unavailable'); assert.equal(result.history.length, 0);
  }
  let fetched = false; const point = await getLandsat({ field: { location: { latitude: 47.1, longitude: -119.76 } }, timestamp: NOW, fetchImpl: async () => { fetched = true; throw new Error('unexpected'); } });
  assert.equal(fetched, false); assert.equal(point.status, 'unavailable');
});

test('Landsat bounds derived history and ignores Sentinel or future records when preserving cached history', async () => {
  const previous = { history: [ { date: '2027-01-01T00:00:00Z', sourceId: 'LC09_FUTURE' }, { date: '2026-10-01T00:00:00Z', sourceId: 'S2B_NOT_LANDSAT' }, ...Array.from({ length: 45 }, (_, i) => ({ date: new Date(NOW - (i + 1) * 86400000).toISOString(), sourceId: `LC08_${i}` })) ] };
  const result = await getLandsat({ ...mock().options, previous }); assert.equal(result.history.length, 36); assert.ok(result.history.every(item => /^LC0[89]_/.test(item.sourceId) && Date.parse(item.date) <= NOW));
});

test('real Landsat PixelIsPoint GeoTIFF fixture is range-decoded with native origin and scale/offset', async () => {
  const { writeArrayBuffer } = await import('../api/node_modules/geotiff/dist-module/geotiff.js');
  const grid = fieldGrid(field, 32611, 30, 15), source = normalizeLandsatScene(scene(), NOW), asset = { ...source.assets.red, shape: [64, 64], transform: [30, 0, grid.x, 0, -30, grid.y] };
  const file = Buffer.from(writeArrayBuffer(new Uint16Array(64 * 64).fill(20000), { width: 64, height: 64, BitsPerSample: [16], SamplesPerPixel: 1, SampleFormat: [1], ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, grid.x + 15, grid.y - 15, 0], ProjectedCSTypeGeoKey: 32611, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 2, GDAL_NODATA: '0' }));
  let requests = 0;
  const budget = createBudget({ fetchImpl: async (url, options) => { requests++; assert.match(url, /\?public-token$/); assert.equal(options.redirect, 'error'); const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range); assert.ok(range); const start = Number(range[1]), end = Math.min(Number(range[2]), file.length - 1); return response(file.subarray(start, end + 1), 206, { 'content-range': `bytes ${start}-${end}/${file.length}` }); } });
  try { const pixels = await readLandsatBand(asset, source, grid, budget, 'public-token'); assert.ok(pixels.every(n => Math.abs(n - 0.35) < 1e-9)); assert.ok(requests < 6); } finally { budget.close(); }
});

test('Landsat refuses full-file fallback and malformed range responses', async () => {
  const source = normalizeLandsatScene(scene(), NOW), grid = fieldGrid(field, 32611, 30, 15);
  for (const status of [200, 302, 403]) { const budget = createBudget({ fetchImpl: async () => response(Buffer.from('x'), status) }); try { await assert.rejects(readLandsatBand(source.assets.red, source, grid, budget, 'test'), /unavailable/); } finally { budget.close(); } }
  const budget = createBudget({ fetchImpl: async () => response(Buffer.from('x'), 206, { 'content-range': 'bytes 3-3/10000' }) }); try { await assert.rejects(readLandsatBand(source.assets.red, source, grid, budget, 'test'), /range response/); } finally { budget.close(); }
});

test('real public Landsat provider produces bounded, dated field measurements', { skip: process.env.RUN_LANDSAT_LIVE !== '1', timeout: 35000 }, async () => {
  const calls = [], output = await getLandsat({ field, timestamp: Date.now(), fetchImpl: async (url, options) => { calls.push(new URL(url).hostname); return fetch(url, options); } });
  assert.equal(output.source.id, 'nasa-landsat'); assert.ok(output.history.length > 0, output.message); assert.ok(output.history.length <= 4); assert.ok(output.history.some(item => item.status === 'clear')); assert.ok(output.history.every(item => item.resolutionMeters === 30 && item.ndre === null && Date.parse(item.date) <= Date.now()));
  assert.ok(calls.length <= 100); assert.ok(calls.every(host => ['planetarycomputer.microsoft.com', 'landsateuwest.blob.core.windows.net'].includes(host)));
  console.log(JSON.stringify({ source: output.source.id, status: output.status, requests: calls.length, history: output.history.map(item => ({ date: item.date, platform: item.platform, status: item.status, ndvi: item.ndvi, validPixels: item.validPixels })), change: output.change.status }));
});
