'use strict';
// Local, synthetic-owner capture only. NEVER deploy this server.
// No key is read and no OpenAI request is permitted unless allowPaid === true.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { parseEnv } = require('node:util');
const { memoryContainer } = require('../../tests/helpers/ai-fixture.cjs');
const { dateKey } = require('../../api/shared/access');
const { locationKey } = require('../../api/shared/field-geometry');
const { route } = require('../../api/shared/ai-provider');
const { reserveMicros, MAX_REQUEST_BYTES, MAX_OUTPUT_TOKENS } = require('../../api/shared/ai-budget');
const { createAiBriefHandler, requestBody } = require('../../api/ai-brief');
const root = path.resolve(__dirname, '../..');
const OWNER = 'presenter-synthetic-farm';
const EMAIL = 'sample-farmer@example.test';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_MICROS = 1000000;
const PUBLIC_HOSTS = new Set(['api.weather.gov', 'epqs.nationalmap.gov', 'api.open-meteo.com', 'planetarycomputer.microsoft.com', 'landsateuwest.blob.core.windows.net', 'earth-search.aws.element84.com', 'sentinel-cogs.s3.us-west-2.amazonaws.com', 'pdi.scinet.usda.gov']);
const clone = value => value === undefined ? undefined : structuredClone(value);
const safeError = (status, message) => Object.assign(new Error(message), { status });

