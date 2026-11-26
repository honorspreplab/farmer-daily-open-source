const { createHash } = require('node:crypto');
const { getContainer: defaultContainer, readDocument } = require('./store');
const { HttpError } = require('./access');
const { normalizeGeometry, locationKey } = require('./field-geometry');
const { createWeatherHandler } = require('../weather');

const YEAR = 365 * 24 * 60 * 60 * 1000;
const ALERT_TTL = 2 * 60 * 1000;
const HEADERS = { 'User-Agent': '(FarmerDaily, https://calm-desert-02e51f41e.1.azurestaticapps.net)', Accept: 'application/geo+json, application/json' };
const ELEVATION_SOURCE = { id: 'usgs', name: 'USGS 3DEP Elevation Point Query Service', url: 'https://apps.nationalmap.gov/epqs/' };
const ALERT_SOURCE = { id: 'nws', name: 'NOAA / National Weather Service', url: 'https://www.weather.gov/documentation/services-web-alerts' };
const contextId = (userId, fieldId) => `field-context-${createHash('sha256').update(JSON.stringify([userId, fieldId])).digest('hex')}`;
function fieldFingerprint(field) { return JSON.stringify(field); }
function currentField(state, id) { return state?.state?.fields?.find(field => field.id === id); }
function matches(field, expected) { return Boolean(field && field.dataConsent === true && fieldFingerprint(field) === fieldFingerprint(expected)); }

