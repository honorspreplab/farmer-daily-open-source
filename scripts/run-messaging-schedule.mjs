import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Importing this module never sends a request. A separate, explicitly enabled
// scheduler may call it; this is not a browser background-delivery mechanism.
const APPROVED_ORIGIN = 'https://calm-desert-02e51f41e.1.azurestaticapps.net';
const MAX_PAGES = 20;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_RESPONSE_BYTES = 32768;
const COUNTS = ['processed', 'accepted', 'failed', 'skipped'];
const failure = () => new Error('Messaging scheduler stopped safely. Check secure server configuration and delivery status before trying again; this run did not retry.');

export function configuration(env = process.env) {
  // No default destination: activation must name the existing app explicitly.
  // Supporting a new custom domain requires a reviewed allowlist change, not a
  // caller-supplied URL that could receive the scheduler secret.
  if (env.FARMER_MESSAGING_SCHEDULE_ENABLED !== 'true' ||
      ![APPROVED_ORIGIN, `${APPROVED_ORIGIN}/`].includes(env.APP_ORIGIN) ||
      typeof env.MESSAGING_DISPATCH_KEY !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(env.MESSAGING_DISPATCH_KEY)) throw failure();
  return { endpoint: `${APPROVED_ORIGIN}/api/messaging-dispatch`, key: env.MESSAGING_DISPATCH_KEY };
}

async function readResult(response, endpoint) {
  if (!response || response.status !== 200 || response.redirected ||
      response.url && response.url !== endpoint ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '') ||
      Number(response.headers?.get('content-length') || 0) > MAX_RESPONSE_BYTES ||
      typeof response.body?.getReader !== 'function') throw failure();
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure();
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      COUNTS.some(name => !Number.isSafeInteger(result[name]) || result[name] < 0 || result[name] > 10000) ||
      !(result.nextCursor === null || typeof result.nextCursor === 'string' &&
        result.nextCursor.length > 0 && result.nextCursor.length <= 16000 && /^[A-Za-z0-9_-]+$/.test(result.nextCursor))) throw failure();
  // Only allowlisted aggregate counts leave this function. Never return provider
  // errors, recipient details, body text, headers, or continuation tokens to logs.
  return { ...Object.fromEntries(COUNTS.map(name => [name, result[name]])), nextCursor: result.nextCursor };
}

export async function runMessagingSchedule({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const config = configuration(env), started = now();
  const result = { pages: 0, processed: 0, accepted: 0, failed: 0, skipped: 0, complete: false };
  const seen = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remaining = RUN_TIMEOUT_MS - (now() - started);
    if (remaining <= 0) return { ...result, stopReason: 'time_limit' };
    let batch;
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-farmer-messaging-key': config.key },
        body: JSON.stringify(cursor ? { cursor } : {}),
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining))
      });
      batch = await readResult(response, config.endpoint);
    } catch { throw failure(); }
    result.pages += 1;
    for (const name of COUNTS) result[name] += batch[name];
    if (batch.nextCursor === null) return { ...result, complete: true, stopReason: 'complete' };
    if (seen.has(batch.nextCursor)) throw failure();
    seen.add(batch.nextCursor);
    cursor = batch.nextCursor;
  }
  return { ...result, stopReason: 'page_limit' };
}

export async function main({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, write = text => console.log(text) } = {}) {
  try {
    const result = await runMessagingSchedule({ env, fetchImpl, now });
    write(`Messaging scheduler: ${result.pages} pages; ${result.processed} processed; ${result.accepted} accepted by provider; ${result.failed} failed; ${result.skipped} skipped; ${result.complete ? 'scan complete' : 'scan stopped at safety limit'}. Provider acceptance does not confirm handset delivery.`);
    return result.complete && result.failed === 0 ? 0 : 1;
  } catch {
    // Intentionally omit the exception: network/provider errors may embed keys,
    // URLs, recipient data, or response bodies. Do not immediately replay a run.
    write('Messaging scheduler stopped safely. No automatic retry was attempted. Check secure configuration and delivery status before running it again.');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
