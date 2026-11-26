const { randomUUID } = require('node:crypto');
const { readDocument } = require('./store');
const { HttpError } = require('./access');

const MAX_OPERATIONS_BYTES = 400 * 1024;
const PHASE_FOUR_ACTIONS = new Set(['saveEquipment', 'deleteEquipment', 'importReadings', 'deleteReadingsBatch', 'saveKnowledge', 'deleteKnowledge']);
const WORKFLOW_ACTIONS = new Set(['proposeWorkflow', 'executeWorkflow', 'cancelWorkflow', 'deleteWorkflow']);
const EMPTY_KEYS = ['equipment', 'readings', 'knowledge', 'workflows', 'events'];
function emptyOperations() { return Object.fromEntries(EMPTY_KEYS.map(key => [key, []])); }
function operationsId(userId) { return `operations-${userId}`; }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, `Invalid ${label}`);
}
function text(value, max, label, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new HttpError(400, `Invalid ${label}`);
  return value.trim();
}
function calendarDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new HttpError(400, `Invalid ${label} date`);
  return value;
}
function fieldReference(value, state, required = false) {
  const id = text(value, 100, 'saved field', required);
  if (id && !state.fields?.some(field => field.id === id)) throw new HttpError(400, 'Choose a field saved in your own farm');
  return id;
}
function observedDate(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) throw new HttpError(400, 'Reading time must include an explicit time zone');
  calendarDate(value.slice(0, 10), 'reading');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > now) throw new HttpError(400, 'Reading time cannot be invalid, before 1970, or in the future');
  return new Date(parsed).toISOString();
}
function checkedDocument(document, userId) {
  if (!document) return null;
  if (document.id !== operationsId(userId) || document.userId !== userId || document.type !== 'farmOperations' || !document.operations || EMPTY_KEYS.some(key => !Array.isArray(document.operations[key]))) throw new Error('Invalid private operations record');
  return document;
}
function publicOperations(document) {
  return { operations: document ? structuredClone(document.operations) : emptyOperations(), updatedAt: document?.updatedAt || null, revision: document?._etag || null };
}
function assertOperationsSize(operations) {
  if (Buffer.byteLength(JSON.stringify(operations), 'utf8') > MAX_OPERATIONS_BYTES) throw new HttpError(413, 'Farm operations storage is full. Remove old notes or readings before adding more.');
}
function addEvent(operations, action, result, now) {
  const details = Object.fromEntries(['kind', 'added', 'removed', 'duplicates', 'batchId'].filter(key => ['string', 'number'].includes(typeof result?.[key])).map(key => [key, result[key]]));
  if (typeof result?.id === 'string') details.recordId = result.id;
  if (typeof result?.workflowId === 'string') details.workflowId = result.workflowId;
  operations.events.push({ id: randomUUID(), action, occurredAt: new Date(now).toISOString(), ...details });
  operations.events = operations.events.slice(-100);
}
function editRecord(records, record, kind, limit) {
  if (record.id) {
    const index = records.findIndex(item => item.id === record.id);
    if (index < 0) throw new HttpError(404, `${kind} record not found`);
    record.createdAt = records[index].createdAt;
    records[index] = record;
  } else {
    if (records.length >= limit) throw new HttpError(400, `Save up to ${limit} ${kind.toLowerCase()} records`);
    record.id = randomUUID();
    record.createdAt = record.updatedAt;
    records.push(record);
  }
}
function readingIdentity(reading) { return JSON.stringify([reading.fieldId, reading.sensorId, reading.metric, reading.observedAt]); }
function normalizeReading(reading, state, now) {
  object(reading, ['fieldId', 'sensorId', 'metric', 'unit', 'value', 'observedAt', 'source'], 'sensor reading');
  const units = { soil_moisture: 'percent', air_temperature: 'F', rainfall: 'mm', battery: 'percent' };
  if (typeof reading.metric !== 'string' || !Object.hasOwn(units, reading.metric) || reading.unit !== units[reading.metric]) throw new HttpError(400, 'Choose a supported metric and its matching unit');
  const minimum = reading.metric === 'air_temperature' ? -100 : 0;
  const maximum = reading.metric === 'air_temperature' ? 160 : reading.metric === 'rainfall' ? 2000 : 100;
  if (typeof reading.value !== 'number' || !Number.isFinite(reading.value) || reading.value < minimum || reading.value > maximum) throw new HttpError(400, 'Reading is outside the supported physical range');
  if (!['manual', 'csv'].includes(reading.source)) throw new HttpError(400, 'Reading source must be manual or csv');
  return { fieldId: fieldReference(reading.fieldId, state, true), sensorId: text(reading.sensorId, 120, 'sensor ID', true), metric: reading.metric, unit: reading.unit, value: reading.value, observedAt: observedDate(reading.observedAt, now), source: reading.source };
}

