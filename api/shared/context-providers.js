// Point-scoped, bounded queries to public agency APIs. Secrets remain server-side.
const DAY = 86400000;
const SOURCES = Object.freeze({
  soil: { id: 'nrcs-ssurgo', name: 'USDA NRCS Soil Data Access', url: 'https://sdmdataaccess.nrcs.usda.gov/' },
  markets: { id: 'usda-ams', name: 'USDA AMS MyMarketNews', url: 'https://mymarketnews.ams.usda.gov/' },
  statistics: { id: 'nass', name: 'USDA NASS Quick Stats', url: 'https://quickstats.nass.usda.gov/' },
  air: { id: 'airnow', name: 'AirNow preliminary observations', url: 'https://www.airnow.gov/' },
  water: { id: 'wa-ecology', name: 'Washington Department of Ecology', url: 'https://ecology.wa.gov/water-shorelines/water-supply/water-availability/statewide-conditions/drought-response' }
});
const TTL = { soil: 180 * DAY, markets: 3600000, statistics: 7 * DAY, air: 30 * 60000, water: 6 * 3600000 };
const WATER_SERVICE = 'https://gis.ecology.wa.gov/serverext/rest/services/WR/Ecology_Water_Resources_Map_Service/MapServer';
const CROPS = Object.freeze({ apple: 'APPLES', apples: 'APPLES', wheat: 'WHEAT', potato: 'POTATOES', potatoes: 'POTATOES', cherries: 'CHERRIES', cherry: 'CHERRIES', pears: 'PEARS', pear: 'PEARS', grapes: 'GRAPES', grape: 'GRAPES', corn: 'CORN', barley: 'BARLEY', hay: 'HAY', hops: 'HOPS', blueberries: 'BLUEBERRIES', raspberries: 'RASPBERRIES' });
const clean = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
function number(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) throw new Error('Invalid provider number');
  const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid provider range'); return n;
}
function calendar(value) {
  if (typeof value !== 'string') throw new Error('Invalid provider date');
  let day = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(day);
  if (us) day = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  else if (/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(day)) day = day.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('Invalid provider date');
  return day;
}
function outcome(kind, status, timestamp, message, data = null, validUntil) {
  return { status, source: SOURCES[kind], fetchedAt: new Date(timestamp).toISOString(), validUntil: validUntil || new Date(timestamp + (status === 'ready' ? TTL[kind] : 5 * 60000)).toISOString(), data, message };
}
async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal, headers: { 'User-Agent': '(FarmerDaily, https://calm-desert-02e51f41e.1.azurestaticapps.net)', Accept: 'application/json', ...options.headers } });
      if (!response.ok || Number(response.headers?.get?.('content-length')) > 1048576) throw new Error('Provider unavailable');
      // Stop streaming at the byte limit, rather than allocating an unbounded body first.
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1048576) throw new Error('Provider response too large'); chunks.push(Buffer.from(value)); } }
        finally { reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if (typeof response.text === 'function') { const text = await response.text(); if (Buffer.byteLength(text) > 1048576) throw new Error('Provider response too large'); return JSON.parse(text); }
      const data = await response.json(); if (Buffer.byteLength(JSON.stringify(data)) > 1048576) throw new Error('Provider response too large'); return data;
    })(), new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timeout')); }, timeoutMs); })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