// Append and fsync each attempt BEFORE work. No refunds and no automatic reset,
// including restarts, failed providers, changed dates or a lost response.
async function createAttemptLedger(directory) {
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, 'ai-recording-budget.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch { throw new Error('This recording budget is locked. Do not start another paid capture or reset its ledger.'); }
  await lock.writeFile(JSON.stringify({ process: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
  let handle;
  try {
    const ledgerPath = path.join(directory, 'ai-recording-attempts.jsonl');
    let contents = '';
    try { contents = await fs.readFile(ledgerPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contents && !contents.endsWith('\n')) throw new Error('Incomplete budget ledger; paid capture is blocked.');
    const state = { actions: {}, calls: 0, reservedMicros: 0 };
    function apply(event) {
      if (!event || event.version !== 1 || !['daily', 'summary'].includes(event.task)) throw new Error('Invalid recording budget ledger.');
      if (event.type === 'action') {
        const expected = reserveMicros(route(event.task, 'auto').map(step => step.model));
        if (state.actions[event.task] || event.reservedMicros !== expected || state.reservedMicros + expected > MAX_MICROS) throw new Error('Recording action or cost limit reached.');
        state.actions[event.task] = { calls: 0, expected: route(event.task, 'auto') }; state.reservedMicros += expected;
      } else if (event.type === 'provider') {
        const action = state.actions[event.task], expected = action?.expected[action.calls];
        if (!expected || expected.model !== event.model || expected.purpose !== event.purpose || state.calls >= 3) throw new Error('Recording provider-call limit reached.');
        action.calls++; state.calls++;
      } else throw new Error('Unknown recording ledger event.');
    }
    for (const line of contents.split('\n').filter(Boolean)) apply(JSON.parse(line));
    handle = await fs.open(ledgerPath, 'a');
    let chain = Promise.resolve(), failed = false;
    function append(event) {
      const job = chain.then(async () => {
        if (failed) throw new Error('Recording budget accounting is unavailable.');
        // Apply first in memory; failed durable writes never permit more spending.
        apply(event);
        try { await handle.write(JSON.stringify(event) + '\n'); await handle.sync(); }
        catch { failed = true; throw new Error('Recording budget could not be saved.'); }
      });
      chain = job.catch(() => {}); return job;
    }
    return {
      action(task) { return append({ version: 1, type: 'action', task, reservedMicros: reserveMicros(route(task, 'auto').map(step => step.model)), time: new Date().toISOString() }); },
      provider(task, model, purpose) { return append({ version: 1, type: 'provider', task, model, purpose, time: new Date().toISOString() }); },
      status() { return { actions: Object.keys(state.actions), providerCalls: state.calls, reservedUsd: state.reservedMicros / 1000000, maximumUsd: 1, maximumProviderCalls: 3 }; },
      async close() { await chain; await handle.close(); await lock.close(); await fs.unlink(lockPath); }
    };
  } catch (error) {
    await handle?.close().catch(() => {}); await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); throw error;
  }
}

function defaultState() {
  const stamp = new Date().toISOString();
  return { profile: { firstName: 'Maria', farmName: 'Sunrise Sample Farm', locationId: 'moses_lake', location: 'Moses Lake, WA', region: 'basin', role: 'owner', crops: ['Apples'], language: 'English', phone: '', address: '', priorityField: 'North orchard', acres: '', wind: '15', market: '5', briefTime: '06:30', scheduleEnabled: false, notificationPreference: 'off' }, fields: [], tasks: [{ id: 'sample-inspection', name: 'Inspect irrigation before field work', place: 'North orchard', workType: 'inspection', date: dateKey(), time: '', done: false }], theme: 'field', readingPreferences: { enabled: false, textSize: 'comfortable' }, updatedAt: stamp };
}

async function startPresenterDemoServer({ allowPaid = false, seedCapturedFarm = false, seedSnapshot = null, port = 0, fetchImpl = globalThis.fetch } = {}) {
  const container = memoryContainer(), requests = [], publicRequests = [], providerAudit = [], aiResults = [], provenance = [];
  const stamp = new Date().toISOString();
  container.put({ id: `account-${OWNER}`, userId: OWNER, type: 'account', email: EMAIL, identityProvider: 'aad', plan: 'free', joinedAt: stamp, lastSeenAt: stamp, request: null });
  container.put({ id: `state-${OWNER}`, userId: OWNER, type: 'state', state: defaultState() });
  if (seedSnapshot) {
    if (seedSnapshot.reviewOnly !== true || seedSnapshot.syntheticOwner !== OWNER || !Array.isArray(seedSnapshot.documents) || seedSnapshot.documents.length > 150 || JSON.stringify(seedSnapshot).length > 3000000) throw new Error('Only this capture server’s synthetic snapshot can be restored.');
    const types = new Set(['state', 'account', 'dailyBrief', 'fieldContext', 'satelliteContext', 'farmContext', 'aiUsage', 'aiBudget']);
    for (const doc of seedSnapshot.documents) {
      if (!doc || typeof doc.id !== 'string' || !types.has(doc.type) || (doc.userId !== OWNER && !(doc.type === 'aiBudget' && doc.userId === 'system-ai-budget-v1'))) throw new Error('Snapshot contains records outside the synthetic capture scope.');
      container.put(doc);
    }
    provenance.push(...(Array.isArray(seedSnapshot.provenance) ? clone(seedSnapshot.provenance.slice(0, 20)) : []), { source: 'same-demo-snapshot', capturedAt: seedSnapshot.capturedAt, timestampsPreserved: true });
  } else if (seedCapturedFarm) {
    const captured = JSON.parse(await fs.readFile(path.join(__dirname, 'demo-capture/evidence.json'), 'utf8'));
    if (captured.localSyntheticOwner !== true || captured.productionWrites !== false || captured.publicProviderData !== true || captured.state?.fields?.length !== 1) throw new Error('Captured sample farm provenance could not be verified.');
    const state = defaultState(); state.fields = clone(captured.state.fields); state.tasks[0].fieldId = state.fields[0].id;
    container.put({ id: `state-${OWNER}`, userId: OWNER, type: 'state', state });
    const field = state.fields[0], result = captured.satellite, time = Date.now();
    const freshPart = part => part && ['live', 'cached'].includes(part.status) && Number.isFinite(Date.parse(part.fetchedAt)) && time >= Date.parse(part.fetchedAt) && time - Date.parse(part.fetchedAt) <= 2 * 86400000 && Date.parse(part.validUntil) > time;
    const matching = result?.fieldId === field.id && result.locationKey === locationKey(field) && field.boundary && (field.landsatConsent === true || field.satelliteConsent === true);
    if (matching && ((field.landsatConsent && freshPart(result.landsat)) || (field.satelliteConsent && freshPart(result)))) {
      const { contextId } = require('../../api/shared/satellite');
      container.put({ id: contextId(OWNER, field.id), userId: OWNER, type: 'satelliteContext', version: 1, fieldId: field.id, locationKey: locationKey(field), fingerprint: createHash('sha256').update(JSON.stringify(field)).digest('hex'), result: clone(result) });
      provenance.push({ source: 'captured-public-satellite-cache', originalCapture: captured.createdAt, fetchedAt: result.fetchedAt, exactSavedField: true, newImageryRequest: false });
    } else provenance.push({ source: 'captured-satellite-omitted', reason: 'Source permissions, exact geometry or freshness did not qualify.' });
  }
  let ledger = null, secret = '', busy = false, server, closed = false;
  try {
    if (allowPaid === true) {
      ledger = await createAttemptLedger(path.join(__dirname, 'presenter-work'));
      // Only these two values enter a private closure; never mutate process.env.
      const parsed = parseEnv(await fs.readFile(path.join(root, '.env'), 'utf8'));
      if (!parsed.OPENAI_API_KEY || parsed.OPENAI_MODEL !== 'gpt-6.1-sol') throw new Error('The approved local AI configuration is unavailable.');
      secret = parsed.OPENAI_API_KEY;
    }
    const actionScope = new AsyncLocalStorage();
    const guardedFetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('Capture provider endpoint is not permitted.');
      if (parsed.hostname === 'api.openai.com') {
        const task = actionScope.getStore();
        if (allowPaid !== true || !ledger || !secret || !['daily', 'summary'].includes(task) || String(url) !== ENDPOINT || options.method !== 'POST') throw new Error('No authorized recording AI action is active.');
        if (typeof options.body !== 'string' || Buffer.byteLength(options.body) > MAX_REQUEST_BYTES) throw new Error('Recording model input exceeded its bound.');
        const body = JSON.parse(options.body), purpose = body.tools ? 'planner' : 'writer';
        if (body.store !== false || body.service_tier !== 'default' || body.max_output_tokens !== MAX_OUTPUT_TOKENS || body.reasoning?.effort !== 'low' || !route(task, 'auto').some(step => step.model === body.model && step.purpose === purpose)) throw new Error('Model call is outside the approved recording route.');
        const state = container.get(`state-${OWNER}`, OWNER)?.state;
        const markers = [secret, OWNER, EMAIL, state?.profile?.firstName, state?.profile?.farmName, ...(state?.fields || []).flatMap(field => [field.name, String(field.location?.latitude), String(field.location?.longitude)])].filter(value => typeof value === 'string' && value.length > 2);
        if (markers.some(value => options.body.includes(value))) throw new Error('Recording model input contains an excluded private identifier.');
        await ledger.provider(task, body.model, purpose);
        providerAudit.push({ task, model: body.model, purpose, inputBytes: Buffer.byteLength(options.body), time: new Date().toISOString(), attempted: true });
        return fetchImpl(url, { ...options, redirect: 'error' });
      }
      if (!PUBLIC_HOSTS.has(parsed.hostname) || publicRequests.length >= 300 || !['GET', 'POST', 'HEAD'].includes(options.method || 'GET') || (options.method === 'POST' && !['planetarycomputer.microsoft.com', 'earth-search.aws.element84.com'].includes(parsed.hostname))) throw new Error('This public data request is outside the bounded recording allowlist.');
      publicRequests.push({ host: parsed.hostname, path: parsed.pathname, time: new Date().toISOString() });
      // Existing weather code can inspect a manual redirect and revalidate its
      // next URL; never let fetch follow an uninspected host automatically.
      return fetchImpl(url, { ...options, redirect: options.redirect === 'manual' ? 'manual' : 'error' });
    };
    const getContainer = () => container;
    const weatherHandler = require('../../api/weather').createWeatherHandler({ fetchImpl: guardedFetch });
    const fieldDataService = require('../../api/shared/field-data').createFieldDataService({ getContainer, fetchImpl: guardedFetch, weatherHandler });
    const satelliteService = require('../../api/shared/satellite').createSatelliteService({ getContainer, fetchImpl: guardedFetch });
    // Context stays cache-only in this recording. No keys/new data services.
    const cachedContext = require('../../api/shared/farm-context').createFarmContextService({ getContainer, fetchImpl: guardedFetch, env: {} });
    const farmContextService = { readCachedFarmContext: (...args) => cachedContext.readCachedFarmContext(...args), getFarmContext: (...args) => cachedContext.readCachedFarmContext(...args) };
    const env = { AI_ENABLED: allowPaid === true ? 'true' : 'false', OPENAI_API_KEY: secret, OPENAI_MODEL: 'gpt-6.1-sol', AI_DAILY_BUDGET_USD: '1' };
    const handlers = {
      '/api/account': require('../../api/account').createAccountHandler({ getContainer }),
      '/api/state': require('../../api/state').createStateHandler({ getContainer }),
      '/api/weather': require('../../api/weather').createProtectedWeatherHandler({ getContainer, weatherHandler }),
      '/api/field-data': require('../../api/field-data').createFieldDataHandler({ getContainer, fieldDataService }),
      '/api/brief': require('../../api/brief').createBriefHandler({ getContainer, fetchImpl: guardedFetch, fieldDataService, satelliteService, farmContextService }),
      '/api/field-satellite': require('../../api/field-satellite').createSatelliteHandler({ getContainer, satelliteService }),
      '/api/ai-brief': createAiBriefHandler({ getContainer, env, fetchImpl: guardedFetch, weatherHandler, satelliteService, farmContextService })
    };
    const globalHeaders = JSON.parse(await fs.readFile(path.join(root, 'staticwebapp.config.json'), 'utf8')).globalHeaders;
    const principal = { userId: OWNER, userDetails: EMAIL, identityProvider: 'aad', userRoles: ['authenticated'] };
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(status === 204 || body === undefined ? '' : JSON.stringify(body)); }
    let base;
    server = http.createServer(async (req, res) => {
      try {
        for (const [name, value] of Object.entries(globalHeaders)) res.setHeader(name, value);
        if (req.headers.host !== new URL(base).host || (req.headers.origin && req.headers.origin !== base) || req.headers['sec-fetch-site'] === 'cross-site') throw safeError(403, 'Use the isolated local recording tab.');
        const url = new URL(req.url, base);
        if (url.pathname === '/.auth/me') { json(res, 200, { clientPrincipal: principal }); return; }
        if (url.pathname.startsWith('/api/')) {
          const handler = handlers[url.pathname];
          if (!handler) throw safeError(503, 'Not connected in this sample-farm recording. No external accounts or messages are used.');
          if (!['GET', 'POST', 'PUT'].includes(req.method) || (url.pathname !== '/api/state' && req.method === 'PUT')) throw safeError(405, 'This operation is not part of the recording.');
          let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 600000) throw safeError(413, 'Recording request is too large.'); }
          let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { throw safeError(400, 'Expected a JSON request.'); }
          const context = { log: { error() {}, warn() {} } }, input = { method: req.method, headers: { ...req.headers, 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64') }, query: Object.fromEntries(url.searchParams), body };
          if (url.pathname === '/api/ai-brief' && req.method === 'POST') {
            if (allowPaid !== true || !ledger) throw safeError(403, 'Paid recording actions are not authorized. No model request was made.');
            requestBody(body);
            if (body.mode !== 'auto' || !['daily', 'summary'].includes(body.task)) throw safeError(400, 'This recording permits only one Auto daily message and one Auto summary.');
            if (busy) throw safeError(409, 'Wait for the current recording action.');
            busy = true;
            try {
              await ledger.action(body.task);
              await actionScope.run(body.task, () => handler(context, input));
              aiResults.push({ task: body.task, status: context.res.status, time: new Date().toISOString(), result: clone(context.res.body) });
            } finally { busy = false; }
          } else await handler(context, input);
          requests.push({ route: url.pathname, method: req.method, status: context.res?.status, time: new Date().toISOString() });
          json(res, context.res.status, context.res.body); return;
        }
        if (req.method !== 'GET') throw safeError(405, 'Read-only static files.');
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
        if ((!/^[A-Za-z0-9_-]+\.(html|js|css|webmanifest)$/.test(relative) && !/^(icons|vendor)\/[A-Za-z0-9_./-]+\.(png|svg|js|css)$/.test(relative)) || relative.includes('..')) throw safeError(404, 'Not found');
        const file = path.resolve(root, relative); if (!file.startsWith(root + path.sep)) throw safeError(404, 'Not found');
        let bytes; try { bytes = await fs.readFile(file); } catch { throw safeError(404, 'Not found'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
      } catch (error) {
        // Never emit provider errors, .env text, keys or request bodies.
        if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : 'The bounded local recording request could not complete. No automatic retry was made.' });
        else res.end();
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const close = async () => { if (closed) return; closed = true; if (server.listening) await new Promise(resolve => server.close(resolve)); secret = ''; env.OPENAI_API_KEY = ''; await ledger?.close(); };
    return { base, server, container, owner: OWNER, fieldDataService, satelliteService, publicRequests, requests, aiResults, providerAudit, provenance,
      state: () => clone(container.get(`state-${OWNER}`, OWNER)?.state),
      brief: () => clone([...container.docs.values()].filter(doc => doc.type === 'dailyBrief').sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.brief),
      budget: () => ledger?.status() || { authorized: false, maximumUsd: 1, maximumProviderCalls: 3 },
      snapshot: () => ({ reviewOnly: true, syntheticOwner: OWNER, capturedAt: new Date().toISOString(), sourceVersion: require('../../package.json').version, documents: [...container.docs.values()].map(clone), provenance: clone(provenance) }), close };
  } catch {
    if (server?.listening) await new Promise(resolve => server.close(resolve)); await ledger?.close().catch(() => {}); secret = '';
    throw new Error('The isolated recording server could not start. No secret details were logged.');
  }
}

module.exports = { startPresenterDemoServer, createAttemptLedger, OWNER };
if (require.main === module) {
  const allowPaid = process.argv.includes('--approve-paid-recording');
  startPresenterDemoServer({ allowPaid, seedCapturedFarm: process.argv.includes('--seed-captured-farm') }).then(app => {
    console.log(JSON.stringify({ base: app.base, sampleFarmOnly: true, paidAuthorized: allowPaid, budget: app.budget(), provenance: app.provenance }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  }).catch(() => { console.error('Recording server unavailable. No credentials or raw provider errors were logged.'); process.exitCode = 1; });
}
