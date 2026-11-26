'use strict';
const { HttpError } = require('./access');
const { normalizeGeometry } = require('./field-geometry');
const { windMph } = require('./advisory-engine');
const { number, iso, weatherRecord, taskRecord } = require('./ai-evidence');
const { exactKeys, INSTRUCTIONS } = require('./ai-provider');
const { MAX_OUTPUT_TOKENS } = require('./ai-budget');
const MAX_TOOL_CALLS = 4;
const DESCRIPTIONS = Object.freeze({
  get_weather: 'Read current cached or live NWS weather forecasts, with Open-Meteo fallback if necessary, for one permitted field. Does not refresh weather alerts. Returns numeric forecasts only.',
  get_satellite_history: 'Read already processed, dated Sentinel-2 and NASA/USGS Landsat NDVI history for one permitted field. No new imagery download. This cannot diagnose disease or measure soil moisture.',
  get_farm_context: 'Read already cached soil, regional air and drought context plus market/statistics availability. No upstream requests, no new subscriptions and no prices without units.',
  get_tasks: 'Read counts and enumerated types of due tasks, never free-text notes or task names.'
});
function permittedFields(saved, name) {
  return saved.fields.flatMap((field, index) => {
    if (name === 'get_weather' && field.dataConsent !== true || name === 'get_farm_context' && field.contextConsent !== true || name === 'get_satellite_history' && (!(field.satelliteConsent === true || field.landsatConsent === true) || !field.boundary)) return [];
    try { normalizeGeometry(field); return [`Field ${index + 1}`]; } catch { return []; }
  });
}
function toolPreview(saved) {
  const tools = saved ? Object.keys(DESCRIPTIONS).map(name => ({ name, fields: name === 'get_tasks' ? [] : permittedFields(saved, name) })).filter(tool => tool.name === 'get_tasks' || tool.fields.length) : [];
  return { tools, dataCategories: ['Field aliases; crop and stage categories; due task counts/types', 'Numeric forecast values and timestamps, never field coordinates sent to the AI', 'Previously processed satellite indices and dates, not raw imagery', 'Cached numeric soil/air data and regional drought categories; missing sources are marked unavailable'], mayRefreshWeather: tools.some(tool => tool.name === 'get_weather') };
}
function definitions(saved) {
  return toolPreview(saved).tools.map(tool => ({ type: 'function', name: tool.name, description: DESCRIPTIONS[tool.name], strict: true,
    parameters: { type: 'object', properties: tool.name === 'get_tasks' ? {} : { fieldRef: { type: 'string', enum: tool.fields } }, required: tool.name === 'get_tasks' ? [] : ['fieldRef'], additionalProperties: false } }));
}
function plannerPayload(step, saved) {
  return { model: step.model, store: false, service_tier: 'default', reasoning: { effort: 'low' }, max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: `${INSTRUCTIONS}\nSelect 1 to 4 distinct read-only tool calls for a useful personalized daily message. Prioritize weather and due tasks. Use satellite when available and useful; never assume imagery exists. Use context only when relevant. This is the only tool-selection round: choose all needed calls now. Do not repeat a tool for the same field. Do not write the final answer.`,
    input: JSON.stringify({ evidence: saved.evidence, toolScope: toolPreview(saved) }), tools: definitions(saved), tool_choice: 'required', parallel_tool_calls: true };
}
function validateCalls(data, saved) {
  const available = definitions(saved), calls = [], duplicates = new Set(), callIds = new Set();
  for (const item of data.output) {
    if (item.type === 'reasoning') continue;
    const definition = available.find(tool => tool.name === item.name);
    if (item.type !== 'function_call' || item.status !== 'completed' || !definition || typeof item.arguments !== 'string' || item.arguments.length > 1000 || typeof item.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.call_id) || callIds.has(item.call_id)) throw new HttpError(502, 'The AI selected an invalid tool. No unapproved tool was run.');
    let args; try { args = JSON.parse(item.arguments); } catch { throw new HttpError(502, 'The AI selected invalid tool arguments.'); }
    if (!exactKeys(args, definition.parameters.required) || item.name !== 'get_tasks' && !definition.parameters.properties.fieldRef.enum.includes(args.fieldRef)) throw new HttpError(502, 'The AI selected a field outside your permitted evidence.');
    const key = `${item.name}/${args.fieldRef || ''}`;
    if (duplicates.has(key)) throw new HttpError(502, 'The AI repeated a tool request. No extra requests were made.');
    duplicates.add(key); callIds.add(item.call_id); calls.push({ name: item.name, field: args.fieldRef || null, callId: item.call_id });
  }
  if (!calls.length || calls.length > MAX_TOOL_CALLS) throw new HttpError(502, 'The AI exceeded the bounded tool-selection limit.');
  return calls;
}
function satelliteRecords(data, field, alias, timestamp) {
  const records = [];
  for (const [part, permitted, provider] of [[data, field.satelliteConsent === true, 'sentinel-2'], [data?.landsat, field.landsatConsent === true, 'nasa-usgs-landsat']]) {
    if (!permitted) continue;
    const fetchedAt = iso(part?.fetchedAt), validUntil = iso(part?.validUntil);
    const fresh = ['live','cached'].includes(part?.status) && fetchedAt && timestamp >= Date.parse(fetchedAt) && timestamp - Date.parse(fetchedAt) <= 2 * 86400000 && validUntil && Date.parse(validUntil) > timestamp;
    const history = fresh ? (Array.isArray(part.history) ? part.history : []).filter(item => item.status === 'clear' && iso(item.date) && Date.parse(item.date) <= timestamp && timestamp - Date.parse(item.date) <= 366 * 86400000).slice(-4).map(item => ({ date: iso(item.date), ndvi: number(item.ndvi, -1, 1, 3), ndre: number(item.ndre, -1, 1, 3), clearPercent: number(item.clearPercent, 0, 100), resolutionMeters: provider === 'sentinel-2' ? 20 : 30 })) : [];
    records.push({ type: 'satellite', field: alias, provider, status: fresh && history.length ? 'available' : 'unavailable', source: 'processed-cache', fetchedAt, history,
      comparisonStatus: ['insufficient','detected','stable'].includes(part?.change?.status) ? part.change.status : 'unknown',
      // This tool exposes per-image history, not grid/matched-pixel comparison
      // evidence. Subtracting its means cannot establish a vegetation trend.
      changeComparisonSupported: false, interpretation: 'dated-history-not-a-trend-or-diagnosis' });
  }
  return records;
}
function contextRecords(data, alias, timestamp) {
  const records = [];
  const sources = { soil: 'nrcs-ssurgo', air: 'airnow', water: 'wa-ecology', markets: 'usda-ams', statistics: 'nass' };
  for (const [kind, provider] of Object.entries(sources)) {
    const part = data?.[kind], fetchedAt = iso(part?.fetchedAt), validUntil = iso(part?.validUntil);
    const ready = ['ready','cached'].includes(part?.status) && part.source?.id === provider && fetchedAt && Date.parse(fetchedAt) <= timestamp && validUntil && Date.parse(validUntil) > timestamp;
    const record = { type: kind, field: alias, provider, status: ready ? 'available' : 'unavailable', fetchedAt, validUntil, source: 'context-cache' };
    if (ready && kind === 'soil') record.mappedComponents = (part.data?.mapUnits || []).flatMap(unit => unit.components || []).slice(0, 3).map(component => ({ percent: number(component.percent, 0, 100), slopePercent: number(component.slopePercent, 0, 300), availableWaterCapacityCmPerCm: number(component.topHorizon?.availableWaterCapacityCmPerCm, 0, 1, 3), organicMatterPercent: number(component.topHorizon?.organicMatterPercent, 0, 100) }));
    if (ready && kind === 'air') record.regionalObservations = (part.data?.observations || []).filter(item => ['PM2.5','PM10','O3'].includes(item.pollutant) && iso(item.observedAt) && Date.parse(item.observedAt) <= timestamp && timestamp - Date.parse(item.observedAt) <= 4 * 3600000).slice(0, 3).map(item => ({ pollutant: item.pollutant, aqi: number(item.aqi, 0, 500), observedAt: iso(item.observedAt) }));
    if (ready && kind === 'water') { record.year = number(part.data?.year, 2020, new Date(timestamp).getUTCFullYear(), 0); record.regionalStatuses = [...new Set((part.data?.areas || []).map(item => item.status).filter(status => ['Drought Advisory Area','Drought Emergency Declaration Area'].includes(status)))]; }
    if (ready && ['markets','statistics'].includes(kind)) record.recordCount = Math.min(Array.isArray(part.data?.items) ? part.data.items.length : 0, 100);
    records.push(record);
  }
  return records;
}
function createTools({ getContainer, fetchImpl, now, weatherHandler, satelliteService, farmContextService }) {
  let weather = weatherHandler, satellite = satelliteService, context = farmContextService;
  return async function run(call, saved) {
    const timestamp = now(), field = call.field ? saved.fields[Number(call.field.slice(6)) - 1] : null;
    if (call.name === 'get_tasks') return saved.fields.map((item, i) => taskRecord(saved.state.state, item, `Field ${i + 1}`, timestamp));
    if (!field || !permittedFields(saved, call.name).includes(call.field)) throw new HttpError(409, 'This tool is no longer permitted for the selected field.');
    try {
      if (call.name === 'get_weather') {
        weather ||= require('../weather').createWeatherHandler({ fetchImpl, now });
        const { location } = normalizeGeometry(field), result = {};
        await weather(result, { method: 'GET', query: { lat: String(location.latitude), lon: String(location.longitude) } });
        const data = result.res?.status === 200 ? result.res.body : null;
        const summary = { sourceId: data?.source?.id, fetchedAt: data?.fetchedAt, weatherStatus: data ? data.stale ? 'cached' : 'live' : 'unavailable',
          forecastSamples: (data?.hourly || []).slice(0, 96).map(item => ({ startTime: item.startTime, endTime: item.endTime, temperature: item.temperatureUnit === 'F' ? item.temperature : null, windMph: windMph(item.windSpeed), rainProbability: item.probabilityOfPrecipitation?.value, relativeHumidity: item.relativeHumidity?.value })) };
        return [weatherRecord(summary, call.field, now(), 'weather-tool')];
      }
      if (call.name === 'get_satellite_history') {
        satellite ||= require('./satellite').createSatelliteService({ getContainer, fetchImpl, now });
        return satelliteRecords(await satellite.readCachedSatelliteHistory({ userId: saved.owner, field }), field, call.field, now());
      }
      if (call.name === 'get_farm_context') {
        context ||= require('./farm-context').createFarmContextService({ getContainer, fetchImpl, now });
        return contextRecords(await context.readCachedFarmContext({ userId: saved.owner, field }), call.field, now());
      }
      throw new HttpError(502, 'The AI selected an unavailable tool.');
    } catch (error) {
      if (error instanceof HttpError && [401,403,409].includes(error.status)) throw error;
      return [{ type: 'tool-availability', field: call.field, tool: call.name, status: 'unavailable' }];
    }
  };
}
module.exports = { MAX_TOOL_CALLS, toolPreview, definitions, plannerPayload, validateCalls, createTools, satelliteRecords, contextRecords };
