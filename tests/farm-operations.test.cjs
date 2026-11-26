require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFarmOperationsHandler } = require('../api/farm-operations');
const { applyOperation, emptyOperations, exportFarmOperations, pruneFarmOperations, MAX_OPERATIONS_BYTES } = require('../api/shared/farm-operations');

const NOW = Date.parse('2026-10-13T18:00:00Z'), OWNER = 'operations-owner';
const clone = value => structuredClone(value);
const failure = code => Object.assign(new Error('Secret provider detail must never reach response'), { code });
const baseState = () => ({ profile: { firstName: 'Private farmer' }, fields: [{ id: 'field-a', name: 'Private orchard', crop: 'Apples' }], tasks: [] });
const equipment = patch => ({ name: 'North drip system', kind: 'irrigation', fieldId: 'field-a', irrigationType: 'Drip', notes: 'Private maintenance note', serviceDate: '2026-10-15', ...patch });
const knowledge = patch => ({ title: 'Private checklist', fieldId: 'field-a', kind: 'sop', text: 'Check the manufacturer manual before starting.', ...patch });
const reading = patch => ({ fieldId: 'field-a', sensorId: 'soil-1', metric: 'soil_moisture', unit: 'percent', value: 27.3, observedAt: '2026-10-13T10:00:00-07:00', source: 'manual', ...patch });

