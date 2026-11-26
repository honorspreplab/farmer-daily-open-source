'use strict';
const { readDocument, replaceDocument } = require('./store');
const { HttpError } = require('./access');
const PARTITION = 'system-ai-budget-v1';
const MICRO = 1000000;
const REQUESTS_PER_DAY = 10;
// Standard text prices checked against official model pages, 2026-10-24.
// Conservatively include full input plus the longest (12h) cache-write price for
// every input token, even though the default is cheaper 30m caching.
// Reasoning is included in output_tokens. Estimates are upper estimates, not bills.
const PRICES = Object.freeze({ 'gpt-6-luna': { input: 0.35, output: 0.5 }, 'gpt-6.1-sol': { input: 7, output: 10 } });
const MAX_REQUEST_BYTES = 20000;
const MAX_OUTPUT_TOKENS = 1500;
const INPUT_TOKEN_BOUND = MAX_REQUEST_BYTES + 2048;
function costMicros(model, input, output) {
  const price = PRICES[model];
  if (!price) throw new Error('Unsupported budget model');
  return Math.ceil(input * price.input + output * price.output);
}
function reserveMicros(models) { return models.reduce((total, model) => total + costMicros(model, INPUT_TOKEN_BOUND, MAX_OUTPUT_TOKENS), 0); }
function dayKey(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }
function validCounter(document) { return Number.isSafeInteger(document.requests) && document.requests >= 0; }
async function reserveUser(container, saved, day) {
  const owner = saved.owner, id = `ai-usage-${owner}-${day}`;
  const existing = await readDocument(container, id, owner);
  if (existing && (!validCounter(existing) || existing.day !== day || existing.type !== 'aiUsage')) throw new HttpError(503, 'AI usage accounting is unavailable.');
  if ((existing?.requests || 0) >= REQUESTS_PER_DAY) throw new HttpError(429, 'Your daily limit of 10 AI requests has been reached. The rule-based brief is still available.');
  const document = { id, userId: owner, type: 'aiUsage', day, requests: (existing?.requests || 0) + 1 };
  // Quota count and existence of owner-state are one partition transaction. No
  // prompt/result is stored, and deletion cannot resurrect a farm or reset quota.
  const batch = await container.items.batch([
    { operationType: 'Replace', id: saved.state.id, resourceBody: saved.state, ifMatch: saved.state._etag },
    existing ? { operationType: 'Replace', id, resourceBody: document, ifMatch: existing._etag } : { operationType: 'Create', resourceBody: document }
  ], owner);
  const failed = batch.result?.find(item => item.statusCode >= 400 && item.statusCode !== 424);
  if (!batch.result || failed || batch.result.some(item => item.statusCode >= 400) || batch.code >= 400) {
    throw new HttpError([404,409,412].includes(failed?.statusCode || batch.code) ? 409 : 503, 'Farm records or AI usage changed. Reload the AI preview.');
  }
  const state = { ...(batch.result[0]?.resourceBody || saved.state), _etag: batch.result[0]?.eTag || batch.result[0]?.resourceBody?._etag };
  if (!state?._etag) throw new HttpError(503, 'AI usage accounting could not be verified.');
  return { ...saved, state };
}
async function reserveGlobal(container, day, amount, dailyLimitUsd) {
  const id = `ai-budget-${day}`, limit = Math.floor(dailyLimitUsd * MICRO);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 10 * MICRO) throw new HttpError(503, 'AI budget is not configured safely.');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await readDocument(container, id, PARTITION);
    if (existing && (!validCounter(existing) || !Number.isSafeInteger(existing.reservedMicros) || existing.reservedMicros < 0 || existing.day !== day || existing.type !== 'aiBudget')) throw new HttpError(503, 'AI budget accounting is unavailable.');
    const reservedMicros = (existing?.reservedMicros || 0) + amount;
    if (reservedMicros > limit) throw new HttpError(429, 'The app-wide daily AI budget is reached. The rule-based brief is still available.');
    const document = { id, userId: PARTITION, type: 'aiBudget', day, reservedMicros, requests: (existing?.requests || 0) + 1 };
    try {
      if (existing) await replaceDocument(container, { ...document, _etag: existing._etag });
      else await container.items.create(document);
      // Never refund reservations: timed-out/failed provider requests may be billed.
      return { dailyLimitUsd, reservedUsd: reservedMicros / MICRO, requestReservedUsd: amount / MICRO, day };
    } catch (error) { if ([409,412].includes(Number(error.code))) continue; throw error; }
  }
  throw new HttpError(503, 'AI budget accounting is busy. No provider request was sent.');
}
async function exportAiUsage(container, owner) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new HttpError(400, 'Invalid AI usage owner.');
  const { resources } = await container.items.query({
    query: 'SELECT TOP 366 c.day, c.requests FROM c WHERE c.userId = @userId AND c.type = @type ORDER BY c.day DESC',
    parameters: [{ name: '@userId', value: owner }, { name: '@type', value: 'aiUsage' }]
  }, { partitionKey: owner, maxItemCount: 100 }).fetchAll();
  const records = (resources || []).slice(0, 366).filter(document => typeof document.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(document.day) &&
    Number.isFinite(Date.parse(`${document.day}T00:00:00Z`)) && new Date(`${document.day}T00:00:00Z`).toISOString().slice(0, 10) === document.day && validCounter(document) && document.requests <= REQUESTS_PER_DAY)
    .map(document => ({ day: document.day, requests: document.requests }));
  return records.length ? { dailyRequestLimit: REQUESTS_PER_DAY, recordLimit: 366, records } : null;
}
module.exports = { PARTITION, PRICES, MAX_REQUEST_BYTES, MAX_OUTPUT_TOKENS, INPUT_TOKEN_BOUND, costMicros, reserveMicros, reserveUser, reserveGlobal, dayKey, exportAiUsage };
