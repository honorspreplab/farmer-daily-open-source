const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startPresenterDemoServer, createAttemptLedger, OWNER } = require('../submission/2026/presenter-demo-server.cjs');

test('presenter server is loopback-only, default disabled, and cannot expose recordings or secrets', async () => {
  let external = 0;
  const app = await startPresenterDemoServer({ fetchImpl: async () => { external++; throw new Error('No external test requests'); } });
  try {
    assert.match(app.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { 'x-farmer-account-id': OWNER };
    const account = await (await fetch(app.base + '/api/account')).json(); assert.equal(account.user.id, OWNER);
    const state = await (await fetch(app.base + '/api/state', { headers })).json(); assert.equal(state.profile.farmName, 'Sunrise Sample Farm'); assert.equal(state.fields.length, 0);
    const preview = await (await fetch(app.base + '/api/ai-brief', { headers })).json(); assert.equal(preview.enabled, false); assert.equal(preview.available, false);
    const paid = await fetch(app.base + '/api/ai-brief', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: app.base }, body: '{}' }); assert.equal(paid.status, 403);
    for (const route of ['/.env', '/submission/2026/presenter-script.json', '/submission/2026/voice-work/narration-edited.wav', '/package.json']) assert.equal((await fetch(app.base + route)).status, 404, route);
    assert.equal((await fetch(app.base + '/api/shared/store.js')).status, 503, 'API source cannot be downloaded as static code');
    assert.equal((await fetch(app.base + '/index.html')).status, 200);
    assert.equal((await fetch(app.base + '/api/messaging')).status, 503);
    assert.equal((await fetch(app.base + '/api/state', { headers: { ...headers, origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal(external, 0); assert.deepEqual(app.providerAudit, []); assert.equal(app.budget().authorized, false);
  } finally { await app.close(); }
});

test('synthetic snapshots preserve exact field/cache documents across phases', async () => {
  const original = await startPresenterDemoServer();
  let snapshot;
  try {
    original.container.put({ id: 'sample-elevation', userId: OWNER, type: 'fieldContext', fieldId: 'field-sample', elevation: { feet: 1, fetchedAt: '2026-10-24T12:00:00Z' } });
    snapshot = original.snapshot();
  } finally { await original.close(); }
  const restored = await startPresenterDemoServer({ seedSnapshot: snapshot });
  try {
    assert.deepEqual(restored.container.get('sample-elevation', OWNER).elevation, { feet: 1, fetchedAt: '2026-10-24T12:00:00Z' });
    assert.equal(restored.provenance[0].timestampsPreserved, true);
  } finally { await restored.close(); }
  await assert.rejects(startPresenterDemoServer({ seedSnapshot: { ...snapshot, syntheticOwner: 'other-owner' } }), /synthetic/);
});

test('persistent recording ledger allows daily+summary only once and at most three bounded provider calls', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'farmer-presenter-ledger-'));
  let ledger;
  try {
    ledger = await createAttemptLedger(directory);
    await assert.rejects(createAttemptLedger(directory), /locked/);
    await ledger.action('daily');
    await ledger.provider('daily', 'gpt-6.1-sol', 'planner');
    await ledger.provider('daily', 'gpt-6.1-sol', 'writer');
    assert.equal(ledger.status().providerCalls, 2);
    await ledger.close(); ledger = await createAttemptLedger(directory);
    await assert.rejects(ledger.action('daily'), /limit/);
    await ledger.action('summary'); await ledger.provider('summary', 'gpt-6-luna', 'writer');
    await assert.rejects(ledger.provider('summary', 'gpt-6-luna', 'writer'), /limit/);
    assert.equal(ledger.status().providerCalls, 3); assert.ok(ledger.status().reservedUsd <= 1); assert.equal(ledger.status().actions.length, 2);
    await ledger.close(); ledger = null;
    const contents = await fs.readFile(path.join(directory, 'ai-recording-attempts.jsonl'), 'utf8'); assert.doesNotMatch(contents, /Bearer|OPENAI_API_KEY|farmName|evidence|answer/);
  } finally { await ledger?.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
});

test('recording ledger fails closed on incomplete writes or invalid stored accounting', async () => {
  for (const contents of ['{"version":1', '{"version":1,"type":"action","task":"daily","reservedMicros":0}\n']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'farmer-presenter-ledger-'));
    try { await fs.writeFile(path.join(directory, 'ai-recording-attempts.jsonl'), contents); await assert.rejects(createAttemptLedger(directory)); }
    finally { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
  }
});