function applyOperation({ operations, state, action, payload, now = Date.now() }) {
  operations = structuredClone(operations);
  const timestamp = new Date(now).toISOString();
  let result;
  if (action === 'saveEquipment') {
    object(payload, ['id', 'name', 'kind', 'fieldId', 'irrigationType', 'notes', 'serviceDate'], 'equipment');
    if (!['irrigation', 'tractor', 'sprayer', 'sensor', 'other'].includes(payload.kind)) throw new HttpError(400, 'Choose a supported equipment type');
    const equipment = { id: text(payload.id, 100, 'equipment ID'), name: text(payload.name, 150, 'equipment name', true), kind: payload.kind, fieldId: fieldReference(payload.fieldId, state), irrigationType: text(payload.irrigationType, 120, 'irrigation type'), notes: text(payload.notes, 2000, 'equipment notes'), updatedAt: timestamp };
    if (payload.serviceDate !== undefined && payload.serviceDate !== '') equipment.serviceDate = calendarDate(payload.serviceDate, 'service');
    editRecord(operations.equipment, equipment, 'Equipment', 40);
    result = { id: equipment.id, kind: 'equipment' };
  } else if (action === 'saveKnowledge') {
    object(payload, ['id', 'title', 'fieldId', 'kind', 'text'], 'farm knowledge');
    if (!['sop', 'manual', 'note'].includes(payload.kind)) throw new HttpError(400, 'Choose a supported knowledge type');
    const knowledge = { id: text(payload.id, 100, 'knowledge ID'), title: text(payload.title, 150, 'knowledge title', true), fieldId: fieldReference(payload.fieldId, state), kind: payload.kind, text: text(payload.text, 8000, 'knowledge text', true), updatedAt: timestamp };
    editRecord(operations.knowledge, knowledge, 'Knowledge', 30);
    result = { id: knowledge.id, kind: 'knowledge' };
  } else if (action === 'deleteEquipment' || action === 'deleteKnowledge') {
    object(payload, ['id'], 'record deletion');
    const id = text(payload.id, 100, 'record ID', true), kind = action === 'deleteEquipment' ? 'equipment' : 'knowledge';
    if (!operations[kind].some(item => item.id === id)) throw new HttpError(404, 'Farm record not found');
    operations[kind] = operations[kind].filter(item => item.id !== id);
    result = { id, kind };
  } else if (action === 'deleteReadingsBatch') {
    object(payload, ['batchId'], 'reading batch deletion');
    const batchId = text(payload.batchId, 100, 'reading batch ID', true);
    const removed = operations.readings.filter(item => item.batchId === batchId).length;
    if (!removed) throw new HttpError(404, 'Reading batch not found');
    operations.readings = operations.readings.filter(item => item.batchId !== batchId);
    result = { batchId, removed, kind: 'readings', message: `${removed} imported reading${removed === 1 ? '' : 's'} removed from this batch.` };
  } else if (action === 'importReadings') {
    object(payload, ['readings'], 'reading import');
    if (!Array.isArray(payload.readings) || !payload.readings.length || payload.readings.length > 100) throw new HttpError(400, 'Import between 1 and 100 readings at a time');
    const existing = new Map(operations.readings.map(reading => [readingIdentity(reading), reading]));
    const batchId = randomUUID();
    let added = 0, duplicates = 0;
    for (const input of payload.readings) {
      const reading = normalizeReading(input, state, now), key = readingIdentity(reading), previous = existing.get(key);
      if (previous) {
        if (previous.value !== reading.value || previous.unit !== reading.unit) throw new HttpError(409, 'This sensor already has a different reading at that time. Existing readings were not overwritten.');
        duplicates += 1;
        continue;
      }
      const saved = { ...reading, id: randomUUID(), batchId, receivedAt: timestamp };
      operations.readings.push(saved);
      existing.set(key, saved);
      added += 1;
    }
    if (operations.readings.length > 500) throw new HttpError(400, 'Save up to 500 sensor readings');
    result = { added, duplicates, batchId, kind: 'readings' };
  } else throw new HttpError(400, 'Unsupported farm operation');
  addEvent(operations, action, result, now);
  assertOperationsSize(operations);
  return { operations, state, result };
}

function batchError(batch) {
  const failed = batch.result?.find(operation => operation.statusCode >= 400 && operation.statusCode !== 424);
  if (failed || !batch.result || batch.result.some(operation => operation.statusCode >= 400) || (batch.code && batch.code >= 400)) {
    const error = new Error('Farm operations transaction failed');
    error.code = failed?.statusCode || batch.code || 503;
    throw error;
  }
}
async function exportFarmOperations(container, userId) {
  const document = checkedDocument(await readDocument(container, operationsId(userId), userId), userId);
  if (!document) return null;
  const { operations, updatedAt } = publicOperations(document);
  return { operations, updatedAt };
}
async function pruneFarmOperations(container, userId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const document = checkedDocument(await readDocument(container, operationsId(userId), userId), userId);
    if (!document) return;
    try {
      await container.item(document.id, userId).delete({ accessCondition: { type: 'IfMatch', condition: document._etag } });
      return;
    } catch (error) { if (![404, 409, 412].includes(Number(error.code))) throw error; }
  }
  throw new HttpError(409, 'Farm records changed during cleanup. Please retry.');
}

module.exports = { MAX_OPERATIONS_BYTES, PHASE_FOUR_ACTIONS, WORKFLOW_ACTIONS, emptyOperations, operationsId, checkedDocument, publicOperations, assertOperationsSize, addEvent, applyOperation, batchError, exportFarmOperations, pruneFarmOperations };
