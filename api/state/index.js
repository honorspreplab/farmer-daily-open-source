const { getContainer: defaultContainer, readDocument, replaceDocument } = require('../shared/store');
const { createAccess, HttpError, respond, handleError, header } = require('../shared/access');
const { normalizeGeometry } = require('../shared/field-geometry');
const { exportFieldContexts, pruneFieldContexts } = require('../shared/field-data');
const { exportFarmContexts, pruneFarmContexts } = require('../shared/farm-context');
const { exportSatelliteContexts, pruneSatelliteContexts } = require('../shared/satellite');
const { exportFarmOperations, pruneFarmOperations } = require('../shared/farm-operations');
const { exportCalendarConnections, pruneCalendarConnections } = require('../shared/calendar-connections');
const { exportAiUsage } = require('../shared/ai-budget');

const MAX_STATE_BYTES = 512 * 1024;
const MAX_PHOTO_BYTES = 80 * 1024;
const ALLOWED_KEYS = new Set(['profile', 'fields', 'tasks', 'observations', 'jobs', 'jobEvents', 'theme', 'readingPreferences', 'updatedAt']);
const FREE_KEYS = new Set(['profile', 'fields', 'tasks', 'theme', 'readingPreferences', 'updatedAt']);
const ALLOWED_THEMES = new Set(['field', 'harvest', 'slate', 'sunrise', 'prairie', 'midnight', 'orchard', 'coastal', 'lavender', 'highcontrast']);
const READING_PREFERENCE_KEYS = new Set(['enabled', 'textSize']);
const FIELD_KEYS = new Set(['id', 'name', 'crop', 'stage', 'acres', 'createdAt', 'location', 'boundary', 'variety', 'plantingDate', 'bloomDate', 'transplantDate', 'dataConsent', 'contextConsent', 'satelliteConsent', 'landsatConsent', 'marketReportId', 'marketLabel']);
const TASK_KEYS = new Set(['id', 'name', 'place', 'date', 'time', 'fieldId', 'status', 'done', 'createdAt', 'completedAt', 'observationId', 'jobId', 'planItemId', 'reason', 'workType']);
const OBSERVATION_KEYS = new Set(['id', 'field', 'fieldId', 'note', 'hasPhoto', 'photo', 'createdAt', 'sync']);

function recordObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function textValue(value, limit, label, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function timestamp(value, label) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `Invalid ${label} date`);
  }
}

function calendarDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new HttpError(400, `Invalid ${label} date`);
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 300) throw new HttpError(400, 'Save up to 300 tasks');
  const ids = new Set();
  for (const task of tasks) {
    recordObject(task, TASK_KEYS, 'task');
    // Historical tasks used numeric IDs and sometimes omitted date/field links.
    if (typeof task.id === 'number') {
      if (!Number.isSafeInteger(task.id) || task.id < 0) throw new HttpError(400, 'Invalid task ID');
    } else textValue(task.id, 150, 'task ID', true);
    if (ids.has(String(task.id))) throw new HttpError(400, 'Task IDs must be unique');
    ids.add(String(task.id));
    textValue(task.name, 200, 'task name', true);
    for (const key of ['place', 'status', 'fieldId', 'observationId', 'jobId', 'planItemId', 'reason', 'workType']) {
      if (task[key] !== undefined) textValue(task[key], key === 'reason' ? 2000 : key === 'fieldId' ? 100 : 200, `task ${key}`);
    }
    if (task.date !== undefined && task.date !== '') calendarDate(task.date, 'task');
    if (task.time !== undefined && (typeof task.time !== 'string' || task.time !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.time) &&
        !(typeof task.id === 'number' && /^(?:[1-9]|1[0-2]):[0-5]\d (?:AM|PM)$/.test(task.time)))) {
      throw new HttpError(400, 'Invalid task time');
    }
    if (task.done !== undefined && typeof task.done !== 'boolean') throw new HttpError(400, 'Invalid task completion');
    timestamp(task.createdAt, 'task');
    if (task.completedAt !== undefined && task.completedAt !== null) timestamp(task.completedAt, 'task completion');
  }
}

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length > 50) throw new HttpError(400, 'Save up to 50 fields');
  const ids = new Set();
  for (const field of fields) {
    recordObject(field, FIELD_KEYS, 'field');
    textValue(field.id, 100, 'field ID', true);
    textValue(field.name, 100, 'field name', true);
    textValue(field.crop, 80, 'field crop', true);
    if (ids.has(field.id)) throw new HttpError(400, 'Field IDs must be unique');
    ids.add(field.id);
    if (field.stage !== undefined) textValue(field.stage, 80, 'field stage');
    if (field.variety !== undefined) textValue(field.variety, 80, 'field variety');
    for (const name of ['plantingDate', 'bloomDate', 'transplantDate']) if (field[name] !== undefined) calendarDate(field[name], name);
    if (field.dataConsent !== undefined && typeof field.dataConsent !== 'boolean') throw new HttpError(400, 'Invalid field data permission');
    for (const permission of ['contextConsent','satelliteConsent','landsatConsent']) if (field[permission] !== undefined && typeof field[permission] !== 'boolean') throw new HttpError(400, 'Invalid field intelligence permission');
    if (field.marketReportId !== undefined && (typeof field.marketReportId !== 'string' || !/^(?:[0-9]{1,8})?$/.test(field.marketReportId))) throw new HttpError(400, 'Choose a numeric USDA report ID or leave it blank');
    if (field.marketLabel !== undefined) textValue(field.marketLabel, 120, 'market label');
    if (field.location !== undefined || field.boundary !== undefined) {
      try { Object.assign(field, normalizeGeometry(field)); } catch (error) { throw new HttpError(400, error.message); }
    }
    if (field.acres !== undefined && field.acres !== null && (typeof field.acres !== 'number' || !Number.isFinite(field.acres) || field.acres <= 0 || field.acres > 1000000)) {
      throw new HttpError(400, 'Invalid field acreage');
    }
    timestamp(field.createdAt, 'field');
  }
}

function validatePhoto(photo) {
  // Only small inline JPEGs belong in private account storage. Never accept remote
  // URLs, SVG/HTML, or arbitrary data URLs that could fetch or execute content.
  if (typeof photo !== 'string') throw new HttpError(400, 'Invalid observation photo');
  if (Buffer.byteLength(photo, 'utf8') > MAX_PHOTO_BYTES) throw new HttpError(413, 'Observation photo is too large');
  const prefix = 'data:image/jpeg;base64,';
  if (!photo.startsWith(prefix)) throw new HttpError(400, 'Observation photos must be JPEG images');
  const encoded = photo.slice(prefix.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new HttpError(400, 'Invalid observation photo encoding');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new HttpError(400, 'Invalid observation JPEG');
  }
}

function validateObservations(observations) {
  if (!Array.isArray(observations) || observations.length > 200) throw new HttpError(400, 'Save up to 200 observations');
  const ids = new Set();
  for (const observation of observations) {
    recordObject(observation, OBSERVATION_KEYS, 'observation');
    if (typeof observation.id === 'number') {
      if (!Number.isSafeInteger(observation.id) || observation.id < 0) throw new HttpError(400, 'Invalid observation ID');
    } else textValue(observation.id, 100, 'observation ID', true);
    if (ids.has(String(observation.id))) throw new HttpError(400, 'Observation IDs must be unique');
    ids.add(String(observation.id));
    textValue(observation.field, 100, 'observation field');
    textValue(observation.note, 2000, 'observation note');
    if (observation.fieldId !== undefined) textValue(observation.fieldId, 100, 'observation field ID', true);
    if (observation.hasPhoto !== undefined && typeof observation.hasPhoto !== 'boolean') throw new HttpError(400, 'Invalid observation photo flag');
    if (observation.sync !== undefined) textValue(observation.sync, 40, 'observation sync status');
    timestamp(observation.createdAt, 'observation');
    if (observation.photo !== undefined) validatePhoto(observation.photo);
  }
}

