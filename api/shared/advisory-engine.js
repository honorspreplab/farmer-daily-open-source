// Deterministic Phase 1 rules. No farm records are sent to a language-model service.
const { dateKey } = require('./access');
const HOUR = 3600000;
const MAX_FIELDS = 5;
const FRESH_MS = 6 * HOUR;
const ALERT_FRESH_MS = 2 * 60000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clean = (value, fallback = '', max = 160) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
function located(field) {
  return field?.dataConsent === true && finite(field.location?.latitude) && finite(field.location?.longitude) &&
    field.location.latitude >= 45.5 && field.location.latitude <= 49.1 && field.location.longitude >= -125 && field.location.longitude <= -116.7;
}
function fieldTasks(tasks, field) {
  return tasks.filter(task => !task.done && (task.fieldId === field.id || (!task.fieldId && clean(task.place).toLowerCase() === clean(field.name).toLowerCase())));
}
function selectRelevantFields(fields = [], tasks = [], profile = {}, date, limit = MAX_FIELDS) {
  return fields.filter(located).map((field, order) => ({field, order, score:
    (field.id === profile.priorityField || clean(field.name).toLowerCase() === clean(profile.priorityField).toLowerCase() ? 100 : 0) +
    (fieldTasks(tasks, field).some(task => validDate(task.date) && task.date <= date) ? 50 : 0)
  })).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(item => item.field);
}
function windMph(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?)(?:\s*(?:to|-)\s*\d+(?:\.\d+)?)?\s*mph$/i.test(value.trim())) return null;
  const values = value.match(/\d+(?:\.\d+)?/g).map(Number);
  return values.every(item => item >= 0 && item <= 250) ? Math.max(...values) : null;
}
function publicSource(source, fetchedAt) {
  if (!source || !iso(fetchedAt)) return null;
  try {
    const url = new URL(source.publicUrl || source.url);
    const hosts = new Set(['api.weather.gov', 'forecast.weather.gov', 'www.weather.gov', 'weather.gov', 'open-meteo.com', 'api.open-meteo.com', 'epqs.nationalmap.gov', 'www.usgs.gov', 'apps.nationalmap.gov']);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) return null;
    const result = {name: clean(source.name, 'Data source'), url: url.href, fetchedAt};
    if (source.id === 'open-meteo') {
      result.licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';
      result.attribution = 'Weather data by Open-Meteo, CC BY 4.0. Forecast values are summarized for Farmer Daily.';
    }
    return result;
  } catch { return null; }
}
function fresh(value, now, maxAge = FRESH_MS) { return iso(value) && now - Date.parse(value) >= -60000 && now - Date.parse(value) < maxAge; }
function buildFieldBrief({profile = {}, fields = [], tasks = [], fieldData = [], previousBrief = null, timestamp = Date.now()} = {}) {
  const date = dateKey(timestamp), createdAt = new Date(timestamp).toISOString();
  const spanish = /^(es(?:-|$)|spanish|español)/i.test(profile.language || '');
  const tr = (en, es) => spanish ? es : en;
  const time = value => new Date(value).toLocaleString(spanish ? 'es-US' : 'en-US', {timeZone:'America/Los_Angeles', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short'});
  const selected = selectRelevantFields(fields, tasks, profile, date);
  const dataById = new Map(fieldData.map(data => [data.fieldId, data]));
  const notices = [], candidates = [], summaries = [];
  let weatherAvailable = 0, alertsAvailable = 0;
  const rawThreshold = typeof profile.wind === 'string' && profile.wind.trim() ? Number(profile.wind) : profile.wind;
  const customThreshold = finite(rawThreshold) && rawThreshold >= 1 && rawThreshold <= 100;
  const threshold = customThreshold ? rawThreshold : 15;
  function add(field, kind, score, details) {
    candidates.push({id:`${field?.id || 'farm'}-${kind}`, fieldId:field?.id || null, fieldName:clean(field?.name, clean(profile.farmName, tr('Your farm', 'Su finca'))),
      kind, priority:score >= 80 ? 'high' : score >= 40 ? 'medium' : 'low', confidence:'low',
      validUntil:new Date(timestamp + HOUR).toISOString(), sources:[], followUp:tr('Why am I seeing this?', '¿Por qué veo esto?'),
      ...details, _score:score});
  }
  for (const field of selected) {
    const data = dataById.get(field.id) || {}, weather = data.weather;
    const knownProvider = ['nws', 'open-meteo'].includes(weather?.source?.id);
    const available = knownProvider && fresh(weather?.fetchedAt, timestamp) && Array.isArray(weather?.hourly);
    const samples = available ? weather.hourly.filter(period => iso(period.startTime) && iso(period.endTime) &&
      Date.parse(period.startTime) < timestamp + 24 * HOUR && Date.parse(period.endTime) > timestamp && Date.parse(period.endTime) > Date.parse(period.startTime) &&
      Date.parse(period.endTime) - Date.parse(period.startTime) <= 2 * HOUR && period.temperatureUnit === 'F' && finite(period.temperature) && period.temperature >= -130 && period.temperature <= 140)
      .map(period => ({startTime:new Date(period.startTime).toISOString(), endTime:new Date(period.endTime).toISOString(), temperature:period.temperature,
        windMph:windMph(period.windSpeed), rainProbability:finite(period.probabilityOfPrecipitation?.value) && period.probabilityOfPrecipitation.value >= 0 && period.probabilityOfPrecipitation.value <= 100 ? period.probabilityOfPrecipitation.value : null,
        relativeHumidity:finite(period.relativeHumidity?.value) && period.relativeHumidity.value >= 0 && period.relativeHumidity.value <= 100 ? period.relativeHumidity.value : null})).slice(0, 48) : [];
    const hasCurrentCoverage = samples.some(sample => Date.parse(sample.startTime) <= timestamp && Date.parse(sample.endTime) > timestamp);
    const usable = samples.length > 0 && hasCurrentCoverage;
    const isLiveNws = usable && weather.source.id === 'nws' && !weather.stale && data.weatherStatus !== 'cached';
    const source = usable ? publicSource(weather.source, weather.fetchedAt) : null;
    const sources = source ? [source] : [];
    const prior = previousBrief?.fieldSummaries?.find(item => item.fieldId === field.id && item.locationKey === data.locationKey && data.locationKey && item.sourceId === weather?.source?.id);
    const previousSample = (sample, key) => prior?.forecastSamples?.find(item => item.startTime === sample.startTime && item.endTime === sample.endTime && finite(item[key]));
    const changed = (sample, key, unit) => {
      const old = previousSample(sample, key), current = Math.round(sample[key]);
      if (!old) return tr(`First recorded forecast for ${time(sample.startTime)}: ${current}${unit}.`, `Primer pronóstico registrado para ${time(sample.startTime)}: ${current}${unit}.`);
      if (Math.round(old[key]) === current) return tr(`The forecast for ${time(sample.startTime)} remains ${current}${unit} since the previous brief.`, `El pronóstico para ${time(sample.startTime)} sigue en ${current}${unit} desde el informe anterior.`);
      return tr(`The forecast for ${time(sample.startTime)} changed from ${Math.round(old[key])}${unit} to ${current}${unit} since the previous brief for that same hour.`, `El pronóstico para ${time(sample.startTime)} cambió de ${Math.round(old[key])}${unit} a ${current}${unit} desde el informe anterior para esa misma hora.`);
    };
    const confidence = isLiveNws && source ? 'medium' : 'low';
    const until = sample => new Date(Math.min(timestamp + 6 * HOUR, Date.parse(weather.fetchedAt) + FRESH_MS, Date.parse(sample.endTime))).toISOString();
    const openTasks = fieldTasks(tasks, field).filter(task => validDate(task.date) && task.date <= date);
    const crop = clean(field.crop, tr('your crop', 'su cultivo'));
    const alertFresh = fresh(data.alerts?.fetchedAt, timestamp, ALERT_FRESH_MS) && ['live','cached'].includes(data.alerts?.status);
    if (alertFresh) alertsAvailable += 1;
    else notices.push(tr(`Weather alerts are unavailable for ${field.name}; this is not an all-clear.`, `No están disponibles las alertas meteorológicas para ${field.name}; esto no indica ausencia de peligro.`));
    const activeAlerts = alertFresh && Array.isArray(data.alerts.items) ? data.alerts.items.filter(alert => iso(alert.expires) && Date.parse(alert.expires) > timestamp &&
      iso(alert.effective) && Date.parse(alert.effective) <= timestamp && Date.parse(alert.expires) > Date.parse(alert.effective) &&
      (alert.sent == null || (iso(alert.sent) && Date.parse(alert.sent) <= timestamp + 60000))) : [];
    for (const [index, alert] of activeAlerts.slice(0, 3).entries()) {
      const alertSource = publicSource({name:'NOAA / National Weather Service', url:alert.url}, data.alerts.fetchedAt);
      if (!alertSource) continue;
      add(field, `alert-${index}`, ['Extreme','Severe'].includes(alert.severity) ? 100 : 90, {
        title:clean(alert.event, tr('Official weather alert', 'Alerta meteorológica oficial')),
        whatChanged:clean(alert.headline, tr('An official NWS alert is active at this field location.', 'Una alerta oficial de NWS está activa en la ubicación de este campo.'), 500),
        whyItMatters:tr('An official alert can affect work at this field. Read the original notice for its area, timing, and instructions.', 'Una alerta oficial puede afectar el trabajo en este campo. Lea el aviso original para conocer el área, el horario y las instrucciones.'),
        suggestedAction:tr('Open the NWS alert and follow official instructions before continuing weather-sensitive work.', 'Abra la alerta de NWS y siga las instrucciones oficiales antes de continuar trabajos sensibles al tiempo.'),
        confidence:data.alerts.status === 'live' ? 'high' : 'low', validUntil:new Date(Math.min(Date.parse(alert.expires), Date.parse(data.alerts.fetchedAt) + ALERT_FRESH_MS)).toISOString(), sources:[alertSource],
        followUp:tr('What does the official alert say?', '¿Qué dice la alerta oficial?'), sourceLanguage:'en', alertId:clean(alert.id, '', 300)
      });
    }
    summaries.push({fieldId:field.id, fieldName:clean(field.name), locationKey:data.locationKey || null,
      weatherStatus:usable ? (weather.stale || data.weatherStatus === 'cached' ? 'cached' : 'live') : 'unavailable', alertsStatus:alertFresh ? data.alerts.status : 'unavailable',
      elevation:data.elevation || {status:'unavailable', feet:null, meters:null}, sourceId:usable ? weather.source.id : null,
      fetchedAt:usable ? weather.fetchedAt : null, source:source || null, forecastSamples:usable ? samples : []});
    if (!usable) {
      notices.push(tr(`Field weather is unavailable for ${field.name}; no weather recommendation was inferred.`, `No está disponible el tiempo para ${field.name}; no se infirió ninguna recomendación meteorológica.`));
      add(field, 'unavailable', 45, {title:tr('Field weather unavailable', 'Tiempo del campo no disponible'),
        whatChanged:tr('A current, usable field forecast could not be retrieved.', 'No se pudo obtener un pronóstico actual y utilizable para el campo.'),
        whyItMatters:tr('Missing data are not evidence of favorable conditions.', 'La falta de datos no demuestra condiciones favorables.'),
        suggestedAction:tr('Retry the field data and check an official local forecast before weather-sensitive work.', 'Actualice los datos del campo y consulte un pronóstico local oficial antes de realizar trabajos sensibles al tiempo.')});
      continue;
    }
    weatherAvailable += 1;
    if (!isLiveNws) notices.push(tr(`${field.name} uses ${weather.source.id === 'nws' ? 'cached NWS' : 'backup Open-Meteo'} weather; confidence is reduced.`, `${field.name} utiliza datos ${weather.source.id === 'nws' ? 'guardados de NWS' : 'de respaldo de Open-Meteo'}; la confianza es menor.`));
    if (samples.some(sample => sample.windMph === null || sample.rainProbability === null || sample.relativeHumidity === null)) notices.push(tr(`Some wind, rain, or humidity values are unknown for ${field.name}.`, `Se desconocen algunos valores de viento, lluvia o humedad para ${field.name}.`));
    const cold = samples.reduce((a, b) => b.temperature < a.temperature ? b : a);
    if (cold.temperature <= 32) add(field, 'freeze', 85, {title:tr('Freezing-temperature forecast', 'Pronóstico de temperaturas bajo cero'),
      whatChanged:changed(cold, 'temperature', '°F'),
      whyItMatters:tr(`Forecast air temperatures at or below freezing may affect field work and ${crop}. Crop damage cannot be inferred without crop stage and local measurements.`, `Las temperaturas previstas de congelación pueden afectar el trabajo y ${crop}. No se puede inferir daño al cultivo sin su etapa y mediciones locales.`),
      suggestedAction:tr('Review this field and your existing frost-protection plan; verify local conditions with a thermometer or advisor.', 'Revise este campo y su plan actual contra heladas; verifique las condiciones locales con un termómetro o asesor.'),
      confidence, sources, validUntil:until(cold), followUp:tr('Which forecast hour is coldest?', '¿Qué hora del pronóstico es la más fría?')});
    const winds = samples.filter(sample => sample.windMph !== null), windy = winds.length ? winds.reduce((a, b) => b.windMph > a.windMph ? b : a) : null;
    if (windy && windy.windMph > threshold) add(field, 'wind', 70, {title:tr('Wind exceeds your planning threshold', 'El viento supera el umbral de planificación'),
      whatChanged:changed(windy, 'windMph', ' mph'),
      whyItMatters:tr(`This exceeds the ${customThreshold ? 'saved' : 'default'} ${threshold} mph planning threshold${openTasks.length ? ` and you have ${openTasks.length} open task(s) due here` : ''}. This is not a legal or equipment safety limit.`, `Supera el umbral de planificación ${customThreshold ? 'guardado' : 'predeterminado'} de ${threshold} mph${openTasks.length ? ` y tiene ${openTasks.length} tarea(s) pendiente(s) aquí` : ''}. No es un límite legal ni de seguridad de equipos.`),
      suggestedAction:tr('Review the timing of exposed work. Follow equipment instructions and product labels; a low-wind forecast is not permission to spray.', 'Revise el horario del trabajo expuesto. Siga las instrucciones de los equipos y etiquetas; un pronóstico de poco viento no autoriza fumigar.'),
      confidence, sources, validUntil:until(windy), followUp:tr('Why was this wind threshold used?', '¿Por qué se utilizó este umbral de viento?')});
    const rainSamples = samples.filter(sample => sample.rainProbability !== null && dateKey(sample.startTime) === date), wet = rainSamples.length ? rainSamples.reduce((a, b) => b.rainProbability > a.rainProbability ? b : a) : null;
    if (wet && wet.rainProbability >= 50 && openTasks.length) add(field, 'rain', 60, {title:tr('Rain may affect saved field tasks', 'La lluvia puede afectar las tareas guardadas'),
      whatChanged:changed(wet, 'rainProbability', '%'),
      whyItMatters:tr(`${openTasks.length} task(s) are open for this field today or earlier. Rain probability does not measure rainfall amount or soil trafficability.`, `Hay ${openTasks.length} tarea(s) pendiente(s) en este campo para hoy o antes. La probabilidad de lluvia no mide la cantidad de lluvia ni el acceso al suelo.`),
      suggestedAction:tr('Check the forecast timing against your tasks and inspect actual field access before moving machinery.', 'Compare el horario del pronóstico con sus tareas e inspeccione el acceso real antes de mover maquinaria.'),
      confidence, sources, validUntil:until(wet), followUp:tr('Which saved tasks could be affected?', '¿Qué tareas guardadas podrían verse afectadas?'), taskIds:openTasks.slice(0, 20).map(task => task.id)});
    add(field, 'conditions', 10, {title:tr('Review your field forecast', 'Revise el pronóstico de su campo'),
      whatChanged:tr(`The reviewed hours range from ${Math.round(cold.temperature)}°F to ${Math.round(Math.max(...samples.map(sample => sample.temperature)))}°F. This is a forecast, not a measured field temperature.`, `Las horas revisadas van de ${Math.round(cold.temperature)}°F a ${Math.round(Math.max(...samples.map(sample => sample.temperature)))}°F. Es un pronóstico, no una temperatura medida en el campo.`),
      whyItMatters:tr(`These are location-specific planning conditions for ${crop}; microclimates can differ from the forecast grid.`, `Estas son condiciones de planificación para ${crop} según su ubicación; el microclima puede diferir de la cuadrícula del pronóstico.`),
      suggestedAction:tr('Check conditions at the field before working. Elevation is context only and has not been used to adjust temperatures.', 'Verifique las condiciones del campo antes de trabajar. La elevación solo es contexto y no se utilizó para ajustar temperaturas.'),
      confidence, sources, validUntil:until(samples[0])});
  }
  const openDue = tasks.filter(task => !task.done && validDate(task.date) && task.date <= date).sort((a,b) => a.date.localeCompare(b.date));
  for (const task of openDue.slice(0, 3)) {
    const field = fields.find(item => item.id === task.fieldId || (!task.fieldId && clean(task.place).toLowerCase() === clean(item.name).toLowerCase()));
    add(field, `task-${task.id}`, task.date < date ? 55 : 50, {title:tr(task.date < date ? 'Overdue farm task' : 'Task due today', task.date < date ? 'Tarea de la finca atrasada' : 'Tarea para hoy'),
      whatChanged:tr(`“${clean(task.name, 'Farm task')}” remains open with a due date of ${task.date} (Pacific).`, `«${clean(task.name, 'Tarea de la finca')}» sigue pendiente con fecha ${task.date} (hora del Pacífico).`),
      whyItMatters:tr('This priority comes from your saved task list, not an inferred field condition.', 'Esta prioridad proviene de sus tareas guardadas, no de una condición inferida del campo.'),
      suggestedAction:tr('Review the task, update its schedule, or mark it complete only if the work has been done.', 'Revise la tarea, actualice su horario o márquela completa solo si ya se realizó.'),
      confidence:'high', taskIds:[task.id], followUp:tr('Show me this task.', 'Muéstreme esta tarea.')});
  }
  const locatedCount = fields.filter(located).length, missing = fields.length - locatedCount;
  if (!fields.length || missing) add(null, 'setup', 40, {title:tr('Complete your field setup', 'Complete la configuración de sus campos'),
    whatChanged:tr(!fields.length ? 'No fields have been saved yet.' : `${missing} field(s) need a Washington location and permission to query public data.`, !fields.length ? 'Todavía no hay campos guardados.' : `${missing} campo(s) necesitan una ubicación en Washington y permiso para consultar datos públicos.`),
    whyItMatters:tr('Field weather depends on the field location; a community forecast is not a substitute for it.', 'El tiempo del campo depende de su ubicación; un pronóstico de la comunidad no lo sustituye.'),
    suggestedAction:tr('Add or edit a field, enter its crop and location, and choose whether to allow public weather/elevation lookups.', 'Añada o edite un campo, ingrese su cultivo y ubicación, y elija si permite consultas públicas del tiempo y elevación.')});
  if (missing) notices.push(tr(`${missing} field(s) were not checked because a location or data permission is missing.`, `No se revisaron ${missing} campo(s) porque falta su ubicación o permiso de datos.`));
  if (locatedCount > selected.length) notices.push(tr(`Partial coverage: ${selected.length} of ${locatedCount} located fields were reviewed, prioritized by saved priority and due tasks. Other fields have not been checked for weather or alerts.`, `Cobertura parcial: se revisaron ${selected.length} de ${locatedCount} campos ubicados, según la prioridad guardada y las tareas pendientes. No se revisaron el tiempo ni las alertas de los demás campos.`));
  const ranked = candidates.sort((a,b) => b._score - a._score);
  const important = ranked.filter(item => item.kind !== 'conditions');
  const normal = ranked.filter(item => item.kind === 'conditions' && !important.some(other => other.fieldId === item.fieldId));
  const advisories = [...important, ...normal].slice(0,3).map(({_score,...item}) => item);
  return {schemaVersion:2, engine:'phase1-rules', date, createdAt, language:spanish ? 'es' : 'en',
    summary:tr(`${clean(profile.firstName,'Farmer')}, ${advisories.length} ${advisories.length === 1 ? 'priority' : 'priorities'} to review for ${clean(profile.farmName,'your farm')}.`, `${clean(profile.firstName,'Agricultor')}, ${advisories.length} ${advisories.length === 1 ? 'prioridad' : 'prioridades'} para revisar en ${clean(profile.farmName,'su finca')}.`),
    items:advisories.map(item => `${item.fieldName} — ${item.title}: ${item.whatChanged}`), advisories, fieldSummaries:summaries,
    coverage:{totalFields:fields.length, locatedFields:locatedCount, reviewedFields:selected.length, weatherAvailableFields:weatherAvailable,
      alertsAvailableFields:alertsAvailable, partial:missing > 0 || selected.length < locatedCount || weatherAvailable < selected.length || alertsAvailable < selected.length,
      reviewedFieldIds:selected.map(field => field.id), unreviewedFieldIds:fields.filter(field => !selected.some(item => item.id === field.id)).map(field => field.id), notices},
    explanation:tr('These priorities use weather and task records, not an AI diagnosis. This brief includes no soil, satellite or market data. Open Data & Intelligence to review those field connections. Sensors and equipment are not connected.', 'Estas prioridades usan registros del tiempo y las tareas, no un diagnóstico de IA. Este resumen no incluye datos de suelo, satélites ni mercados. Abra Datos e inteligencia para revisar esas conexiones de su parcela. Los sensores y equipos no están conectados.')};
}

module.exports = {buildFieldBrief, selectRelevantFields, windMph, located, MAX_FIELDS};
