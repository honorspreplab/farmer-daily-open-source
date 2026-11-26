'use strict';
// Only enumerated categories, bounded numbers and canonical dates cross the LLM boundary.
// In particular, never copy saved brief prose, names, locations, URLs or task notes.
const { createHash, timingSafeEqual } = require('node:crypto');
const { HttpError, dateKey } = require('./access');
const { readDocument } = require('./store');
const VERSION = 'ai-evidence-v1';
const MAX_FIELDS = 5;
const CROPS = new Set(['apple','apples','pear','pears','cherry','cherries','wheat','potato','potatoes','corn','grape','grapes','blueberry','blueberries','raspberry','raspberries','hay','alfalfa','vegetables','cattle','other']);
const STAGES = new Set(['dormant','planting','seedling','vegetative','bloom','flowering','fruit development','fruit set','ripening','harvest','post-harvest','unknown']);
const WORK = new Set(['scouting','inspection','irrigation','harvest','planting','maintenance','spraying','other']);
const LEVELS = new Set(['low','medium','high']);
function number(value, min, max, places = 2) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Number(value.toFixed(places)) : null;
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function category(value, choices, fallback = 'unknown') {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return choices.has(normalized) ? normalized : fallback;
}
function kind(value) {
  if (typeof value !== 'string') return 'other';
  if (/^alert-\d+$/.test(value)) return 'weather-alert';
  if (/^task-/.test(value)) return 'task';
  return ['freeze','wind','rain','conditions','unavailable','setup','air-awareness','regional-drought','market-report','soil-context','satellite-scout'].includes(value) ? value : 'other';
}
function selectedFields(state, brief) {
  const fields = Array.isArray(state?.fields) ? state.fields : [];
  const ids = [...(brief?.advisories || []).map(item => item.fieldId), ...(brief?.fieldSummaries || []).map(item => item.fieldId), ...fields.map(item => item.id)];
  return [...new Set(ids)].map(id => fields.find(field => typeof field?.id === 'string' && field.id === id)).filter(Boolean).slice(0, MAX_FIELDS);
}
function weatherRecord(summary, field, timestamp, source = 'saved-brief') {
  const samples = (Array.isArray(summary?.forecastSamples) ? summary.forecastSamples : []).filter(sample => {
    const start = Date.parse(sample.startTime), end = Date.parse(sample.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > timestamp && start < timestamp + 86400000 && end > start;
  }).slice(0, 24).map(sample => ({ start: iso(sample.startTime), end: iso(sample.endTime), temperatureF: number(sample.temperature, -100, 150), windMph: number(sample.windMph, 0, 250), rainProbabilityPercent: number(sample.rainProbability, 0, 100), humidityPercent: number(sample.relativeHumidity, 0, 100) }));
  const fetchedAt = iso(summary?.fetchedAt);
  const usable = ['nws','open-meteo'].includes(summary?.sourceId) && ['live','cached'].includes(summary?.weatherStatus) && fetchedAt && timestamp >= Date.parse(fetchedAt) && timestamp - Date.parse(fetchedAt) <= 6 * 3600000;
  const extrema = (key, fn) => { const values = samples.map(item => item[key]).filter(value => value !== null); return values.length ? fn(...values) : null; };
  return { type: 'weather', field, source, provider: ['nws','open-meteo'].includes(summary?.sourceId) ? summary.sourceId : 'unknown', fetchedAt,
    status: usable && samples.length ? 'available' : 'unavailable', retrieval: summary?.weatherStatus === 'cached' ? 'cached' : 'live',
    next24Hours: usable ? { forecastHours: samples.length, lowF: extrema('temperatureF', Math.min), highF: extrema('temperatureF', Math.max), maxWindMph: extrema('windMph', Math.max), maxRainProbabilityPercent: extrema('rainProbabilityPercent', Math.max) } : null,
    samples: usable ? samples.filter((_, index) => index % 6 === 0) : [] };
}
function taskRecord(state, field, alias, timestamp) {
  const day = dateKey(timestamp);
  const tasks = (Array.isArray(state?.tasks) ? state.tasks : []).filter(task => task?.fieldId === field.id && !task.done && task.status !== 'completed' && typeof task.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.date) && task.date <= day);
  const counts = {};
  for (const task of tasks.slice(0, 100)) { const work = category(task.workType, WORK, 'other'); counts[work] = (counts[work] || 0) + 1; }
  return { type: 'tasks', field: alias, date: day, dueCount: Math.min(tasks.length, 100), kinds: counts };
}
function makeEvidence(state, brief, timestamp) {
  const fields = selectedFields(state, brief), records = [];
  const aliases = new Map(fields.map((field, index) => [field.id, `Field ${index + 1}`]));
  for (const field of fields) {
    const alias = aliases.get(field.id);
    records.push({ type: 'field', field: alias, crop: category(field.crop, CROPS), stage: category(field.stage, STAGES) });
    records.push(taskRecord(state, field, alias, timestamp));
    const summary = (brief.fieldSummaries || []).find(item => item.fieldId === field.id);
    if (field.dataConsent === true && summary) {
      records.push(weatherRecord(summary, alias, timestamp));
      // A cached brief is not a current alert feed, including when it recorded none.
      records.push({ type: 'alert-coverage', field: alias, source: 'saved-brief', recordedAt: iso(brief.createdAt),
        recordedStatus: ['live','cached'].includes(summary.alertsStatus) ? 'available-when-brief-created' : 'unavailable',
        status: 'not-refreshed-by-ai', currentAllClearEstablished: false });
    }
  }
  for (const advisory of (Array.isArray(brief.advisories) ? brief.advisories : []).slice(0, 3)) {
    const field = fields.find(item => item.id === advisory.fieldId);
    if (!field) continue;
    const category = kind(advisory.kind);
    if (['weather-alert','freeze','wind','rain','conditions'].includes(category) && field.dataConsent !== true) continue;
    if (['air-awareness','regional-drought','market-report','soil-context'].includes(category) && field.contextConsent !== true) continue;
    if (category === 'satellite-scout' && field.satelliteConsent !== true && field.landsatConsent !== true) continue;
    const validUntil = iso(advisory.validUntil);
    records.push({ type: 'priority', field: aliases.get(field.id), category,
      priority: categoryLevel(advisory.priority), confidence: categoryLevel(advisory.confidence), validUntil,
      status: validUntil && Date.parse(validUntil) > timestamp ? 'current-at-preview' : 'expired', source: 'saved-rule-brief' });
  }
  const totalFields = Array.isArray(state.fields) ? state.fields.length : 0;
  records.push({ type: 'coverage', totalSavedFields: Math.min(totalFields, 1000), includedFields: fields.length,
    omittedFields: Math.max(0, Math.min(totalFields, 1000) - fields.length), allFieldsReviewed: totalFields === fields.length,
    originalBriefPartial: brief.coverage?.partial === true });
  return { fields, evidence: { version: VERSION, asOf: iso(brief.createdAt), language: brief.language === 'es' ? 'es' : 'en', records: records.map((record, i) => ({ id: `E${i + 1}`, ...record })) } };
}
function categoryLevel(value) { return LEVELS.has(value) ? value : 'low'; }
function accountFingerprint(account) {
  // Account polling updates lastSeenAt/ETag every minute. Only semantic identity
  // or entitlement changes invalidate consent, not an unrelated heartbeat.
  return JSON.stringify([account.id, account.userId, account.email, account.identityProvider, account.plan, account.request || null]);
}
function token(snapshot) {
  return createHash('sha256').update(JSON.stringify([VERSION, snapshot.owner, accountFingerprint(snapshot.account), snapshot.state._etag, snapshot.brief._etag, snapshot.evidence])).digest('hex');
}
function tokenMatches(supplied, expected) {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}
async function snapshot(container, owner, timestamp) {
  const [account, state, brief] = await Promise.all([
    readDocument(container, `account-${owner}`, owner), readDocument(container, `state-${owner}`, owner),
    readDocument(container, `brief-${owner}-${dateKey(timestamp)}`, owner)
  ]);
  if (!account || account.identityProvider !== 'aad' || !account._etag || !state?._etag || !state.state?.profile || !brief?._etag || brief.deleted || !brief.brief) return null;
  const created = Date.parse(brief.brief.createdAt);
  if (!Number.isFinite(created) || created > timestamp || timestamp - created > 24 * 3600000 || !['phase1-rules','phase123-rules'].includes(brief.brief.engine)) return null;
  const packet = makeEvidence(state.state, brief.brief, timestamp);
  if (!packet.fields.length) return null;
  return { owner, account, state, brief, ...packet };
}
async function assertCurrent(container, previous, timestamp) {
  const current = await snapshot(container, previous.owner, timestamp);
  if (!current || accountFingerprint(current.account) !== accountFingerprint(previous.account) || current.state._etag !== previous.state._etag || current.brief._etag !== previous.brief._etag) {
    throw new HttpError(409, 'Your account or farm records changed. Reload the AI preview before continuing.');
  }
  return current;
}
module.exports = { VERSION, number, iso, category, weatherRecord, taskRecord, snapshot, assertCurrent, token, tokenMatches, makeEvidence };
