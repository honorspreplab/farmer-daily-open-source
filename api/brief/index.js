const { getContainer: defaultContainer, readDocument } = require('../shared/store');
const { createAccess, HttpError, dateKey, respond, handleError } = require('../shared/access');
const { createWeatherHandler, validCurrentObservation } = require('../weather');
const { buildFieldBrief, selectRelevantFields } = require('../shared/advisory-engine');
const { enrichFieldBrief, selectIntelligenceFields } = require('../shared/context-advisories');

function text(value, fallback, max = 120) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function buildBrief(profile, locationId, location, weather, timestamp) {
  const date = dateKey(timestamp);
  const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const current = weather.hourly.find(period => Date.parse(period.startTime) <= timestamp && Date.parse(period.endTime) > timestamp);
  if (!current || !Number.isFinite(current.temperature)) throw new HttpError(503, 'Verified local weather is temporarily unavailable. Please retry.');
  const next = weather.daily.find(period => period.isDaytime && dateKey(period.startTime) === tomorrow);
  const today = weather.daily.find(period => period.isDaytime && dateKey(period.startTime) === date && period.temperatureUnit === 'F' && Number.isFinite(period.temperature));
  const observed = weather.source?.id === 'nws' && validCurrentObservation(weather.current, timestamp) ? weather.current : null;
  const crop = text(profile.crops?.[0], 'your crops');
  const priority = text(profile.priorityField, 'your priority field');
  const name = text(profile.firstName, 'Farmer');
  const items = [
    `Hourly forecast estimate near ${location.name}: ${Math.round(current.temperature)}°F, ${text(current.shortForecast, 'conditions unavailable')}.`,
    `Your selected focus: ${priority}, growing ${crop}. Inspect conditions there before deciding on field work.`
  ];
  if (next && Number.isFinite(next.temperature)) items.splice(1, 0, `Tomorrow (${tomorrow}, Pacific): forecast high ${Math.round(next.temperature)}°F, ${text(next.shortForecast, 'conditions unavailable')}.`);
  if (today) items.splice(1, 0, `Today (${date}, Pacific): forecast daytime high ${Math.round(today.temperature)}°F, not a measured maximum.`);
  if (observed) {
    const observedTime = new Date(observed.observedAt).toLocaleString('en-US', {timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
    items.unshift(`Nearby NOAA/NWS observation: ${Math.round(observed.temperature)}°F at ${text(observed.station.name, observed.station.id)} (${observed.station.id}), ${(observed.station.distanceKm / 1.609344).toFixed(1)} mi from ${location.name}, observed ${observedTime}. This is a station reading, not a farm sensor.`);
  }
  if (typeof current.windSpeed === 'string' && current.windSpeed !== 'Unavailable') items.push(`Forecast wind: ${current.windSpeed}${current.windDirection && current.windDirection !== 'Unavailable' ? ` ${current.windDirection}` : ''}.`);
  if (weather.stale) items.push('These are recently saved provider forecasts. Check the displayed update time before weather-sensitive work.');
  return {
    date, createdAt: new Date(timestamp).toISOString(), locationId, location: location.name,
    summary: `${name}, here is your daily brief for ${location.name}. Your saved priority is ${priority} for ${crop}.`,
    items,
    // Legacy serializer retained for migration tests; Phase 1 uses field advisories below.
    weather: {
      source: weather.source, updated: weather.updated || null, fetchedAt: weather.fetchedAt || null,
      stale: Boolean(weather.stale), fallback: Boolean(weather.fallback)
    }
  };
}

// Source waits are bounded separately from the atomic save. Never race a private
// write against a timeout: an abandoned write could save after deletion/retry.
// Everything run through this budget must be read-only with respect to farm data.
function sourceBudget(milliseconds) {
  const until = Date.now() + milliseconds, timedOut = new Set();
  return {
    timedOut,
    async run(kind, operation, unavailable) {
      const remaining = until - Date.now();
      if (remaining <= 0) { timedOut.add(kind); return unavailable; }
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => operation(controller.signal)),
          new Promise(resolve => {
            timer = setTimeout(() => { timedOut.add(kind); controller.abort(); resolve(unavailable); }, remaining);
          })
        ]);
      } finally { clearTimeout(timer); }
    }
  };
}