function sanitizedState(value, plan) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid farm state');
  const state = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_KEYS.has(key)) throw new HttpError(400, 'Unsupported farm state field');
    if (plan !== 'premium' && !FREE_KEYS.has(key)) throw new HttpError(403, 'Premium approval is required to save this feature');
    if (key !== 'updatedAt') state[key] = item;
  }
  if (state.profile !== undefined && state.profile !== null && (typeof state.profile !== 'object' || Array.isArray(state.profile))) throw new HttpError(400, 'Invalid profile');
  if (state.profile) {
    if (state.profile.language !== undefined && !['English', 'Español', 'en', 'es'].includes(state.profile.language)) throw new HttpError(400, 'Choose English or Spanish');
    if (state.profile.briefTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(state.profile.briefTime)) throw new HttpError(400, 'Invalid daily brief time');
    if (state.profile.scheduleEnabled !== undefined && typeof state.profile.scheduleEnabled !== 'boolean') throw new HttpError(400, 'Invalid daily brief schedule preference');
    if (state.profile.notificationPreference !== undefined && !['in-app', 'browser', 'off'].includes(state.profile.notificationPreference)) throw new HttpError(400, 'Invalid notification preference');
    for (const key of ['firstName', 'farmName']) if (state.profile[key] !== undefined) textValue(state.profile[key], 100, key);
  }
  if (state.theme !== undefined && (typeof state.theme !== 'string' || !ALLOWED_THEMES.has(state.theme))) throw new HttpError(400, 'Invalid theme');
  if (Object.hasOwn(state, 'readingPreferences')) {
    const preferences = state.readingPreferences;
    recordObject(preferences, READING_PREFERENCE_KEYS, 'reading preferences');
    if (Object.getPrototypeOf(preferences) !== Object.prototype || Reflect.ownKeys(preferences).length !== 2 ||
        !Object.hasOwn(preferences, 'enabled') || !Object.hasOwn(preferences, 'textSize') ||
        typeof preferences.enabled !== 'boolean' || !['comfortable', 'large'].includes(preferences.textSize)) {
      throw new HttpError(400, 'Invalid reading preferences');
    }
    // This is a display preference only; no diagnosis or health data is stored.
    state.readingPreferences = { enabled: preferences.enabled, textSize: preferences.textSize };
  }
  if (state.fields !== undefined) validateFields(state.fields);
  if (state.tasks !== undefined) validateTasks(state.tasks);
  if (state.observations !== undefined) validateObservations(state.observations);
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) throw new HttpError(413, 'Farm state is too large');
  return state;
}

function freeState(state) {
  if (!state) return null;
  return Object.fromEntries(Object.entries(state).filter(([key]) => FREE_KEYS.has(key)));
}

