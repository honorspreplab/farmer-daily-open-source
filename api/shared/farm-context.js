const { createHash } = require('node:crypto');
const { getContainer: defaultContainer, readDocument } = require('./store');
const { HttpError } = require('./access');
const { normalizeGeometry, locationKey } = require('./field-geometry');
const { createContextProviders, SOURCES, TTL, outcome } = require('./context-providers');
const KINDS = Object.keys(SOURCES);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const farmContextId = (userId, fieldId) => `farm-context-${digest([userId, fieldId])}`;
const currentField = (document, fieldId) => document?.state?.fields?.find(field => field.id === fieldId);
const sameField = (field, expected) => field?.contextConsent === true && JSON.stringify(field) === JSON.stringify(expected);
const contextKey = field => digest([locationKey(field), field.crop, field.marketReportId || '', field.marketLabel || '']);
const STATUSES = new Set(['ready', 'cached', 'unavailable', 'needs_configuration', 'not_selected', 'no_data']);

async function documents(container, userId) {
  const { resources } = await container.items.query({ query: 'SELECT * FROM c WHERE c.userId = @userId AND c.type = @type',
    parameters: [{ name: '@userId', value: userId }, { name: '@type', value: 'farmContext' }] }, { partitionKey: userId }).fetchAll();
  return resources || [];
}
function belongs(document, userId, fields) {
  const field = fields?.find(item => item.id === document.fieldId);
  try { return document.userId === userId && field?.contextConsent === true && document.locationKey === locationKey(field) && document.contextKey === contextKey(field); }
  catch { return false; }
}
async function exportFarmContexts(container, userId, fields, now = Date.now()) {
  return (await documents(container, userId)).filter(document => belongs(document, userId, fields)).map(document => ({
    fieldId: document.fieldId, locationKey: document.locationKey, fetchedAt: document.fetchedAt,
    // Export is an owner's historical record, not a live advisory response.
    // Preserve recorded derived values, clearly flagging expiration for callers.
    ...Object.fromEntries(KINDS.map(kind => [kind, document[kind] ? { ...document[kind], source: SOURCES[kind], expired: !freshPart(document[kind], kind, now), historicalRecord: true } : null]))
  }));
}
async function pruneFarmContexts(container, userId, fields = []) {
  for (const document of await documents(container, userId)) {
    if (belongs(document, userId, fields)) continue;
    try { await container.item(document.id, userId).delete(document._etag ? { accessCondition: { type: 'IfMatch', condition: document._etag } } : undefined); }
    catch (error) { if (![404, 412].includes(Number(error.code))) throw error; }
  }
}
function freshPart(part, kind, timestamp) {
  const fetched = Date.parse(part?.fetchedAt), until = Date.parse(part?.validUntil);
  return Boolean(part && STATUSES.has(part.status) && Number.isFinite(fetched) && Number.isFinite(until) && fetched <= timestamp && until > timestamp &&
    until > fetched && until - fetched <= (['ready','cached'].includes(part.status) ? TTL[kind] : 5 * 60000) + 1000 &&
    (['ready','cached'].includes(part.status) ? part.data && typeof part.data === 'object' && !Array.isArray(part.data) : true));
}
function batchError(batch) {
  const failure = batch?.result?.find(item => item.statusCode >= 400 && item.statusCode !== 424);
  if (!batch?.result || failure || batch.result.some(item => item.statusCode >= 400) || batch.code >= 400) {
    throw Object.assign(new Error('Context transaction failed'), { code: failure?.statusCode || batch?.code || 503 });
  }
}
function createFarmContextService({ getContainer = defaultContainer, fetchImpl = globalThis.fetch, now = Date.now, env = process.env, timeoutMs = 6000,
  providers = createContextProviders({ fetchImpl, now, env, timeoutMs }) } = {}) {
  const inFlight = new Map(), ownerBudgets = new Map();
  async function checkedField(userId, expected) {
    if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !expected?.id) throw new HttpError(404, 'Field not found');
    const state = await readDocument(getContainer(), `state-${userId}`, userId), stored = currentField(state, expected.id);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(expected)) throw new HttpError(409, 'This field changed. Reload before requesting farm context.');
    if (stored.contextConsent !== true) throw new HttpError(409, 'Enable Farm Context sharing for this field first. Weather sharing does not enable these additional sources.');
    try { normalizeGeometry(stored); } catch { throw new HttpError(409, 'Save a valid field location first.'); }
    return stored;
  }
  function freshCached(document, userId, field, refresh) {
    const timestamp = now(), result = {};
    if (!document || !belongs(document, userId, [field])) return result;
    for (const kind of KINDS) {
      const part = document[kind];
      if (!freshPart(part, kind, timestamp)) continue;
      const age = timestamp - Date.parse(part.fetchedAt);
      // Expensive slow-changing sources stay cached. Failed calls back off for
      // five minutes even when Refresh is pressed repeatedly.
      if (refresh && !['soil','statistics'].includes(kind) && ['ready','cached'].includes(part.status) && age >= 60000) continue;
      if (part.status === 'needs_configuration' && ({ markets: env.USDA_AMS_API_KEY, statistics: env.USDA_NASS_API_KEY, air: env.AIRNOW_API_KEY })[kind]) continue;
      result[kind] = { ...part, status: ['ready','cached'].includes(part.status) ? 'cached' : part.status, source: SOURCES[kind] };
    }
    return result;
  }
  function budget(userId) {
    const timestamp = now(), previous = ownerBudgets.get(userId), entry = previous && timestamp >= previous.start && timestamp - previous.start < 60000 ? previous : { start: timestamp, count: 0 };
    if (entry.count >= 20 || inFlight.size >= 128) throw new HttpError(429, 'Too many context refreshes. Please wait a minute.');
    entry.count += 1; ownerBudgets.set(userId, entry);
    while (ownerBudgets.size > 512) ownerBudgets.delete(ownerBudgets.keys().next().value);
  }
  async function storeResult(userId, field, result) {
    const container = getContainer(), id = farmContextId(userId, field.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await readDocument(container, `state-${userId}`, userId);
      if (!sameField(currentField(state, field.id), field)) throw new HttpError(409, 'This field changed. Reload before requesting farm context.');
      const existing = await readDocument(container, id, userId);
      const document = { id, userId, type: 'farmContext', schemaVersion: 1, contextKey: contextKey(field), ...result };
      // Another worker may finish a newer request first. Never replace its valid
      // observation with an older concurrent result for the same context.
      if (existing && belongs(existing, userId, [field])) {
        for (const kind of KINDS) if (freshPart(existing[kind], kind, now()) && Date.parse(existing[kind].fetchedAt) > Date.parse(document[kind].fetchedAt)) document[kind] = existing[kind];
      }
      try {
        batchError(await container.items.batch([
          { operationType: 'Replace', id: state.id, resourceBody: state, ifMatch: state._etag },
          existing ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag } : { operationType: 'Create', resourceBody: document }
        ], userId));
        return;
      } catch (error) { if ([404,409,412].includes(Number(error.code))) continue; throw error; }
    }
    throw new HttpError(409, 'Your fields changed. Please retry.');
  }
  return {
    async readCachedFarmContext({ userId, field }) {
      await checkedField(userId, field);
      const cached = await readDocument(getContainer(), farmContextId(userId, field.id), userId), parts = freshCached(cached, userId, field, false);
      await checkedField(userId, field);
      return { fieldId: field.id, locationKey: locationKey(field), fetchedAt: cached?.fetchedAt || null,
        ...Object.fromEntries(KINDS.map(kind => [kind, parts[kind] || outcome(kind, 'unavailable', now(), 'No current cached result. Open Farm Context to refresh this source.')])) };
    },
    async getFarmContext({ userId, field, refresh = false }) {
      const stored = await checkedField(userId, field), key = `${userId}/${digest(stored)}`;
      if (!inFlight.has(key)) {
        const work = (async () => {
          const cached = await readDocument(getContainer(), farmContextId(userId, stored.id), userId), parts = freshCached(cached, userId, stored, refresh);
          const missing = KINDS.filter(kind => !parts[kind]);
          if (missing.length) {
            budget(userId); const { location } = normalizeGeometry(stored);
            await Promise.all(missing.map(async kind => {
              try { parts[kind] = await providers[kind]({ field: stored, location }); if (!freshPart(parts[kind], kind, now())) throw new Error('Invalid context result'); }
              catch { parts[kind] = outcome(kind, 'unavailable', now(), `${SOURCES[kind].name} could not provide a current, validated result. No value has been estimated. Please retry later.`); }
            }));
          }
          const result = { fieldId: stored.id, locationKey: locationKey(stored), fetchedAt: new Date(now()).toISOString(), ...parts };
          if (missing.length) await storeResult(userId, stored, result);
          await checkedField(userId, stored);
          return result;
        })().finally(() => inFlight.delete(key));
        inFlight.set(key, work);
      }
      const result = await inFlight.get(key);
      await checkedField(userId, stored);
      return structuredClone(result);
    }
  };
}
module.exports = { createFarmContextService, exportFarmContexts, pruneFarmContexts, farmContextId, contextKey, freshPart };