async function contexts(container, userId) {
  const { resources } = await container.items.query({
    query: 'SELECT * FROM c WHERE c.userId = @userId AND c.type = @type',
    parameters: [{ name: '@userId', value: userId }, { name: '@type', value: 'fieldContext' }]
  }, { partitionKey: userId }).fetchAll();
  return resources || [];
}
function contextMatches(document, fields) {
  const field = fields?.find(item => item.id === document.fieldId);
  try { return field?.dataConsent === true && document.locationKey === locationKey(field); } catch { return false; }
}
async function exportFieldContexts(container, userId, fields) {
  return (await contexts(container, userId)).filter(document => contextMatches(document, fields)).map(({ fieldId, locationKey, elevation }) => ({ fieldId, locationKey, elevation }));
}
async function pruneFieldContexts(container, userId, fields = []) {
  for (const document of await contexts(container, userId)) {
    if (contextMatches(document, fields)) continue;
    try { await container.item(document.id, userId).delete(document._etag ? { accessCondition: { type: 'IfMatch', condition: document._etag } } : undefined); }
    catch (error) { if (![404, 412].includes(Number(error.code))) throw error; }
  }
}
async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, headers: HEADERS, redirect: 'error' });
        if (!response.ok) throw new Error('Field data provider unavailable');
        const length = Number(response.headers?.get?.('content-length'));
        if (length > 1024 * 1024) throw new Error('Field data response too large');
        if (typeof response.text === 'function') {
          const body = await response.text();
          if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('Field data response too large');
          return JSON.parse(body);
        }
        return response.json();
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Field data provider timed out')); }, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
function elevationResult(data, timestamp) {
  const value = data?.value;
  // EPQS returns a numeric value; null and -1000000 are not zero elevation.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1500 || value > 15000) throw new Error('Elevation unavailable');
  return { status: 'loaded', feet: value, meters: value * 0.3048, fetchedAt: new Date(timestamp).toISOString(), source: ELEVATION_SOURCE };
}
function unavailableElevation() { return { status: 'unavailable', feet: null, meters: null, fetchedAt: null, source: ELEVATION_SOURCE }; }
function safeString(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function alertUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.weather.gov' && !url.port && !url.username && !url.password &&
      /^\/alerts\/[A-Za-z0-9:._%-]+$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function normalizeAlerts(data, timestamp) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 200) throw new Error('Alerts unavailable');
  const updated = Date.parse(data.updated);
  if (!Number.isFinite(updated) || updated > timestamp + 60000 || timestamp - updated > 30 * 60 * 1000) throw new Error('Alert feed freshness unavailable');
  const items = [];
  for (const feature of data.features) {
    const properties = feature?.properties;
    if (!properties || properties.status !== 'Actual') throw new Error('Alert data invalid');
    let sent;
    if (properties.sent !== undefined) {
      if (typeof properties.sent !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(properties.sent)) throw new Error('Alert sent time invalid');
      const timestampSent = Date.parse(properties.sent);
      const calendar = new Date(`${properties.sent.slice(0, 10)}T12:00:00Z`);
      if (!Number.isFinite(timestampSent) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== properties.sent.slice(0, 10) || timestampSent > timestamp + 60000) throw new Error('Alert sent time invalid');
      sent = new Date(timestampSent).toISOString();
    }
    const effective = Date.parse(properties.effective), expires = Date.parse(properties.expires);
    if (!Number.isFinite(effective) || !Number.isFinite(expires) || expires <= effective || !safeString(properties.event, 200) || !safeString(properties.headline, 500)) throw new Error('Alert data invalid');
    // An expired entry is not evidence that there are no alerts now: fail the feed.
    if (expires <= timestamp) throw new Error('Alert feed expired');
    if (!['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'].includes(properties.severity)) throw new Error('Alert severity invalid');
    const url = alertUrl(feature.id) || alertUrl(properties['@id']);
    if (!url) throw new Error('Alert source invalid');
    items.push({ id: safeString(properties.id, 300) || url, event: properties.event.slice(0, 200), severity: properties.severity,
      headline: properties.headline.slice(0, 500), description: safeString(properties.description, 8000), instruction: safeString(properties.instruction, 8000),
      ...(sent ? { sent } : {}), effective: new Date(effective).toISOString(), expires: new Date(expires).toISOString(), url });
  }
  return { status: 'live', items, fetchedAt: new Date(timestamp).toISOString(), updated: new Date(updated).toISOString(), source: ALERT_SOURCE };
}
function batchError(batch) {
  const failure = batch.result?.find(item => item.statusCode >= 400 && item.statusCode !== 424);
  if (failure || !batch.result || batch.result.some(item => item.statusCode >= 400) || batch.code >= 400) {
    const error = new Error('Field context transaction failed'); error.code = failure?.statusCode || batch.code || 503; throw error;
  }
}
function createFieldDataService({ getContainer = defaultContainer, fetchImpl = globalThis.fetch, now = Date.now, weatherHandler = createWeatherHandler({ fetchImpl, now }), timeoutMs = 4000 } = {}) {
  const alertCache = new Map(), alertFlight = new Map(), elevationFlight = new Map();
  async function alerts(location, key, refresh) {
    const cached = alertCache.get(key), age = cached ? now() - Date.parse(cached.fetchedAt) : Infinity;
    if (cached && age >= 0 && age < ALERT_TTL && (!refresh || age < 60000) && cached.items.every(item => Date.parse(item.expires) > now())) return { ...cached, status: 'cached' };
    if (!alertFlight.has(key)) {
      const request = fetchJson(fetchImpl, `https://api.weather.gov/alerts?active=true&point=${location.latitude},${location.longitude}`, timeoutMs)
        .then(data => { const result = normalizeAlerts(data, now()); alertCache.set(key, result); while (alertCache.size > 128) alertCache.delete(alertCache.keys().next().value); return result; })
        .catch(() => ({ status: 'unavailable', items: [], fetchedAt: null, source: ALERT_SOURCE }))
        .finally(() => alertFlight.delete(key));
      alertFlight.set(key, request);
    }
    return alertFlight.get(key);
  }
  async function storeElevation(userId, field, key, elevation) {
    const container = getContainer(), id = contextId(userId, field.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await readDocument(container, `state-${userId}`, userId);
      if (!matches(currentField(state, field.id), field)) throw new HttpError(409, 'This field changed. Reload before requesting field data.');
      const existing = await readDocument(container, id, userId);
      const document = { id, userId, type: 'fieldContext', fieldId: field.id, locationKey: key, elevation };
      try {
        batchError(await container.items.batch([
          { operationType: 'Replace', id: state.id, resourceBody: state, ifMatch: state._etag },
          existing ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag } : { operationType: 'Create', resourceBody: document }
        ], userId));
        return;
      } catch (error) { if ([404, 409, 412].includes(Number(error.code))) continue; throw error; }
    }
    throw new HttpError(409, 'Your fields changed. Please retry.');
  }
  async function elevation(userId, field, key, location, cacheOnly = false) {
    const container = getContainer(), id = contextId(userId, field.id), cached = await readDocument(container, id, userId);
    const age = cached ? now() - Date.parse(cached.elevation?.fetchedAt) : Infinity;
    if (cached?.locationKey === key && cached.elevation?.status === 'loaded' && age >= 0 && age < YEAR) return cached.elevation;
    // Brief generation must not wait for stable terrain enrichment or contend on
    // the owner-state ETag. The field-data screen still fetches and persists it.
    if (cacheOnly) return unavailableElevation();
    const flightKey = `${userId}/${id}/${key}`;
    if (!elevationFlight.has(flightKey)) {
      const request = (async () => {
        let result;
        try {
          const url = `https://epqs.nationalmap.gov/v1/json?x=${location.longitude}&y=${location.latitude}&units=Feet&wkid=4326&includeDate=false`;
          result = elevationResult(await fetchJson(fetchImpl, url, timeoutMs), now());
        } catch { return unavailableElevation(); }
        await storeElevation(userId, field, key, result);
        return result;
      })().finally(() => elevationFlight.delete(flightKey));
      elevationFlight.set(flightKey, request);
    }
    return elevationFlight.get(flightKey);
  }
  return {
    async getFieldData({ userId, field, refresh = false, cacheOnlyElevation = false, signal }) {
      const container = getContainer();
      if (!field?.id) throw new HttpError(404, 'Field not found');
      const original = await readDocument(container, `state-${userId}`, userId), stored = currentField(original, field.id);
      signal?.throwIfAborted();
      if (!stored || fieldFingerprint(stored) !== fieldFingerprint(field)) throw new HttpError(409, 'This field changed. Reload before requesting field data.');
      if (stored.dataConsent !== true) throw new HttpError(409, 'Enable field data sharing for this field before requesting weather or elevation.');
      let geometry;
      try { geometry = normalizeGeometry(stored); } catch { throw new HttpError(409, 'Save a valid field location first.'); }
      const key = locationKey(stored), { location } = geometry;
      const weatherPromise = (async () => {
        try {
          const context = {};
          await weatherHandler(context, { method: 'GET', query: { lat: String(location.latitude), lon: String(location.longitude), ...(refresh ? { refresh: '1' } : {}) } });
          return context.res?.status === 200 ? context.res.body : null;
        } catch { return null; }
      })();
      const [weather, height, warnings] = await Promise.all([weatherPromise, elevation(userId, stored, key, location, cacheOnlyElevation), alerts(location, key, refresh)]);
      signal?.throwIfAborted();
      const latest = await readDocument(container, `state-${userId}`, userId);
      if (!matches(currentField(latest, stored.id), stored)) throw new HttpError(409, 'This field changed. Reload before requesting field data.');
      return { fieldId: stored.id, locationKey: key, location, weather,
        weatherStatus: !weather ? 'unavailable' : weather.stale || now() - Date.parse(weather.fetchedAt) > 5000 ? 'cached' : 'live',
        elevation: height, alerts: warnings, fetchedAt: new Date(now()).toISOString() };
    }
  };
}
module.exports = { createFieldDataService, contextId, exportFieldContexts, pruneFieldContexts, normalizeAlerts, elevationResult };