const { exportMessaging, pruneMessaging } = require('../shared/messaging');
function createStateHandler({ getContainer = defaultContainer, now = Date.now } = {}) {
  const access = createAccess({ getContainer, now });
  return async function state(context, req) {
    try {
      if (!['GET', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const { principal, plan } = await access.requireAccess(req);
      const container = getContainer();
      const id = `state-${principal.id}`;
      if (req.method === 'GET') {
        const document = await readDocument(container, id, principal.id);
        const saved = document?.state || null;
        // First sign-in and deleted farm data are valid empty states, not errors.
        // Explicit 204 avoids Azure's ambiguous serialization of a null JSON body.
        if (saved === null) {
          // Quota metadata deliberately survives farm-data deletion and remains
          // exportable by its owner even when there is no longer a farm profile.
          if (req.query?.export === '1') {
            const aiUsage = await exportAiUsage(container, principal.id);
            if (aiUsage) return respond(context, 200, { aiUsage });
          }
          return respond(context, 204);
        }
        // Retrieving one's own private data for export remains available on every plan.
        if (req.query?.export === '1') {
          const derivedFieldData = await exportFieldContexts(container, principal.id, saved.fields);
          const farmContextData = await exportFarmContexts(container, principal.id, saved.fields);
          const satelliteData = await exportSatelliteContexts(container, principal.id, saved.fields);
          const farmOperations = await exportFarmOperations(container, principal.id);
          const calendarConnections = await exportCalendarConnections(container, principal.id);
          const messaging = await exportMessaging(container, principal.id);
          const aiUsage = await exportAiUsage(container, principal.id);
          return respond(context, 200, { ...saved, ...(derivedFieldData.length ? {derivedFieldData} : {}), ...(farmContextData.length ? {farmContextData} : {}), ...(satelliteData.length ? {satelliteData} : {}), ...(farmOperations ? {farmOperations} : {}), ...(calendarConnections ? {calendarConnections} : {}), ...(messaging ? {messaging} : {}), ...(aiUsage ? {aiUsage} : {}) });
        }
        const visible = plan === 'premium' ? saved : freeState(saved);
        return respond(context, 200, { ...visible, ...(document.workflowRevision ? { workflowRevision: document.workflowRevision } : {}) });
      }
      if (req.method === 'DELETE') {
        try { await container.item(id, principal.id).delete(); }
        catch (error) { if (Number(error.code) !== 404) throw error; }
        // Remove outbound credentials before cleaning derived records. Every new
        // connection/action also guards the owner farm state transactionally.
        // aiUsage retains only UTC-day request counts to prevent deletion from
        // resetting paid-request limits; there are no AI prompts/results to prune.
        await pruneMessaging(container, principal.id);
        await pruneCalendarConnections(container, principal.id);
        await pruneFieldContexts(container, principal.id);
        await pruneFarmContexts(container, principal.id);
        await pruneSatelliteContexts(container, principal.id);
        await pruneFarmOperations(container, principal.id);
        const iterator = container.items.query({
          query: 'SELECT c.id FROM c WHERE c.userId = @userId AND c.type = @type',
          parameters: [{ name: '@userId', value: principal.id }, { name: '@type', value: 'dailyBrief' }]
        }, { partitionKey: principal.id });
        const { resources } = await iterator.fetchAll();
        for (const item of resources || []) {
          let removed = false;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const brief = await readDocument(container, item.id, principal.id);
            if (!brief || brief.deleted) { removed = true; break; }
            try {
              // Preserve only the date quota marker so deletion cannot create extra free briefs.
              await replaceDocument(container, {
                id: brief.id, userId: principal.id, _etag: brief._etag, type: 'dailyBrief',
                date: brief.date, deleted: true, brief: null
              });
              removed = true;
              break;
            } catch (error) { if (Number(error.code) !== 412) throw error; }
          }
          if (!removed) throw new HttpError(409, 'Data changed during deletion. Please retry.');
        }
        return respond(context, 204);
      }
      const supplied = sanitizedState(req.body, plan);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await readDocument(container, id, principal.id);
        // A stale tab must not undo a task written by a reviewed server workflow.
        // The revision is server metadata, never a farmer-editable state property.
        if (existing?.workflowRevision && supplied.tasks !== undefined && header(req, 'x-farmer-workflow-revision') !== String(existing.workflowRevision)) throw new HttpError(409, 'A server workflow changed your tasks. Reload before saving; your device copy has been kept.');
        // Partial updates from older tabs must not silently drop newer fields.
        const saved = { ...(existing?.state || {}), ...supplied };
        saved.updatedAt = new Date(now()).toISOString();
        if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > MAX_STATE_BYTES) throw new HttpError(413, 'Farm state is too large');
        const document = { ...(existing || {}), id, userId: principal.id, type: 'state', state: saved, schemaVersion: 1 };
        try {
          if (existing) await replaceDocument(container, document);
          else await container.items.create(document);
          if (supplied.fields !== undefined) {
            await pruneFieldContexts(container, principal.id, saved.fields);
            await pruneFarmContexts(container, principal.id, saved.fields);
            await pruneSatelliteContexts(container, principal.id, saved.fields);
          }
          return respond(context, 200, { saved: true, updatedAt: saved.updatedAt, ...(document.workflowRevision ? { workflowRevision: document.workflowRevision } : {}) });
        } catch (error) { if ([409, 412].includes(Number(error.code))) continue; throw error; }
      }
      throw new HttpError(409, 'Farm data changed. Please retry.');
    } catch (error) { handleError(context, error); }
  };
}

module.exports = createStateHandler();
module.exports.createStateHandler = createStateHandler;
module.exports.validateTasks = validateTasks;