function fixture({ applyWorkflow } = {}) {
  const documents = new Map(), accesses = [], batches = [];
  let version = 0, timestamp = NOW, batchHook, forcedBatch;
  const key = (id, userId) => `${userId}/${id}`;
  function save(document) { const resource = { ...clone(document), _etag: String(++version) }; documents.set(key(resource.id, resource.userId), resource); return { resource: clone(resource) }; }
  const container = { item(id, userId) { accesses.push({ id, userId }); return {
    async read() { const d = documents.get(key(id, userId)); if (!d) throw failure(404); return { resource: clone(d) }; },
    async delete(options) { const d = documents.get(key(id, userId)); if (!d) throw failure(404); assert.equal(options?.accessCondition?.condition, d._etag); documents.delete(key(id, userId)); },
    async replace(document, options) { const d = documents.get(key(id, userId)); if (!d) throw failure(404); if (options?.accessCondition?.condition !== d._etag) throw failure(412); return save(document); }
  }; }, items: {
    async create(document) { if (documents.has(key(document.id, document.userId))) throw failure(409); return save(document); },
    async batch(operations, userId) {
      batches.push(clone(operations));
      if (batchHook) { const hook = batchHook; batchHook = null; await hook(); }
      if (forcedBatch) return clone(forcedBatch);
      for (const operation of operations) {
        assert.equal(operation.resourceBody.userId, userId);
        const current = documents.get(key(operation.id || operation.resourceBody.id, userId));
        if (operation.operationType === 'Create' && current) throw failure(409);
        if (operation.operationType === 'Replace' && (!current || current._etag !== operation.ifMatch)) throw failure(current ? 412 : 404);
      }
      return { code: 200, result: operations.map(operation => ({ statusCode: 200, resourceBody: save(operation.resourceBody).resource })) };
    }
  } };
  function account(userId = OWNER, patch = {}) { return { id: `account-${userId}`, userId, type: 'account', email: userId === 'admin' ? 'admin1@example.invalid' : 'farmer@example.test', identityProvider: 'aad', plan: 'premium', request: { status: 'approved' }, ...patch }; }
  save(account());
  save({ id: `state-${OWNER}`, userId: OWNER, type: 'state', state: baseState() });
  const handler = createFarmOperationsHandler({ getContainer: () => container, now: () => timestamp, applyWorkflow });
  const current = id => clone(documents.get(key(id, OWNER)));
  async function call(method = 'GET', body, { userId = OWNER, headers = {}, identity = {}, query = {} } = {}) {
    const context = { log: { error() {} } };
    const principal = { userId, userDetails: userId === 'admin' ? 'admin1@example.invalid' : 'farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'], ...identity };
    await handler(context, { method, body, query, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...(userId ? { 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64'), 'x-farmer-account-id': userId } : {}), ...headers } });
    return context.res;
  }
  async function action(action, payload, options) { return call('POST', { action, payload, revision: current(`operations-${OWNER}`)?._etag || null }, options); }
  return { documents, accesses, batches, container, save, account, call, action, state: () => current(`state-${OWNER}`), operations: () => current(`operations-${OWNER}`), hook: fn => { batchHook = fn; }, setNow: value => { timestamp = value; }, setBatch: value => { forcedBatch = value; } };
}

test('operations require trusted identity, current account header and approved Premium; administrators see only their own records', async () => {
  const f = fixture();
  assert.equal((await f.call('GET', null, { userId: null })).status, 401);
  assert.equal((await f.call('GET', null, { identity: { identityProvider: 'google' } })).status, 401);
  assert.equal((await f.call('GET', null, { headers: { 'x-farmer-account-id': '' } })).status, 409);
  assert.equal((await f.call('GET', null, { headers: { 'x-farmer-account-id': 'another-owner' } })).status, 409);
  f.save(f.account(OWNER, { plan: 'free', request: null }));
  assert.equal((await f.call('GET')).status, 403);
  f.save(f.account(OWNER, { plan: 'premium', request: { status: 'pending' } }));
  assert.equal((await f.call('GET')).status, 403);
  f.save(f.account(OWNER, { plan: 'free', request: null }));
  assert.equal((await f.call('GET', null, { identity: { userRoles: ['authenticated', 'farmer', 'admin'] } })).status, 403);
  f.save(f.account());
  await f.action('saveEquipment', equipment());
  f.save(f.account('admin', { plan: 'free', request: null }));
  f.save({ id: 'state-admin', userId: 'admin', type: 'state', state: baseState() });
  const admin = await f.call('GET', null, { userId: 'admin', query: { userId: OWNER } });
  assert.equal(admin.status, 200); assert.equal(admin.body.operations.equipment.length, 0);
  assert.equal(admin.headers['Cache-Control'], 'no-store');
});

test('empty operations are a read-only owner view; a saved farm profile is required', async () => {
  const f = fixture(), response = await f.call();
  assert.equal(response.status, 200); assert.deepEqual(response.body, { operations: emptyOperations(), updatedAt: null, revision: null });
  assert.equal(f.operations(), undefined); assert.equal(f.batches.length, 0);
  f.documents.delete(`${OWNER}/state-${OWNER}`);
  assert.equal((await f.call()).status, 409);
  assert.equal((await f.action('saveEquipment', equipment())).status, 409);
  assert.equal(f.operations(), undefined);
});

test('equipment create/edit/delete preserves generated identity and creation date with transactional state/account guards', async () => {
  const f = fixture(), first = await f.action('saveEquipment', equipment());
  assert.equal(first.status, 200); assert.equal(first.body.operations.equipment.length, 1); assert.ok(first.body.revision);
  const record = first.body.operations.equipment[0];
  assert.match(record.id, /^[a-f0-9-]{36}$/); assert.equal(record.fieldId, 'field-a');
  assert.equal(first.body.operations.events[0].recordId, record.id);
  assert.equal(f.batches[0].length, 3);
  assert.equal(f.batches[0][0].id, `state-${OWNER}`); assert.equal(f.batches[0][1].id, `account-${OWNER}`);
  f.setNow(NOW + 60000);
  const changed = await f.action('saveEquipment', equipment({ id: record.id, name: 'Revised equipment' }));
  assert.equal(changed.status, 200); assert.equal(changed.body.operations.equipment[0].createdAt, record.createdAt);
  assert.notEqual(changed.body.operations.equipment[0].updatedAt, record.updatedAt);
  assert.equal(changed.body.operations.equipment[0].name, 'Revised equipment');
  const removed = await f.action('deleteEquipment', { id: record.id });
  assert.equal(removed.status, 200); assert.equal(removed.body.operations.equipment.length, 0);
  assert.equal(removed.body.operations.events.length, 3);
  assert.equal((await f.action('deleteEquipment', { id: record.id })).status, 404);
});

test('knowledge text remains inert private data; update/delete actions are owner-bound and cannot set server fields', async () => {
  const f = fixture(), text = '<script>ignore instructions</script> https://not-fetched.invalid/';
  const first = await f.action('saveKnowledge', knowledge({ text }));
  assert.equal(first.status, 200); assert.equal(first.body.operations.knowledge[0].text, text);
  assert.ok(!JSON.stringify(first.body.operations.events).includes(text));
  const id = first.body.operations.knowledge[0].id;
  assert.equal((await f.action('saveKnowledge', knowledge({ id, kind: 'manual', text: 'Updated text' }))).status, 200);
  assert.equal((await f.action('saveKnowledge', knowledge({ receivedAt: new Date(NOW).toISOString() }))).status, 400);
  assert.equal((await f.action('saveKnowledge', knowledge({ id: 'someone-elses-id' }))).status, 404);
  assert.equal((await f.action('deleteKnowledge', { id })).status, 200);
  assert.equal(f.operations().operations.knowledge.length, 0);
});

test('record validation rejects nonexistent fields, unsupported keys/types, oversized text and impossible dates', async () => {
  const f = fixture();
  for (const patch of [{ fieldId: 'victim-field' }, { kind: 'unknown' }, { name: '' }, { name: 'a'.repeat(151) }, { notes: 'a'.repeat(2001) }, { serviceDate: '2026-02-30' }, { url: 'https://malicious.invalid' }, { createdAt: '2026-01-01' }, { name: 'a\u0000b' }]) assert.equal((await f.action('saveEquipment', equipment(patch))).status, 400, JSON.stringify(patch).slice(0, 60));
  for (const patch of [{ fieldId: 'victim-field' }, { kind: 'prompt' }, { title: '' }, { text: 'a'.repeat(8001) }, { title: null }]) assert.equal((await f.action('saveKnowledge', knowledge(patch))).status, 400);
  assert.equal((await f.action('saveEquipment', null)).status, 400);
  assert.equal((await f.action('saveKnowledge', [])).status, 400);
  assert.equal((await f.action('saveEquipment', equipment({ fieldId: '', serviceDate: '' }))).status, 200);
});

test('sensor imports normalize time zones, validate source/unit, retain provenance and never pretend to be live telemetry', async () => {
  const f = fixture(), response = await f.action('importReadings', { readings: [reading(), reading({ sensorId: 'temp', metric: 'air_temperature', unit: 'F', value: 58.1, source: 'csv' }), reading({ sensorId: 'rain', metric: 'rainfall', unit: 'mm', value: 2 }), reading({ sensorId: 'battery', metric: 'battery', unit: 'percent', value: 75 })] });
  assert.equal(response.status, 200); assert.equal(response.body.result.added, 4);
  const records = response.body.operations.readings;
  assert.equal(records[0].observedAt, '2026-10-13T17:00:00.000Z'); assert.equal(records[0].receivedAt, '2026-10-13T18:00:00.000Z');
  assert.equal(records[0].source, 'manual'); assert.equal(records[1].source, 'csv');
  assert.ok(records.every(record => record.batchId === response.body.result.batchId));
  assert.equal(new Set(records.map(record => record.id)).size, 4);
  assert.ok(!JSON.stringify(response.body).includes('live'));
});

test('sensor deduplication skips identical observations but never overwrites conflicting measurements', async () => {
  const f = fixture();
  let response = await f.action('importReadings', { readings: [reading(), reading({ observedAt: '2026-10-13T17:00:00Z', source: 'csv' })] });
  assert.equal(response.status, 200); assert.equal(response.body.result.added, 1); assert.equal(response.body.result.duplicates, 1);
  response = await f.action('importReadings', { readings: [reading()] });
  assert.equal(response.body.result.added, 0); assert.equal(response.body.result.duplicates, 1);
  const before = f.operations();
  response = await f.action('importReadings', { readings: [reading({ sensorId: 'new' }), reading({ value: 99 })] });
  assert.equal(response.status, 409); assert.deepEqual(f.operations(), before);
});

test('reading batch deletion is owner scoped, audited and lets farmers correct an import without deleting their farm', async () => {
  const f = fixture();
  const first = await f.action('importReadings', { readings: [reading(), reading({ sensorId: 'sensor-2' })] });
  await f.action('importReadings', { readings: [reading({ sensorId: 'sensor-3' })] });
  assert.equal((await f.action('deleteReadingsBatch', { batchId: 'other-owner-batch' })).status, 404);
  const response = await f.action('deleteReadingsBatch', { batchId: first.body.result.batchId });
  assert.equal(response.status, 200); assert.equal(response.body.result.removed, 2);
  assert.equal(response.body.operations.readings.length, 1); assert.equal(response.body.operations.readings[0].sensorId, 'sensor-3');
  assert.equal(response.body.operations.events.at(-1).action, 'deleteReadingsBatch');
  assert.equal(response.body.operations.events.at(-1).removed, 2);
  assert.equal((await f.action('importReadings', { readings: [reading({ value: 99 })] })).status, 200);
});

test('invalid, future, impossible, timezone-free and physically inconsistent readings cannot be imported', async () => {
  const f = fixture();
  const bad = [{ fieldId: '' }, { fieldId: 'unknown' }, { sensorId: '' }, { value: '42' }, { value: NaN }, { value: Infinity }, { value: -1 }, { value: 101 }, { metric: '__proto__' }, { metric: ['soil_moisture'] }, { metric: {} }, { unit: 'C' }, { source: 'live' }, { observedAt: '2026-10-14T18:00:00Z' }, { observedAt: '2026-02-30T18:00:00Z' }, { observedAt: '2026-10-13T10:00:00' }, { observedAt: 'tomorrow' }, { observedAt: '1969-01-01T00:00:00Z' }, { metric: 'rainfall', unit: 'mm', value: 2001 }, { metric: 'air_temperature', unit: 'F', value: -101 }, { value: 10, url: 'https://evil.invalid' }, { receivedAt: new Date(NOW).toISOString() }];
  for (const patch of bad) assert.equal((await f.action('importReadings', { readings: [reading(patch)] })).status, 400, JSON.stringify(patch));
  assert.equal(f.operations(), undefined);
  for (const readings of [[], null, {}, Array.from({ length: 101 }, () => reading())]) assert.equal((await f.action('importReadings', { readings })).status, 400);
});

test('operations limits bound equipment, knowledge, sensor records, import batches and server audit history', () => {
  const state = baseState(); let operations = emptyOperations();
  const apply = (action, payload) => { operations = applyOperation({ operations, state, action, payload, now: NOW }).operations; };
  for (let i = 0; i < 40; i++) apply('saveEquipment', equipment({ name: `Equipment ${i}` }));
  assert.throws(() => apply('saveEquipment', equipment()), error => error.status === 400);
  for (let i = 0; i < 30; i++) apply('saveKnowledge', knowledge({ title: `Manual ${i}` }));
  assert.throws(() => apply('saveKnowledge', knowledge()), error => error.status === 400);
  for (let batch = 0; batch < 5; batch++) apply('importReadings', { readings: Array.from({ length: 100 }, (_, i) => reading({ sensorId: `sensor-${batch}-${i}` })) });
  assert.equal(operations.readings.length, 500);
  assert.throws(() => apply('importReadings', { readings: [reading({ sensorId: 'extra' })] }), error => error.status === 400);
  const id = operations.equipment[0].id;
  for (let i = 0; i < 105; i++) apply('saveEquipment', equipment({ id }));
  assert.equal(operations.events.length, 100); assert.equal(new Set(operations.events.map(event => event.id)).size, 100);
});

test('operations total UTF-8 byte budget is enforced without partial changes', async () => {
  const f = fixture();
  const operations = emptyOperations();
  operations.knowledge = Array.from({ length: 18 }, (_, i) => ({ id: `k${i}`, fieldId: '', title: 'Manual', kind: 'manual', text: '水'.repeat(7500) }));
  f.save({ id: `operations-${OWNER}`, userId: OWNER, type: 'farmOperations', operations });
  const before = f.operations();
  assert.ok(Buffer.byteLength(JSON.stringify(operations), 'utf8') < MAX_OPERATIONS_BYTES);
  const result = await f.action('saveKnowledge', knowledge({ text: '水'.repeat(8000) }));
  assert.equal(result.status, 413); assert.deepEqual(f.operations(), before);
});

test('write requests reject stale/missing revisions, cross-site origins, form encoding and client ownership overrides', async () => {
  const f = fixture();
  await f.action('saveEquipment', equipment());
  const valid = { action: 'saveEquipment', payload: equipment(), revision: f.operations()._etag };
  assert.equal((await f.call('POST', { ...valid, revision: null })).status, 409);
  assert.equal((await f.call('POST', { action: valid.action, payload: valid.payload })).status, 400);
  assert.equal((await f.call('POST', { ...valid, userId: 'victim' })).status, 400);
  assert.equal((await f.call('POST', valid, { headers: { origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.call('POST', valid, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.call('POST', valid, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('DELETE')).status, 405);
  assert.equal((await f.action('inventedAction', {})).status, 400);
  assert.equal(f.operations().operations.equipment.length, 1);
});

test('concurrent farm edits, deletion, approval revocation and operations edits abort the entire write without automatic replay', async () => {
  for (const race of ['state-edit', 'state-delete', 'approval', 'operations']) {
    const f = fixture();
    await f.action('saveEquipment', equipment());
    const before = f.operations(), initialBatches = f.batches.length;
    f.hook(() => {
      if (race === 'state-edit') { const doc = f.state(); doc.state.fields[0].name = 'Edited field'; f.save(doc); }
      if (race === 'state-delete') f.documents.delete(`${OWNER}/state-${OWNER}`);
      if (race === 'approval') f.save(f.account(OWNER, { plan: 'free', request: { status: 'declined' } }));
      if (race === 'operations') { const doc = f.operations(); doc.operations.equipment[0].name = 'Concurrent equipment'; f.save(doc); }
    });
    const result = await f.action('saveKnowledge', knowledge());
    assert.equal(result.status, 409, race); assert.equal(f.batches.length, initialBatches + 1);
    assert.equal(f.operations().operations.knowledge.length, 0);
    if (race !== 'operations') assert.deepEqual(f.operations(), before);
  }
});

test('first creation conflict and failed transactional response fail safely with no partial records', async () => {
  const f = fixture();
  f.hook(() => f.save({ id: `operations-${OWNER}`, userId: OWNER, type: 'farmOperations', operations: emptyOperations() }));
  assert.equal((await f.action('saveEquipment', equipment())).status, 409);
  assert.equal(f.operations().operations.equipment.length, 0);
  for (const response of [{ code: 200, result: [{ statusCode: 424 }, { statusCode: 412 }, { statusCode: 424 }] }, { code: 500, result: [] }, {}]) {
    const broken = fixture(); broken.setBatch(response);
    const result = await broken.action('saveEquipment', equipment());
    assert.equal(result.status, response.result?.some(item => item.statusCode === 412) ? 409 : 503);
    assert.equal(broken.operations(), undefined);
    assert.ok(!JSON.stringify(result).includes('Secret provider detail'));
  }
});

test('workflow orchestration atomically saves operations and tasks, increments server metadata, returns browser sync revision and records an event', async () => {
  let received;
  const f = fixture({ applyWorkflow(input) {
    received = input;
    input.operations.workflows.push({ id: 'workflow-1', kind: 'create_task', status: 'executed' });
    input.state.tasks.push({ id: 'server-task', name: 'Scout north block', date: '2026-10-14', fieldId: 'field-a', done: false });
    return { operations: input.operations, state: input.state, result: { workflowId: 'workflow-1', message: 'Task created; nothing was sent externally.' } };
  } });
  f.save({ ...f.state(), workflowRevision: 5 });
  const result = await f.action('executeWorkflow', { id: 'workflow-1' });
  assert.equal(result.status, 200); assert.equal(received.now, NOW);
  assert.equal(result.body.state.tasks.length, 1); assert.equal(result.body.state.workflowRevision, 6);
  assert.equal(f.state().workflowRevision, 6); assert.equal(f.state().state.workflowRevision, undefined);
  assert.equal(f.operations().operations.events[0].workflowId, 'workflow-1');
  assert.equal(f.operations().operations.events[0].action, 'executeWorkflow');
  assert.equal(f.operations().operations.events[0].message, undefined);
});

test('workflow proposals that do not change tasks preserve task sync revision; concurrent edits prevent task creation', async () => {
  const proposal = fixture({ applyWorkflow({ operations, state }) { operations.workflows.push({ id: 'proposed' }); return { operations, state, result: { id: 'proposed' } }; } });
  proposal.save({ ...proposal.state(), workflowRevision: 2 });
  const response = await proposal.action('proposeWorkflow', { kind: 'create_task', title: 'Inspect' });
  assert.equal(response.status, 200); assert.equal(response.body.state.workflowRevision, 2); assert.equal(proposal.state().workflowRevision, 2);
  const race = fixture({ applyWorkflow({ operations, state }) { state.tasks.push({ id: 'new', name: 'New' }); operations.workflows.push({ id: 'new' }); return { operations, state, result: {} }; } });
  race.hook(() => { const state = race.state(); state.state.tasks.push({ id: 'elsewhere', name: 'Concurrent task' }); race.save(state); });
  assert.equal((await race.action('executeWorkflow', { id: 'new' })).status, 409);
  assert.equal(race.operations(), undefined); assert.equal(race.state().state.tasks.length, 1); assert.equal(race.state().state.tasks[0].id, 'elsewhere');
});

test('replaying an executed workflow returns the prior result without another audit event or transaction', async () => {
  const f = fixture({ applyWorkflow({ operations, state }) { return { operations, state, result: { id: 'existing', alreadyExecuted: true, message: 'Previously completed.' } }; } });
  await f.action('saveEquipment', equipment());
  const before = f.operations(), count = f.batches.length;
  const result = await f.action('executeWorkflow', { id: 'existing' });
  assert.equal(result.status, 200); assert.equal(result.body.result.alreadyExecuted, true);
  assert.deepEqual(f.operations(), before); assert.equal(f.batches.length, count);
});

test('workflow-generated task records pass the same validation as ordinary farm tasks', async () => {
  const f = fixture({ applyWorkflow({ operations, state }) { state.tasks.push({ id: 'bad', name: 'Invalid', date: '2026-02-30' }); return { operations, state, result: {} }; } });
  assert.equal((await f.action('executeWorkflow', { id: 'bad' })).status, 400);
  assert.equal(f.state().state.tasks.length, 0); assert.equal(f.operations(), undefined);
});

test('private export includes historical records but strips storage metadata; full deletion never touches another owner', async () => {
  const f = fixture();
  await f.action('saveKnowledge', knowledge()); await f.action('importReadings', { readings: [reading()] });
  const state = f.state(); state.state.fields = []; f.save(state);
  const exported = await exportFarmOperations(f.container, OWNER);
  assert.equal(exported.operations.knowledge.length, 1); assert.equal(exported.operations.readings.length, 1);
  assert.equal(exported.userId, undefined); assert.equal(exported._etag, undefined); assert.equal(exported.revision, undefined);
  assert.equal(await exportFarmOperations(f.container, 'other'), null);
  f.save({ ...f.operations(), id: 'operations-other', userId: 'other' });
  await pruneFarmOperations(f.container, OWNER);
  assert.equal(f.operations(), undefined); assert.ok(f.documents.has('other/operations-other'));
  assert.ok(f.state());
  await pruneFarmOperations(f.container, OWNER);
});

test('corrupt or misbound storage records are not returned as another owner’s farm data', async () => {
  const f = fixture();
  f.documents.set(`${OWNER}/operations-${OWNER}`, { id: `operations-${OWNER}`, userId: 'victim', type: 'farmOperations', operations: emptyOperations() });
  const result = await f.call(); assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes('victim'));
});

test('real workflow API prepares, approves and replays a task once, then reschedules it with a new task revision', async () => {
  const f = fixture();
  const proposed = await f.action('proposeWorkflow', { kind: 'create_task', fieldId: 'field-a', title: 'Check north irrigation', date: '2026-10-14', time: '08:30' });
  assert.equal(proposed.status, 200); assert.equal(proposed.body.operations.workflows[0].status, 'pending');
  assert.equal(f.state().state.tasks.length, 0); assert.equal(f.state().workflowRevision, undefined);
  const id = proposed.body.result.id;
  const executed = await f.action('executeWorkflow', { id });
  assert.equal(executed.status, 200); assert.equal(executed.body.state.workflowRevision, 1);
  assert.equal(executed.body.state.tasks.length, 1); assert.equal(executed.body.result.task.name, 'Check north irrigation');
  assert.equal(executed.body.operations.workflows[0].status, 'executed');
  const eventCount = executed.body.operations.events.length, revision = executed.body.revision;
  const replay = await f.action('executeWorkflow', { id });
  assert.equal(replay.status, 200); assert.equal(replay.body.result.alreadyExecuted, true);
  assert.equal(replay.body.revision, revision); assert.equal(replay.body.operations.events.length, eventCount);
  assert.equal(f.state().state.tasks.length, 1);
  const reschedule = await f.action('proposeWorkflow', { kind: 'reschedule_task', taskId: executed.body.result.taskId, date: '2026-10-15', time: '15:00' });
  assert.equal(reschedule.status, 200);
  const done = await f.action('executeWorkflow', { id: reschedule.body.result.id });
  assert.equal(done.status, 200); assert.equal(done.body.state.workflowRevision, 2);
  assert.equal(done.body.state.tasks.length, 1); assert.equal(done.body.state.tasks[0].date, '2026-10-15');
});

test('real record/draft workflows store only reviewed private results; cancelled or stale proposals cannot run', async () => {
  const f = fixture();
  for (const payload of [{ kind: 'prepare_record', title: 'Irrigation inspection', text: 'Farmer-entered inspection record', fieldId: 'field-a' }, { kind: 'draft_message', title: 'Harvest question', text: 'Farmer-reviewed message', recipient: 'buyer@example.test' }]) {
    const proposal = await f.action('proposeWorkflow', payload);
    assert.equal(proposal.status, 200); assert.equal(proposal.body.operations.workflows.at(-1).result, undefined);
    const completed = await f.action('executeWorkflow', { id: proposal.body.result.id });
    assert.equal(completed.status, 200); assert.equal(completed.body.state.tasks.length, 0);
    assert.equal(completed.body.state.workflowRevision, 0);
    assert.ok(completed.body.result.record || completed.body.result.draft);
  }
  let proposal = await f.action('proposeWorkflow', { kind: 'create_task', title: 'Scout', date: '2026-10-14' });
  assert.equal((await f.action('cancelWorkflow', { id: proposal.body.result.id })).status, 200);
  assert.equal((await f.action('executeWorkflow', { id: proposal.body.result.id })).status, 409);
  proposal = await f.action('proposeWorkflow', { kind: 'create_task', fieldId: 'field-a', title: 'Scout', date: '2026-10-14' });
  const state = f.state(); state.state.fields[0].crop = 'Pears'; f.save(state);
  assert.equal((await f.action('executeWorkflow', { id: proposal.body.result.id })).status, 409);
  assert.equal(f.state().state.tasks.length, 0);
});

test('explicit workflow history deletion is owner scoped and audited without removing an approved task', async () => {
  const f = fixture();
  const proposed = await f.action('proposeWorkflow', { kind: 'create_task', fieldId: 'field-a', title: 'Keep this task', date: '2026-10-14' });
  const id = proposed.body.result.id;
  assert.equal((await f.action('deleteWorkflow', { id })).status, 409);
  assert.equal((await f.action('deleteWorkflow', { id: 'other-owner-workflow' })).status, 404);
  const approved = await f.action('executeWorkflow', { id });
  const savedTasks = clone(approved.body.state.tasks), taskRevision = approved.body.state.workflowRevision;
  const deleted = await f.action('deleteWorkflow', { id });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.operations.workflows.length, 0);
  assert.deepEqual(deleted.body.state.tasks, savedTasks); assert.equal(deleted.body.state.workflowRevision, taskRevision);
  assert.equal(deleted.body.operations.events.at(-1).action, 'deleteWorkflow');
  assert.equal(deleted.body.operations.events.at(-1).recordId, id);
  assert.equal((await f.action('executeWorkflow', { id })).status, 404);
});
