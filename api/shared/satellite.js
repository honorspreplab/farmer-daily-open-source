'use strict';
const { createHash } = require('node:crypto');
const { getContainer: defaultContainer, readDocument } = require('./store');
const { HttpError } = require('./access');
const { normalizeGeometry, locationKey } = require('./field-geometry');
const { fieldGrid, normalizeScene, createBudget, readBand, analyzePixels, compareScenes } = require('./satellite-raster');
const DAY = 86400000, CACHE_VERSION = 1;
const SOURCE = { id: 'sentinel-2', name: 'Sentinel-2 L2A via Element84 Earth Search', url: 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a' };
const NASA_SOURCE = { id: 'nasa-landsat', name: 'NASA/USGS Landsat 8/9 via Microsoft Planetary Computer', url: 'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-reflectance' };
const CDL = 'https://pdi.scinet.usda.gov/image/rest/services/CDL_WM/ImageServer';
const contextId = (userId, fieldId) => `satellite-context-${createHash('sha256').update(JSON.stringify([userId, fieldId])).digest('hex')}`;
const fingerprint = field => createHash('sha256').update(JSON.stringify(field)).digest('hex');
const savedField = (state, id) => state?.state?.fields?.find(field => field.id === id);
function matching(field, expected) { return Boolean((field?.satelliteConsent === true || field?.landsatConsent === true) && field.boundary && fingerprint(field) === fingerprint(expected)); }
function contextMatches(document, fields) {
  const field = fields?.find(item => item.id === document.fieldId);
  try { return matching(field, field) && document.version === CACHE_VERSION && document.locationKey === locationKey(field) && document.fingerprint === fingerprint(field); } catch { return false; }
}
async function contexts(container, userId) {
  return (await container.items.query({ query: 'SELECT * FROM c WHERE c.userId = @userId AND c.type = @type', parameters: [{ name: '@userId', value: userId }, { name: '@type', value: 'satelliteContext' }] }, { partitionKey: userId }).fetchAll()).resources || [];
}
async function exportSatelliteContexts(container, userId, fields) {
  return (await contexts(container, userId)).filter(document => contextMatches(document, fields)).map(document => structuredClone(document.result));
}
async function pruneSatelliteContexts(container, userId, fields = []) {
  for (const document of await contexts(container, userId)) {
    if (contextMatches(document, fields)) continue;
    try { await container.item(document.id, userId).delete(document._etag ? { accessCondition: { type: 'IfMatch', condition: document._etag } } : undefined); }
    catch (error) { if (![404, 412].includes(Number(error.code))) throw error; }
  }
}
async function json(budget, url, options) { return JSON.parse((await budget.request(url, options)).body.toString('utf8')); }
async function cropHistory(location, budget, timestamp) {
  const currentYear = new Date(timestamp).getUTCFullYear();
  const catalog = await json(budget, `${CDL}/query?${new URLSearchParams({ f: 'json', where: `Year >= ${currentYear - 4} AND Year < ${currentYear}`, outFields: 'OBJECTID,Year,Name,LowPS', returnGeometry: 'false' })}`);
  if (catalog.error || !Array.isArray(catalog.features) || catalog.features.length > 20) throw new Error('USDA annual crop catalog unavailable');
  const annual = catalog.features.map(item => item.attributes).filter(item => Number.isInteger(item?.Year) && item.Year < currentYear && item.Year >= currentYear - 4 && Number.isInteger(item.OBJECTID) && item.OBJECTID > 0 && [10, 30].includes(item.LowPS));
  const years = [...new Map(annual.sort((a, b) => a.Year - b.Year).map(item => [item.Year, item])).values()].slice(-3);
  if (!years.length) throw new Error('No published USDA annual crop years');
  const table = await json(budget, `${CDL}/rasterAttributeTable?f=json`);
  if (!Array.isArray(table.features) || table.features.length > 256) throw new Error('USDA crop labels unavailable');
  const labels = new Map(table.features.map(item => item.attributes).filter(item => Number.isInteger(item?.Value) && item.Value > 0 && typeof item.Class_Names === 'string' && item.Class_Names.length <= 100).map(item => [item.Value, item.Class_Names]));
  const result = await Promise.all(years.map(async item => {
    const query = new URLSearchParams({ f: 'json', geometry: JSON.stringify({ x: location.longitude, y: location.latitude, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [item.OBJECTID], where: `Year=${item.Year}` }), pixelSize: JSON.stringify({ x: item.LowPS, y: item.LowPS, spatialReference: { wkid: 3857 } }), returnCatalogItems: 'true', returnGeometry: 'false' });
    const data = await json(budget, `${CDL}/identify?${query}`);
    const actual = data.catalogItems?.features?.map(feature => feature.attributes) || [];
    const code = typeof data.value === 'string' && /^\d{1,3}$/.test(data.value) ? Number(data.value) : null;
    if (data.error || actual.length !== 1 || actual[0].Year !== item.Year || actual[0].OBJECTID !== item.OBJECTID || !labels.has(code)) return null;
    return { year: item.Year, code, label: labels.get(code), resolutionMeters: item.LowPS, scope: 'representative-point', sourceUrl: 'https://www.nass.usda.gov/Research_and_Science/Cropland/SARS1a.php' };
  }));
  return result.filter(Boolean);
}
function batchError(result) {
  const failed = result?.result?.find(item => item.statusCode >= 400 && item.statusCode !== 424);
  if (!result?.result || result.code >= 400 || result.result.some(item => item.statusCode >= 400)) throw Object.assign(new Error('Satellite cache transaction failed'), { code: failed?.statusCode || result.code || 503 });
}
function createSatelliteService({ getContainer = defaultContainer, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 24000, readBandImpl = readBand, getLandsatImpl = options => require('./landsat').getLandsat(options) } = {}) {
  const flights = new Map(), ownerWindows = new Map(), activeOwners = new Map();
  async function check(userId, field) {
    const stored = savedField(await readDocument(getContainer(), `state-${userId}`, userId), field?.id);
    if (!matching(stored, field)) throw new HttpError(409, 'Save a field boundary and enable Sentinel-2 or NASA Landsat sharing before loading imagery. If this field changed, reload it.');
    try { normalizeGeometry(stored); } catch { throw new HttpError(409, 'Save a valid field boundary first.'); }
    return stored;
  }
  async function cached(userId, field) {
    const document = await readDocument(getContainer(), contextId(userId, field.id), userId);
    return document && contextMatches(document, [field]) ? document : null;
  }
  async function store(userId, field, result) {
    const container = getContainer(), id = contextId(userId, field.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await readDocument(container, `state-${userId}`, userId);
      if (!matching(savedField(state, field.id), field)) throw new HttpError(409, 'This field changed while satellite data loaded. Reload it.');
      const existing = await readDocument(container, id, userId);
      const document = { id, userId, type: 'satelliteContext', version: CACHE_VERSION, fieldId: field.id, fingerprint: fingerprint(field), locationKey: locationKey(field), result };
      try {
        batchError(await container.items.batch([{ operationType: 'Replace', id: state.id, resourceBody: state, ifMatch: state._etag }, existing ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag } : { operationType: 'Create', resourceBody: document }], userId));
        return;
      } catch (error) { if (![404, 409, 412].includes(Number(error.code))) throw error; }
    }
    throw new HttpError(409, 'Your fields changed. Please retry.');
  }
  async function generate(userId, field, previous) {
    const timestamp = now(), location = normalizeGeometry(field), budget = createBudget({ fetchImpl, timeoutMs });
    const result = { fieldId: field.id, locationKey: locationKey(field), fetchedAt: new Date(timestamp).toISOString(), status: 'unavailable', source: SOURCE, history: [], change: { status: 'insufficient', confidence: 'low', message: 'Two recent clear images are needed for a comparison.' }, problemAreas: [], cropHistory: [], cropHistoryStatus: 'unavailable', resolutionMeters: 20, message: 'Satellite imagery is temporarily unavailable. No vegetation values have been estimated.' };
    if (!field.satelliteConsent) { result.status = 'not_selected'; result.message = 'Sentinel-2 and USDA crop history are off for this field.'; }
    result.landsat = { fieldId: field.id, locationKey: result.locationKey, fetchedAt: result.fetchedAt, status: field.landsatConsent ? 'unavailable' : 'not_selected', source: NASA_SOURCE, resolutionMeters: 30, history: [], problemAreas: [], change: { status: 'insufficient', confidence: 'low' }, message: field.landsatConsent ? 'NASA/USGS Landsat data are temporarily unavailable. Sentinel-2 is checked independently; no Landsat measurements have been estimated.' : 'Enable the separate NASA/USGS Landsat permission to check this additional source.' };
    // Each provider has its own bounded work window. An outage must not remove
    // the other provider's evidence, and existing Sentinel consent is not NASA consent.
    const nasaPromise = field.landsatConsent === true
      ? Promise.resolve().then(() => getLandsatImpl({ field, previous: previous?.result?.landsat, timestamp, fetchImpl, timeoutMs })).then(data => { result.landsat = { ...data, fieldId: field.id, locationKey: result.locationKey }; }).catch(() => {})
      : Promise.resolve();
    const cropAge = timestamp - Date.parse(previous?.result?.cropHistoryFetchedAt);
    const historyPromise = !field.satelliteConsent ? Promise.resolve() : previous?.result?.cropHistoryStatus === 'loaded' && cropAge >= 0 && cropAge < 30 * DAY
      ? Promise.resolve().then(() => { result.cropHistory = structuredClone(previous.result.cropHistory); result.cropHistoryStatus = 'loaded'; result.cropHistoryFetchedAt = previous.result.cropHistoryFetchedAt; })
      : cropHistory(location.location, budget, timestamp).then(items => { result.cropHistory = items; result.cropHistoryStatus = items.length ? 'loaded' : 'unavailable'; result.cropHistoryFetchedAt = new Date(timestamp).toISOString(); }).catch(() => {});
    if (field.satelliteConsent === true) try {
      const ring = location.boundary.coordinates[0], bbox = [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))];
      const search = new URLSearchParams({ collections: 'sentinel-2-l2a', bbox: bbox.join(','), datetime: `${new Date(timestamp - 90 * DAY).toISOString()}/${new Date(timestamp).toISOString()}`, limit: '24', sortby: '-properties.datetime' });
      const catalog = await json(budget, `https://earth-search.aws.element84.com/v1/search?${search}`);
      if (catalog?.type !== 'FeatureCollection' || !Array.isArray(catalog.features) || catalog.features.length > 24) throw new Error('Satellite catalog invalid');
      const candidates = [];
      for (const item of catalog.features) { try { candidates.push(normalizeScene(item, timestamp)); } catch {} }
      candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const newest = candidates[0];
      result.latestAvailableDate = newest?.date || null;
      // Keep the newest pass, then prefer plausible clear recent scenes. Catalog
      // cloud cover is selection-only; every field metric still comes from SCL pixels.
      const preferred = [...candidates].sort((a, b) => {
        const aRecent = timestamp - Date.parse(a.date) <= 21 * DAY, bRecent = timestamp - Date.parse(b.date) <= 21 * DAY;
        return Number(bRecent) - Number(aRecent) || a.catalogCloudPercent - b.catalogCloudPercent || Date.parse(b.date) - Date.parse(a.date);
      });
      // Multiple tiles from the same pass are not independent time observations.
      const scenes = [], days = new Set();
      for (const candidate of newest ? [newest, ...preferred] : []) {
        if (days.has(candidate.date.slice(0, 10)) || scenes.length && candidate.epsg !== scenes[0].epsg) continue;
        days.add(candidate.date.slice(0, 10)); scenes.push(candidate); if (scenes.length >= 4) break;
      }
      const analyzed = [];
      if (!scenes.length) { result.status = 'insufficient'; result.message = 'No supported Sentinel-2 scenes were found for this boundary in the last 90 days.'; }
      for (const scene of scenes) {
        try {
          const grid = fieldGrid(field, scene.epsg);
          const entries = await Promise.all(Object.entries(scene.assets).map(async ([name, asset]) => [name, await readBandImpl(asset, scene, grid, budget)]));
          analyzed.push(analyzePixels(scene, grid, Object.fromEntries(entries)));
        } catch (error) {
          if (/too large/.test(error.message)) { result.status = 'insufficient'; result.message = error.message; break; }
        }
      }
      if (analyzed.length) {
        analyzed.sort((a, b) => Date.parse(a.summary.date) - Date.parse(b.summary.date));
        const clear = analyzed.filter(item => item.summary.status === 'clear');
        const latest = analyzed[analyzed.length - 1], latestClear = clear[clear.length - 1];
        const prior = latestClear && clear.slice(0, -1).reverse().find(item => item.grid.key === latestClear.grid.key);
        const comparison = compareScenes(prior, latestClear);
        const recent = latestClear && timestamp - Date.parse(latestClear.summary.date) <= 21 * DAY;
        result.status = recent ? 'live' : 'insufficient';
        result.change = recent ? comparison.change : result.change;
        result.problemAreas = recent ? comparison.problemAreas : [];
        if (recent) result.validUntil = new Date(Math.min(timestamp + 2 * DAY, Date.parse(latestClear.summary.date) + 21 * DAY)).toISOString();
        const combined = new Map((previous?.result?.history || []).filter(item => Date.parse(item.date) <= timestamp && timestamp - Date.parse(item.date) < 366 * DAY).map(item => [item.sourceId, item]));
        for (const item of analyzed) combined.set(item.summary.sourceId, item.summary);
        result.history = [...combined.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-36);
        result.message = recent ? (latest.summary.status === 'clear' ? 'Vegetation indices are calculated from clear pixels inside your field boundary. Seasonal changes, harvest and mixed pixels can affect the signal.' : 'The newest image is cloudy or incomplete. The most recent usable clear image is shown with its actual date.') : 'Not enough recent clear land pixels for a reliable field comparison. Saved history remains visible; no crop-health conclusion is made.';
      }
    } catch { /* Partial results are explicit; never replace an outage with synthetic values. */ }
    await Promise.all([historyPromise, nasaPromise]);
    budget.close();
    if (field.satelliteConsent && !result.history.length && previous?.result?.history?.length) result.history = previous.result.history.filter(item => Date.parse(item.date) <= timestamp && timestamp - Date.parse(item.date) < 366 * DAY).slice(-36);
    const sourceYears = [...new Set(result.history.map(item => new Date(item.date).getUTCFullYear()).filter(Number.isFinite))].sort();
    if (sourceYears.length) result.source = { ...SOURCE, attribution: `Contains modified Copernicus Sentinel data ${sourceYears.join(', ')}` };
    await check(userId, field);
    await store(userId, field, result);
    return result;
  }
  return {
    async readCachedSatelliteHistory({ userId, field }) {
      // A dated, clear history observation is useful even when there are not two
      // comparable recent scenes for a change advisory. Keep that distinction:
      // this reader never refreshes imagery or upgrades any saved status/date.
      try {
        await check(userId, field);
        const document = await cached(userId, field);
        await check(userId, field);
        if (!document?.result) return null;
        const { landsat, ...sentinel } = structuredClone(document.result);
        return {
          ...(field.satelliteConsent === true ? sentinel : { fieldId: field.id, locationKey: document.locationKey }),
          ...(field.landsatConsent === true && landsat ? { landsat } : {})
        };
      } catch (error) { if (error instanceof HttpError) return null; throw error; }
    },
    async readCachedSatellite({ userId, field }) {
      try {
        await check(userId, field);
        const document = await cached(userId, field);
        function usable(part) {
          const age = now() - Date.parse(part?.fetchedAt), acquired = Date.parse(part?.change?.currentDate);
          return Number.isFinite(age) && age >= 0 && age <= 2 * DAY && part?.status === 'live' && Date.parse(part.validUntil) > now() && Number.isFinite(acquired) && acquired <= now() && now() - acquired <= 21 * DAY && part.history?.some(item => item.date === part.change.currentDate && item.status === 'clear');
        }
        const sentinel = field.satelliteConsent && usable(document?.result), landsat = field.landsatConsent && usable(document?.result?.landsat);
        if (!document || !sentinel && !landsat) return null;
        await check(userId, field);
        const result = structuredClone(document.result);
        if (sentinel) result.status = 'cached';
        if (landsat) result.landsat.status = 'cached';
        return result;
      } catch (error) { if (error instanceof HttpError) return null; throw error; }
    },
    async getSatellite({ userId, field, refresh = false }) {
      await check(userId, field);
      const document = await cached(userId, field), age = now() - Date.parse(document?.result?.fetchedAt);
      const parts = [document?.result, document?.result?.landsat].filter(Boolean);
      const ttl = parts.some(part => part.status === 'live') ? 12 * 3600000 : 15 * 60000;
      const liveValid = parts.every(part => part.status !== 'live' || Date.parse(part.validUntil) > now());
      if (document && liveValid && age >= 0 && age < (refresh ? Math.min(ttl, 30 * 60000) : ttl)) {
        await check(userId, field);
        const result = structuredClone(document.result);
        if (result.status === 'live') result.status = 'cached';
        if (result.landsat?.status === 'live') result.landsat.status = 'cached';
        return result;
      }
      const flightKey = `${userId}/${field.id}/${fingerprint(field)}`;
      if (!flights.has(flightKey)) {
        const time = now(), recent = (ownerWindows.get(userId) || []).filter(value => time >= value && time - value < 15 * 60000);
        if ((activeOwners.get(userId) || 0) >= 2 || flights.size >= 8 || recent.length >= 6) throw new HttpError(429, 'Satellite analysis is busy. Wait a few minutes before refreshing or loading more fields.');
        ownerWindows.set(userId, [...recent, time]); activeOwners.set(userId, (activeOwners.get(userId) || 0) + 1);
        for (const [id, values] of ownerWindows) if (values.every(value => time - value >= 15 * 60000) && !activeOwners.has(id)) ownerWindows.delete(id);
        while (ownerWindows.size > 1000) ownerWindows.delete(ownerWindows.keys().next().value);
        flights.set(flightKey, generate(userId, field, document).finally(() => { flights.delete(flightKey); const active = activeOwners.get(userId) - 1; if (active > 0) activeOwners.set(userId, active); else activeOwners.delete(userId); }));
      }
      const result = await flights.get(flightKey);
      await check(userId, field);
      return structuredClone(result);
    }
  };
}
module.exports = { createSatelliteService, contextId, exportSatelliteContexts, pruneSatelliteContexts, cropHistory, SOURCE, NASA_SOURCE };