function soilQuery(location) {
  // Only validated numeric point coordinates enter SQL. No user text or boundary.
  return `SELECT TOP 20 m.mukey, m.muname, c.compname, c.comppct_r, c.drainagecl, c.slope_r, h.hzdept_r, h.hzdepb_r, h.awc_r, h.om_r, t.texture
FROM mapunit m LEFT JOIN component c ON c.mukey=m.mukey
OUTER APPLY (SELECT TOP 1 chkey,hzdept_r,hzdepb_r,awc_r,om_r FROM chorizon WHERE cokey=c.cokey ORDER BY hzdept_r,chkey) h
OUTER APPLY (SELECT TOP 1 texture FROM chtexturegrp WHERE chkey=h.chkey AND rvindicator='Yes' ORDER BY chtgkey) t
WHERE m.mukey IN (SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point (${location.longitude} ${location.latitude})'))
ORDER BY m.mukey,c.comppct_r DESC,c.cokey`;
}
function normalizeSoil(payload) {
  if (!Array.isArray(payload?.Table) || payload.Table.length > 21) throw new Error('Invalid soil response');
  if (!payload.Table.length) return { scope: 'representative_point', mapUnits: [] };
  const expected = ['mukey','muname','compname','comppct_r','drainagecl','slope_r','hzdept_r','hzdepb_r','awc_r','om_r','texture'];
  if (!Array.isArray(payload.Table[0]) || JSON.stringify(payload.Table[0].map(x => String(x).toLowerCase())) !== JSON.stringify(expected)) throw new Error('Unknown soil columns');
  const mapUnits = [];
  for (const row of payload.Table.slice(1)) {
    if (!Array.isArray(row) || row.length !== expected.length || !/^\d{1,20}$/.test(String(row[0])) || !clean(row[1])) throw new Error('Invalid soil row');
    let unit = mapUnits.find(u => u.id === String(row[0]));
    if (!unit) { unit = { id: String(row[0]), name: clean(row[1]), components: [] }; mapUnits.push(unit); }
    if (row[2] === null) continue;
    if (!clean(row[2])) throw new Error('Missing soil component');
    const topCm = number(row[6], 0, 1000), bottomCm = number(row[7], 0, 1000);
    if (topCm !== null && bottomCm !== null && bottomCm <= topCm) throw new Error('Invalid soil horizon');
    unit.components.push({ name: clean(row[2]), percent: number(row[3], 0, 100), drainage: clean(row[4]) || null, slopePercent: number(row[5], 0, 300),
      topHorizon: { topCm, bottomCm, texture: clean(row[10]) || null, availableWaterCapacityCmPerCm: number(row[8], 0, 1), organicMatterPercent: number(row[9], 0, 100) } });
  }
  return { scope: 'representative_point', mapUnits };
}
function normalizeMarkets(payload, field, timestamp) {
  const sections = Array.isArray(payload) ? payload : [payload];
  if (sections.length > 100 || sections.some(s => !s || !Array.isArray(s.results) || s.results.length > 5000)) throw new Error('Unknown market format');
  const rows = sections.flatMap(s => s.results); if (rows.length > 5000) throw new Error('Too many market rows');
  const items = [];
  const commodity = CROPS[String(field.crop).trim().toLowerCase()];
  if (!commodity) return { reportId: field.marketReportId, reportLabel: clean(field.marketLabel) || `Report ${field.marketReportId}`, items: [] };
  for (const row of rows) {
    // Report headers have no commodity; data rows must name the selected crop.
    if (!row || typeof row !== 'object') throw new Error('Invalid market row');
    if (!clean(row.commodity)) continue;
    if (clean(row.commodity).toUpperCase() !== commodity) continue;
    const date = calendar(row.report_date || row.report_begin_date), day = Date.parse(date);
    if (day > timestamp || timestamp - day > 15 * DAY) throw new Error('Market report not current');
    const low = number(row.low_price, 0, 1e9), high = number(row.high_price, 0, 1e9), mostlyLow = number(row.mostly_low_price, 0, 1e9), mostlyHigh = number(row.mostly_high_price, 0, 1e9);
    if ([low,high,mostlyLow,mostlyHigh].every(x => x === null)) continue;
    if (low !== null && high !== null && low > high || mostlyLow !== null && mostlyHigh !== null && mostlyLow > mostlyHigh) throw new Error('Invalid market range');
    const unit = clean(row.price_unit || row.unit || row.unit_of_sale), pack = clean(row.package || row.packaging);
    if (!unit && !pack) continue; // A naked price cannot be interpreted safely.
    items.push({ date, commodity: clean(row.commodity), variety: clean(row.variety) || null, market: clean(row.market_name || row.market_location || row.market) || null, package: pack || null, unit: unit || null,
      grade: clean(row.grade) || null, size: clean(row.size) || null, origin: clean(row.origin || row.origin_name) || null, currency: clean(row.currency || row.currency_name) || null,
      low, high, mostlyLow, mostlyHigh });
  }
  items.sort((a,b) => b.date.localeCompare(a.date));
  return { reportId: field.marketReportId, reportLabel: clean(field.marketLabel) || `Report ${field.marketReportId}`, items: items.slice(0, 12) };
}
function normalizeStatistics(payload, commodity, timestamp) {
  if (!Array.isArray(payload?.data) || payload.data.length > 1000) throw new Error('Invalid NASS response');
  const currentYear = new Date(timestamp).getUTCFullYear();
  const items = payload.data.map(row => {
    if (!row || row.state_alpha !== 'WA' || row.agg_level_desc !== 'STATE' || row.commodity_desc !== commodity || row.freq_desc !== 'ANNUAL' || row.statisticcat_desc !== 'PRODUCTION') throw new Error('Unexpected NASS scope');
    const year = number(row.year, currentYear - 2, currentYear);
    if (!Number.isInteger(year) || !clean(row.short_desc, 300) || !clean(row.unit_desc, 80)) throw new Error('Invalid NASS row');
    const value = clean(row.Value, 80);
    if (!/^(?:\d[\d,]*(?:\.\d+)?|\((?:D|Z|NA|X)\))$/.test(value)) throw new Error('Invalid NASS estimate');
    return { year, description: clean(row.short_desc, 300), value, unit: clean(row.unit_desc, 80), period: clean(row.reference_period_desc, 80) };
  }).sort((a,b) => b.year - a.year);
  return { scope: 'Washington statewide', commodity, items: items.slice(0, 10) };
}
function observedTime(row, timestamp) {
  const day = calendar(row.DateObserved), hour = number(row.HourObserved, 0, 23);
  if (!Number.isInteger(hour)) throw new Error('Invalid observation hour');
  // AirNow identifies Pacific reporting areas using PST/PDT; derive the local
  // offset for the reported date rather than the browser or server timezone.
  if (!['PST','PDT'].includes(clean(row.LocalTimeZone || row.TimeZone))) throw new Error('Unknown observation timezone');
  const naive = Date.parse(`${day}T${String(hour).padStart(2,'0')}:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const candidates = [naive + 7 * 3600000, naive + 8 * 3600000].filter(value => {
    const p = Object.fromEntries(formatter.formatToParts(value).map(x => [x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}` === day && Number(p.hour) === hour && value <= timestamp + 5 * 60000;
  });
  if (!candidates.length) throw new Error('Future air observation');
  const time = Math.max(...candidates); if (timestamp - time > 4 * 3600000) throw new Error('Stale air observation');
  return new Date(time).toISOString();
}
function normalizeAir(payload, timestamp) {
  if (!Array.isArray(payload) || payload.length > 50) throw new Error('Invalid AirNow response');
  const categories = ['Good','Moderate','Unhealthy for Sensitive Groups','Unhealthy','Very Unhealthy','Hazardous'];
  const observations = payload.map(row => {
    if (!row || !['PM2.5','PM10','O3'].includes(row.ParameterName) || row.StateCode !== 'WA') throw new Error('Unexpected air observation');
    const aqi = number(row.AQI, 0, 500);
    if (!Number.isInteger(aqi)) throw new Error('Missing air observation');
    const categoryIndex = aqi <= 50 ? 0 : aqi <= 100 ? 1 : aqi <= 150 ? 2 : aqi <= 200 ? 3 : aqi <= 300 ? 4 : 5;
    if (row.Category?.Name !== categories[categoryIndex] || Number(row.Category?.Number) !== categoryIndex + 1 || !clean(row.ReportingArea)) throw new Error('Invalid air category');
    return { pollutant: row.ParameterName, aqi, category: categories[categoryIndex], reportingArea: clean(row.ReportingArea), observedAt: observedTime(row, timestamp) };
  });
  return { preliminary: true, scope: 'reporting_area', observations };
}
function normalizeWater(payload, year) {
  if (!Array.isArray(payload?.features) || payload.features.length > 10 || payload.exceededTransferLimit) throw new Error('Invalid drought response');
  const areas = payload.features.map(feature => {
    const p = feature?.attributes;
    if (!p || !['Drought Advisory Area','Drought Emergency Declaration Area'].includes(p.Drought_Status) || !clean(p.Watershed)) throw new Error('Unknown drought category');
    return { status: p.Drought_Status, watershed: clean(p.Watershed) };
  });
  return { scope: 'regional', year, areas };
}
function createContextProviders({ fetchImpl = globalThis.fetch, now = Date.now, env = process.env, timeoutMs = 6000 } = {}) {
  const get = (url, options) => fetchJson(fetchImpl, url, options, timeoutMs);
  return {
    async soil({ location }) {
      const timestamp = now(), data = normalizeSoil(await get('https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: soilQuery(location), format: 'JSON+COLUMNNAME' }) }));
      return outcome('soil', data.mapUnits.length ? 'ready' : 'no_data', timestamp, 'Mapped soils at one representative point, not a field-wide survey or a measurement of current soil moisture. Component percentages describe the map unit; horizon values are estimates.', data);
    },
    async markets({ field }) {
      const timestamp = now();
      if (!field.marketReportId) return outcome('markets', 'not_selected', timestamp, 'Choose a USDA AMS report for this field. No generic market feed is substituted.');
      if (!/^\d{1,10}$/.test(field.marketReportId)) throw new Error('Invalid report selection');
      if (!CROPS[String(field.crop).trim().toLowerCase()]) return outcome('markets', 'not_selected', timestamp, 'This crop has not been mapped to a supported AMS commodity. No unrelated prices are substituted.');
      if (!env.USDA_AMS_API_KEY) return outcome('markets', 'needs_configuration', timestamp, 'USDA AMS requires an administrator-configured API key. No live prices are available yet.');
      const format = value => { const d = new Date(value); return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`; };
      const url = new URL(`https://marsapi.ams.usda.gov/services/v1.2/reports/${field.marketReportId}`);
      url.searchParams.set('q', `report_begin_date=${format(timestamp - 14 * DAY)}:${format(timestamp)}`); url.searchParams.set('allSections', 'true');
      const data = normalizeMarkets(await get(url.href, { headers: { Authorization: `Basic ${Buffer.from(`${env.USDA_AMS_API_KEY}:`).toString('base64')}` } }), field, timestamp);
      return outcome('markets', data.items.length ? 'ready' : 'no_data', timestamp, 'Selected published report, up to 14 days old. Prices depend on grade, package, market and date; not a farm quote or a sell/hold recommendation.', data);
    },
    async statistics({ field }) {
      const timestamp = now(), commodity = CROPS[String(field.crop).trim().toLowerCase()];
      if (!commodity) return outcome('statistics', 'not_selected', timestamp, 'This crop has not been mapped to a supported NASS commodity.');
      if (!env.USDA_NASS_API_KEY) return outcome('statistics', 'needs_configuration', timestamp, 'USDA NASS requires an administrator-configured API key. This product uses the NASS API but is not endorsed or certified by NASS.');
      const url = new URL('https://quickstats.nass.usda.gov/api/api_GET/');
      url.search = new URLSearchParams({ key: env.USDA_NASS_API_KEY, format: 'JSON', commodity_desc: commodity, state_alpha: 'WA', agg_level_desc: 'STATE', source_desc: 'SURVEY', freq_desc: 'ANNUAL', statisticcat_desc: 'PRODUCTION', domain_desc: 'TOTAL', year__GE: String(new Date(timestamp).getUTCFullYear() - 2) }).toString();
      const data = normalizeStatistics(await get(url.href), commodity, timestamp);
      return outcome('statistics', data.items.length ? 'ready' : 'no_data', timestamp, 'Statewide historical production context, not a field yield or harvest recommendation. This product uses the NASS API but is not endorsed or certified by NASS.', data);
    },
    async air({ location }) {
      const timestamp = now();
      if (!env.AIRNOW_API_KEY) return outcome('air', 'needs_configuration', timestamp, 'AirNow requires an administrator-configured API key. No live air-quality observation is available yet.');
      const url = new URL('https://www.airnowapi.org/aq/observation/latLong/current/');
      url.search = new URLSearchParams({ format: 'application/json', latitude: String(location.latitude), longitude: String(location.longitude), distance: '25', API_KEY: env.AIRNOW_API_KEY }).toString();
      const data = normalizeAir(await get(url.href), timestamp);
      const validUntil = data.observations.length ? new Date(Math.min(timestamp + TTL.air, ...data.observations.map(x => Date.parse(x.observedAt) + 4 * 3600000))).toISOString() : undefined;
      return outcome('air', data.observations.length ? 'ready' : 'no_data', timestamp, 'Preliminary reporting-area AQI for awareness only, not an on-farm sensor, PM2.5 concentration or a worker-safety/compliance determination. Check current Washington L&I requirements.', data, validUntil);
    },
    async water({ location }) {
      const timestamp = now(), year = new Date(timestamp).getUTCFullYear();
      const service = await get(`${WATER_SERVICE}?f=json`);
      if (!Array.isArray(service?.layers) || service.layers.length > 1000) throw new Error('Invalid Ecology service');
      const layer = service.layers.find(row => row.name === `Drought Layer Year ${year}` && Number.isInteger(row.id) && row.id >= 0 && row.id < 10000);
      if (!layer) return outcome('water', 'unavailable', timestamp, `Ecology's public map service does not expose a verified ${year} drought layer. Open Ecology for current conditions; older declarations are not presented as current.`);
      const url = new URL(`${WATER_SERVICE}/${layer.id}/query`);
      url.search = new URLSearchParams({ f: 'json', where: '1=1', geometry: JSON.stringify({ x: location.longitude, y: location.latitude, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'Drought_Status,Watershed', returnGeometry: 'false', resultRecordCount: '10' }).toString();
      const data = normalizeWater(await get(url.href), year);
      return outcome('water', data.areas.length ? 'ready' : 'no_data', timestamp, 'Regional declaration context, not a farm water allocation or irrigation recommendation. No matching map record does not establish that water supply is adequate.', data);
    }
  };
}
module.exports = { createContextProviders, SOURCES, TTL, outcome, fetchJson, soilQuery, normalizeSoil, normalizeMarkets, normalizeStatistics, normalizeAir, normalizeWater, WATER_SERVICE };
