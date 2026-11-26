'use strict';
const { randomBytes, createHash, createCipheriv, createDecipheriv, randomUUID, timingSafeEqual } = require('node:crypto');
const { readDocument } = require('./store');
const { HttpError, dateKey } = require('./access');
const { batchError } = require('./farm-operations');
const { DEFINITIONS, configuration } = require('./calendar-providers');
const FLOW_MS = 10 * 60 * 1000;
const idFor = owner => `calendar-${owner}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const objectHash = value => hash(JSON.stringify(value));
const random = () => randomBytes(32).toString('base64url');
function encrypt(value, key, owner, provider) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`farmer-daily:calendar:v1:${owner}:${provider}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(value, key, owner, provider) {
  try {
    if (value?.v !== 1 || typeof value.iv !== 'string' || typeof value.data !== 'string' || typeof value.tag !== 'string' || value.data.length > 60000) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    cipher.setAAD(Buffer.from(`farmer-daily:calendar:v1:${owner}:${provider}`)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new HttpError(409, 'This calendar connection cannot be opened. Disconnect it and connect again.'); }
}
function checkedDocument(document, owner) {
  if (!document) return null;
  if (document.id !== idFor(owner) || document.userId !== owner || document.type !== 'calendarConnections' || !document.connections || typeof document.connections !== 'object' || Array.isArray(document.connections) || !document.pending || typeof document.pending !== 'object' || Array.isArray(document.pending) || !Array.isArray(document.proposals)) throw new Error('Invalid private calendar record');
  return document;
}
function emptyDocument(owner) { return { id: idFor(owner), userId: owner, type: 'calendarConnections', schemaVersion: 1, connections: {}, pending: {}, proposals: [] }; }
function publicProposal(proposal) {
  return Object.fromEntries(['id', 'provider', 'status', 'createdAt', 'expiresAt', 'preview', 'executedAt', 'cancelledAt', 'result', 'message'].filter(key => proposal[key] !== undefined).map(key => [key, structuredClone(proposal[key])]));
}
function publicView(document, { env = process.env, isAdmin = false, canConnect = false } = {}) {
  return { providers: Object.keys(DEFINITIONS).map(id => {
    const config = configuration(id, env), connection = document?.connections[id], pending = document?.pending[id];
    const connected = Boolean(connection?.status === 'connected' && connection.secret && connection.calendarId);
    return { id, name: config.name, configured: config.configured, connected, accountLabel: connection?.accountLabel || null, calendarName: connection?.calendarName || null, connectedAt: connection?.connectedAt || null, needsReconnect: Boolean(connection?.needsReconnect || pending?.status === 'uncertain'), connectionStatus: connected ? 'connected' : pending?.status === 'uncertain' ? 'uncertain' : pending && pending.status !== 'failed' ? 'connecting' : 'disconnected', ...(isAdmin ? { setupRequired: config.missing } : {}) };
  }), proposals: (document?.proposals || []).map(publicProposal), canConnect };
}
async function writeDocument(container, owner, previous, document, { state, account } = {}) {
  if (Buffer.byteLength(JSON.stringify(document)) > 300 * 1024) throw new HttpError(413, 'Calendar history is full. Remove completed records before continuing.');
  const operations = [];
  if (state) operations.push({ operationType: 'Replace', id: state.id, resourceBody: state, ifMatch: state._etag });
  if (account) operations.push({ operationType: 'Replace', id: account.id, resourceBody: account, ifMatch: account._etag });
  operations.push(previous ? { operationType: 'Replace', id: previous.id, resourceBody: document, ifMatch: previous._etag } : { operationType: 'Create', resourceBody: document });
  try {
    const result = await container.items.batch(operations, owner); batchError(result);
    const resource = result.result.at(-1)?.resourceBody;
    const persisted = resource?._etag ? checkedDocument(resource, owner) : checkedDocument(await readDocument(container, document.id, owner), owner);
    if (!persisted) throw new HttpError(409, 'Your calendar settings changed. Reload before continuing.');
    return persisted;
  } catch (error) {
    if ([404, 409, 412].includes(Number(error.code))) throw new HttpError(409, 'Your farm, access or calendar connection changed. Reload before continuing.');
    throw error;
  }
}
function validateBody(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || Buffer.byteLength(JSON.stringify(body)) > 20000) throw new HttpError(400, 'Invalid calendar request');
}
function text(value, max, label) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, `Invalid ${label}`); return value; }
function cookieName(provider) { return `fd_calendar_${provider}`; }
function cookieValue(req, provider) {
  const headers = req.headers || {}, cookie = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie || headers.Cookie;
  if (typeof cookie !== 'string' || cookie.length > 20000) return '';
  return cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName(provider)}=`))?.slice(cookieName(provider).length + 1) || '';
}
function cookie(provider, value = '') { return `${cookieName(provider)}=${value}; Path=/api/calendar-connections; Max-Age=${value ? 600 : 0}; HttpOnly; Secure; SameSite=Lax`; }
function matchesHash(value, expected) { if (typeof value !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false; return timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected)); }
const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function pacificInstant(date, time) {
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const approximate = Date.UTC(year, month - 1, day, hour, minute), matches = [];
  for (const hours of [7, 8]) {
    const instant = approximate + hours * 3600000, parts = Object.fromEntries(pacific.formatToParts(instant).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === date && `${parts.hour}:${parts.minute}` === time) matches.push(instant);
  }
  if (matches.length !== 1) throw new HttpError(400, 'This Pacific time is missing or repeated during a daylight-saving change. Choose a different task time before copying it.');
  return matches[0];
}
function taskSnapshot(state, taskId, connection, now) {
  if (!['string', 'number'].includes(typeof taskId) || String(taskId).length > 100) throw new HttpError(400, 'Choose a saved unfinished task');
  const task = state.tasks?.find(item => String(item.id) === String(taskId));
  if (!task || task.done) throw new HttpError(409, 'This task is missing or completed. Choose a saved unfinished task.');
  const title = text(task.name, 200, 'task title'), date = task.date, time = task.time || '';
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date || date < dateKey(now) || Date.parse(`${date}T12:00:00Z`) > now + 731 * 86400000) throw new HttpError(400, 'Save a task date from today through the next two years before copying it.');
  if (typeof time !== 'string' || time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Save a valid Pacific task time, or leave it blank for an all-day event.');
  const start = time ? pacificInstant(date, time) : null;
  return { task, preview: { taskId: task.id, title, date, time, timeZone: 'America/Los_Angeles', allDay: !time, startUtc: start === null ? null : new Date(start).toISOString(), endUtc: start === null ? null : new Date(start + 3600000).toISOString(), endDate: new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10), calendarName: connection.calendarName, accountLabel: connection.accountLabel } };
}
function newProposal(provider, snapshot, connection, now) {
  const id = randomUUID();
  return { id, provider, status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + FLOW_MS).toISOString(), preview: snapshot.preview, taskHash: objectHash(snapshot.task), generation: connection.generation, externalId: hash(`farmer-daily:${id}`) };
}
async function exportCalendarConnections(container, owner) {
  const document = checkedDocument(await readDocument(container, idFor(owner), owner), owner);
  if (!document) return null;
  return { connections: Object.entries(document.connections).map(([provider, value]) => ({ provider, accountLabel: value.accountLabel || null, calendarName: value.calendarName || null, connectedAt: value.connectedAt || null, status: value.status, needsReconnect: Boolean(value.needsReconnect) })), proposals: document.proposals.map(publicProposal), updatedAt: document.updatedAt || null };
}
async function pruneCalendarConnections(container, owner) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const document = checkedDocument(await readDocument(container, idFor(owner), owner), owner);
    if (!document) return;
    try { await container.item(document.id, owner).delete({ accessCondition: { type: 'IfMatch', condition: document._etag } }); return; }
    catch (error) { if (![404, 409, 412].includes(Number(error.code))) throw error; }
  }
  throw new HttpError(409, 'Calendar connections changed during cleanup. Please retry.');
}
module.exports = { FLOW_MS, idFor, hash, objectHash, random, encrypt, decrypt, checkedDocument, emptyDocument, publicProposal, publicView, writeDocument, validateBody, text, cookieName, cookieValue, cookie, matchesHash, taskSnapshot, newProposal, pacificInstant, exportCalendarConnections, pruneCalendarConnections };