function createBriefHandler({ getContainer = defaultContainer, now = Date.now, fetchImpl = globalThis.fetch,
  weatherHandler = createWeatherHandler({ fetchImpl, now, nwsTimeoutMs: 5000, backupTimeoutMs: 3000, observationTimeoutMs: 1500 }),
  fieldDataService, farmContextService, satelliteService, sourceTimeoutMs = 10000 } = {}) {
  const access = createAccess({ getContainer, now });
  const inFlight = new Map();
  let service = fieldDataService;
  const sameState = (first, second) => Boolean(first && second && JSON.stringify(first.state) === JSON.stringify(second.state));
  function dataService() {
    if (!service) service = require('../shared/field-data').createFieldDataService({getContainer, now, weatherHandler, fetchImpl});
    return service;
  }
  function contextService(){return farmContextService ||= require('../shared/farm-context').createFarmContextService({getContainer,now,fetchImpl});}
  function imageryService(){return satelliteService ||= require('../shared/satellite').createSatelliteService({getContainer,now,fetchImpl});}
  function result(context, document, date, reused) {
    return respond(context, 200, {
      brief: document?.brief || null, date, reused,
      used: Boolean(document), deleted: Boolean(document?.deleted)
    });
  }
  async function run(context, req, principal) {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const refresh = req.body?.refresh === true;
      const container = getContainer();
      let date = dateKey(now());
      let id = `brief-${principal.id}-${date}`;
      let existing = await readDocument(container, id, principal.id);
      if (req.method === 'GET' || (existing?.brief && !existing.deleted && !refresh)) return result(context, existing, date, true);
      // All plans can refresh their daily snapshot. A short server-side refresh interval
      // and per-owner single flight bound upstream requests without a paid-plan quota.
      if (refresh && existing?.brief && now() - Date.parse(existing.brief.createdAt) >= 0 && now() - Date.parse(existing.brief.createdAt) < 60000) {
        return result(context, existing, date, true);
      }
      if (!inFlight.has(principal.id)) {
        const generation = (async () => {
          const saved = await readDocument(container, `state-${principal.id}`, principal.id);
          const profile = saved?.state?.profile;
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new HttpError(409, 'Save your farm profile before creating a brief');
          const fields = Array.isArray(saved.state.fields) ? saved.state.fields : [];
          const tasks = Array.isArray(saved.state.tasks) ? saved.state.tasks : [];
          const selected = selectRelevantFields(fields, tasks, profile, date);
          const contextFields=selectIntelligenceFields(fields,tasks,profile,'contextConsent');
          const satelliteFields=selectIntelligenceFields(fields,tasks,profile,'satelliteConsent');
          const budget = sourceBudget(Number.isFinite(sourceTimeoutMs) ? Math.max(1, Math.min(sourceTimeoutMs, 10000)) : 10000);
          const readField = field => budget.run('weather', signal => dataService().getFieldData({
            userId:principal.id, field, refresh, cacheOnlyElevation:true, signal
          }), {fieldId:field.id, weather:null, weatherStatus:'unavailable', alerts:{status:'unavailable'}, elevation:{status:'unavailable',feet:null,meters:null}});
          // Slow-changing context/elevation and processed satellite evidence are
          // read from validated caches. Refresh those on their field screens; a
          // brief should not start enrichment writes or reprocess satellite data.
          const [initialFieldData,farmContexts,satelliteContexts]=await Promise.all([
            Promise.all(selected.map(readField)),
            Promise.all(contextFields.map(field=>budget.run('farm-context',()=>contextService().readCachedFarmContext({userId:principal.id,field}).catch(()=>null),null))),
            Promise.all(satelliteFields.map(field=>budget.run('satellite-cache',()=>imageryService().readCachedSatellite({userId:principal.id,field}).catch(()=>null),null)))
          ]);
          let fieldData = initialFieldData;
          let timestamp = now();
          if (dateKey(timestamp) !== date) {
            date = dateKey(timestamp);
            id = `brief-${principal.id}-${date}`;
            existing = await readDocument(container, id, principal.id);
            if (existing?.brief && !existing.deleted && !refresh) return {document:existing, date, reused:true};
            // Midnight can bring additional tasks due. Review the newly selected
            // fields rather than claiming coverage for yesterday's selection.
            const nextSelection = selectRelevantFields(fields, tasks, profile, date);
            fieldData = await Promise.all(nextSelection.map(field => fieldData.find(data => data.fieldId === field.id) || readField(field)));
            timestamp = now();
            if (dateKey(timestamp) !== date) throw new HttpError(409, 'The daily brief date changed. Please retry.');
          }
          const previousDate = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
          const previous = existing?.brief || (await readDocument(container, `brief-${principal.id}-${previousDate}`, principal.id))?.brief || null;
          const generated = enrichFieldBrief(buildFieldBrief({profile, fields, tasks, fieldData, previousBrief:previous, timestamp}),
            {profile,fields,farmContexts,satelliteContexts,contextFields,satelliteFields,previousBrief:previous,timestamp});
          if (contextFields.length) generated.coverage.notices.push(generated.language === 'es'
            ? 'El contexto de la finca usa resultados guardados que siguen vigentes. Abra Datos e inteligencia para actualizar las fuentes que faltan.'
            : 'Farm context uses saved results that are still valid. Open Data & Intelligence to refresh missing sources.');
          if (fieldData.some(data => data.elevation?.status !== 'loaded')) generated.coverage.notices.push(generated.language === 'es'
            ? 'Falta elevación guardada para algunos campos. Abra el campo y actualice sus datos para cargarla; no se han ajustado las temperaturas.'
            : 'Some fields have no current saved elevation. Open the field and refresh its data to load it; temperatures have not been adjusted.');
          if (budget.timedOut.size) {
            generated.coverage.partial = true;
            generated.coverage.timedOutSources = [...budget.timedOut].sort();
            generated.coverage.notices.push(generated.language === 'es'
              ? 'Algunas fuentes tardaron demasiado. Este informe usa solo los datos disponibles; los datos que faltan no indican condiciones seguras. Puede actualizarlo de nuevo.'
              : 'Some sources took too long. This brief uses only the available evidence; missing data are not an all-clear. You can refresh the brief again.');
          }
          const document = {...(existing || {}), id, userId:principal.id, type:'dailyBrief', date, deleted:false, brief:generated};
          // Other field screens can advance the owner-state ETag while we read.
          // Reread it, but do not accept profile/task edits or deletion during tool work.
          const currentState = await readDocument(container, saved.id, principal.id);
          if (!sameState(saved, currentState)) throw new HttpError(409, 'Your farm records changed. Reload Farmer Daily before creating a brief.');
          try {
            // The state ETag and brief share a transaction/partition. Deleting or editing
            // records during a slow fetch prevents stale personal data from being saved.
            const batch = await container.items.batch([
              { operationType: 'Replace', id: currentState.id, resourceBody: currentState, ifMatch: currentState._etag },
              existing
                ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag }
                : { operationType: 'Create', resourceBody: document }
            ], principal.id);
            const failed = batch.result?.find(operation => operation.statusCode >= 400 && operation.statusCode !== 424);
            if (failed || !batch.result || batch.result.some(operation => operation.statusCode >= 400) || (batch.code && batch.code >= 400)) {
              const error = new Error('Daily brief transaction failed');
              error.code = failed?.statusCode || batch.code || 503;
              throw error;
            }
            return {document:{ ...document, brief: batch.result[1]?.resourceBody?.brief || document.brief }, date, reused:false};
          } catch (error) {
            if ([404, 409, 412].includes(Number(error.code))) {
              const afterConflict = await readDocument(container, saved.id, principal.id);
              if (!sameState(saved, afterConflict)) throw new HttpError(409, 'Your farm records changed. Reload Farmer Daily before creating a brief.');
              const winner = await readDocument(container, id, principal.id);
              if (winner) return {document:winner, date, reused:true};
              throw new HttpError(409, 'Your saved profile changed. Reload Farmer Daily before creating a brief.');
            }
            throw error;
          }
        })().finally(() => inFlight.delete(principal.id));
        inFlight.set(principal.id, generation);
      }
      const generated = await inFlight.get(principal.id);
      return result(context, generated.document, generated.date, generated.reused);
    } catch (error) { handleError(context, error); }
  }
  const handler = async (context, req) => {
    try {
      const { principal } = await access.requireAccess(req);
      return await run(context, req, principal);
    } catch (error) { handleError(context, error); }
  };
  // Server-only entry point for the authenticated scheduler. It never takes an
  // identity from the scheduler request or manufactures an Azure identity header.
  handler.forOwner = async owner => {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new HttpError(400, 'Invalid brief owner');
    const account = await readDocument(getContainer(), `account-${owner}`, owner);
    if (!account || account.identityProvider !== 'aad') throw new HttpError(409, 'Account is unavailable');
    const context = {};
    await run(context, { method: 'POST', body: {} }, { id: owner });
    if (context.res?.status !== 200) throw new HttpError(context.res?.status || 503, 'The daily brief could not be prepared');
    return context.res.body.brief;
  };
  return handler;
}

module.exports = createBriefHandler();
module.exports.createBriefHandler = createBriefHandler;
module.exports.buildBrief = buildBrief;
