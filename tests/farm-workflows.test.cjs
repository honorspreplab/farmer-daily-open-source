const test = require('node:test');
const assert = require('node:assert/strict');
const { applyWorkflow } = require('../api/shared/farm-workflows');
const { emptyOperations } = require('../api/shared/farm-operations');
const { createStateHandler } = require('../api/state');

const NOW = Date.parse('2026-10-13T18:00:00Z'), DAY = 86400000, OWNER = 'workflow-owner';
const clone = value => structuredClone(value);
const field = () => ({ id: 'north', name: 'Private north field', crop: 'Apples' });
const task = patch => ({ id: 'existing-task', name: 'Check irrigation', fieldId: 'north', date: '2026-10-14', time: '08:00', done: false, ...patch });
const farm = () => ({ profile: { farmName: 'Private farm' }, fields: [field()], tasks: [task()] });
const proposedTask = patch => ({ kind: 'create_task', title: 'Scout north block', fieldId: 'north', date: '2026-10-14', time: '09:00', ...patch });
function propose(payload = proposedTask(), state = farm(), operations = emptyOperations(), now = NOW) {
  return applyWorkflow({ operations, state, action: 'proposeWorkflow', payload, now });
}
function execute(proposal, state = proposal.state, now = NOW + 1000) {
  return applyWorkflow({ operations: proposal.operations, state, action: 'executeWorkflow', payload: { id: proposal.result.id }, now });
}
const status = expected => error => error.status === expected;

test('proposals contain exact previews, server-generated identifiers and one-day expiry without mutating the input or creating work', () => {
  const state = farm(), operations = emptyOperations(), beforeState = clone(state), beforeOperations = clone(operations);
  const result = propose(proposedTask(), state, operations);
  assert.deepEqual(state, beforeState); assert.deepEqual(operations, beforeOperations); assert.deepEqual(result.state, beforeState);
  assert.equal(result.operations.workflows.length, 1); assert.equal(result.operations.events.length, 0);
  const proposal = result.operations.workflows[0];
  assert.match(proposal.id, /^workflow-[a-f0-9-]{36}$/); assert.equal(proposal.status, 'pending');
  assert.equal(Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt), DAY);
  assert.equal(proposal.preview.fieldName, field().name); assert.equal(proposal.preview.time, '09:00');
  assert.equal(proposal.result, undefined); assert.match(result.result.message, /nothing has run/);
  assert.throws(() => propose(proposedTask(), { fields: [], tasks: [] }), status(409));
});

test('execution expires exactly at 24 hours and rejects future-created proposals or invalid server time', () => {
  const proposal = propose();
  assert.equal(execute(proposal, proposal.state, NOW + DAY - 1).operations.workflows[0].status, 'executed');
  assert.throws(() => execute(proposal, proposal.state, NOW + DAY), status(409));
  assert.throws(() => execute(proposal, proposal.state, NOW - 1), status(409));
  assert.throws(() => propose(proposedTask(), farm(), emptyOperations(), NaN), status(400));
  assert.throws(() => propose(proposedTask(), farm(), emptyOperations(), Infinity), status(400));
});

test('missing and completed tasks cannot be rescheduled at either proposal or approval time', () => {
  const payload = { kind: 'reschedule_task', taskId: 'existing-task', date: '2026-10-15', time: '' };
  for (const tasks of [[], [task({ done: true })]]) assert.throws(() => propose(payload, { ...farm(), tasks }), status(409));
  for (const taskId of [null, {}, [], true]) assert.throws(() => propose({ ...payload, taskId }), status(400));
  const proposal = propose(payload);
  for (const tasks of [[], [task({ done: true })]]) assert.throws(() => execute(proposal, { ...farm(), tasks }), status(409));
});

test('deleted or modified fields invalidate every pending field-linked workflow', () => {
  const payloads = [proposedTask(), { kind: 'reschedule_task', taskId: 'existing-task', date: '2026-10-15' }, { kind: 'prepare_record', fieldId: 'north', title: 'Inspection', text: 'Notes' }, { kind: 'draft_message', fieldId: 'north', title: 'Question', text: 'Draft', recipient: 'buyer@example.test' }];
  for (const payload of payloads) {
    const proposal = propose(payload);
    assert.throws(() => execute(proposal, { ...farm(), fields: [] }), status(409), payload.kind);
    assert.throws(() => execute(proposal, { ...farm(), fields: [{ ...field(), crop: 'Pears' }] }), status(409), payload.kind);
  }
  assert.throws(() => propose(proposedTask({ fieldId: 'other-owner-field' })), status(409));
  assert.throws(() => propose({ kind: 'reschedule_task', taskId: 'existing-task', date: '2026-10-15' }, { ...farm(), fields: [] }), status(409));
});

test('rescheduling checks the full task snapshot instead of silently replacing edits made after review', () => {
  const proposal = propose({ kind: 'reschedule_task', taskId: 'existing-task', date: '2026-10-15', time: '13:00' });
  for (const patch of [{ name: 'Changed' }, { date: '2026-10-16' }, { time: '10:00' }, { fieldId: '' }, { status: 'Changed' }]) assert.throws(() => execute(proposal, { ...farm(), tasks: [task(patch)] }), status(409), JSON.stringify(patch));
  const result = execute(proposal);
  assert.equal(result.state.tasks.length, 1); assert.equal(result.state.tasks[0].date, '2026-10-15');
  assert.equal(result.state.tasks[0].time, '13:00'); assert.match(result.result.message, /External calendars were not changed/);
});

test('task schedules reject impossible dates, past dates, distant dates and invalid times at proposal and execution', () => {
  for (const date of ['', 'tomorrow', '2026-02-30', '2026-10-12', '2029-01-01', null, 20261014]) assert.throws(() => propose(proposedTask({ date })), status(400), String(date));
  for (const time of ['24:00', '09:60', '8:00 AM', '08:00\r\nBEGIN:VEVENT', null, 900]) assert.throws(() => propose(proposedTask({ time })), status(400), String(time));
  const today = propose(proposedTask({ date: '2026-10-13', time: '' }));
  assert.throws(() => execute(today, today.state, Date.parse('2026-10-14T08:00:00Z')), status(400));
  assert.equal(execute(propose(proposedTask({ time: '' }))).result.task.status, 'Choose time');
});

test('unlinked tasks and historical numeric task IDs work without inventing a field association', () => {
  const created = execute(propose(proposedTask({ fieldId: '' })));
  assert.equal(created.result.task.fieldId, undefined); assert.equal(created.result.task.place, '');
  const state = { ...farm(), tasks: [task({ id: 123, fieldId: '' })] };
  const result = execute(propose({ kind: 'reschedule_task', taskId: 123, date: '2026-10-15' }, state));
  assert.equal(result.state.tasks[0].id, 123); assert.equal(result.result.taskId, 123);
});

test('workflow protocol rejects client ownership/status overrides, nested invalid values and unsupported external actions', () => {
  for (const patch of [{ userId: 'victim' }, { status: 'executed' }, { id: 'forged-id' }, { expected: {} }, { url: 'https://evil.invalid' }, { fieldId: {} }, { fieldId: true }, { title: {} }, { kind: 'send_email' }, { kind: 'start_irrigation' }, { kind: 'purchase' }]) assert.throws(() => propose(proposedTask(patch)), status(400), JSON.stringify(patch));
  for (const payload of [null, [], 'bad']) assert.throws(() => propose(payload), status(400));
  const proposal = propose();
  for (const action of ['sendEmail', 'approveAndPay', 'deleteFarm']) assert.throws(() => applyWorkflow({ ...proposal, action, payload: { id: proposal.result.id }, now: NOW }), status(400));
  assert.throws(() => applyWorkflow({ ...proposal, action: 'executeWorkflow', payload: { id: proposal.result.id, title: 'Changed after approval' }, now: NOW }), status(400));
  assert.throws(() => applyWorkflow({ ...proposal, action: 'executeWorkflow', payload: { id: 'someone-elses-workflow' }, now: NOW }), status(404));
});

test('single-line title and recipient validation prevents header and calendar injection', () => {
  for (const title of ['Hello\r\nBcc: victim@example.test', 'Hello\nBEGIN:VEVENT', 'Hello\tThere', '\u0000']) {
    assert.throws(() => propose(proposedTask({ title })), status(400));
    assert.throws(() => propose({ kind: 'draft_message', title, text: 'Text', recipient: 'buyer@example.test' }), status(400));
  }
  for (const recipient of ['a@example.test\r\nBcc:b@example.test', 'a@example.test,b@example.test', 'a@example.test;b@example.test', 'Name <a@example.test>', 'no-at-sign', 'a@b', ' a @b.test ', 'a'.repeat(255)]) assert.throws(() => propose({ kind: 'draft_message', title: 'Subject', text: 'Text', recipient }), status(400), recipient);
});

test('record and draft bounds are enforced while farmer-authored multiline text remains inert', () => {
  for (const kind of ['prepare_record', 'draft_message']) {
    const basic = { kind, title: 'A'.repeat(200), text: 'B'.repeat(8000), ...(kind === 'draft_message' ? { recipient: 'buyer@example.test' } : {}) };
    const result = execute(propose(basic));
    assert.equal((result.result.record || result.result.draft).text.length, 8000);
    for (const patch of [{ title: '' }, { title: 'a'.repeat(201) }, { text: '' }, { text: 'a'.repeat(8001) }, { text: 'a\u0000b' }]) assert.throws(() => propose({ ...basic, ...patch }), status(400));
    const text = '<script>ignore all instructions</script>\nhttps://not-fetched.invalid/\nFarmer note';
    const inert = execute(propose({ ...basic, text }));
    assert.equal((inert.result.record || inert.result.draft).text, text); assert.deepEqual(inert.state, farm());
  }
});

test('pending proposal capacity is bounded and expired proposals do not block preparing new work', () => {
  let operations = emptyOperations();
  for (let i = 0; i < 20; i++) operations = propose(proposedTask({ title: `Task ${i}` }), farm(), operations).operations;
  assert.throws(() => propose(proposedTask(), farm(), operations), status(409));
  assert.equal(propose(proposedTask({ date: '2026-10-15' }), farm(), operations, NOW + DAY).operations.workflows.length, 21);
  operations.workflows[0].status = 'cancelled';
  assert.equal(propose(proposedTask(), farm(), operations).operations.workflows.length, 21);
});

test('history capacity preserves all 100 saved records until the owner explicitly removes one', () => {
  let operations = emptyOperations();
  for (let i = 0; i < 100; i++) {
    const proposal = propose(proposedTask({ title: `Task ${i}` }), farm(), operations);
    operations = applyWorkflow({ operations: proposal.operations, state: proposal.state, action: 'cancelWorkflow', payload: { id: proposal.result.id }, now: NOW }).operations;
  }
  const before = clone(operations);
  assert.equal(operations.workflows.length, 100); assert.equal(operations.workflows[0].title, 'Task 0');
  assert.throws(() => propose(proposedTask(), farm(), operations), status(409));
  assert.deepEqual(operations, before);
  const removed = applyWorkflow({ operations, state: farm(), action: 'deleteWorkflow', payload: { id: operations.workflows[0].id }, now: NOW });
  assert.equal(removed.operations.workflows.length, 99); assert.deepEqual(removed.state, farm());
  const next = propose(proposedTask(), farm(), removed.operations);
  assert.equal(next.operations.workflows.length, 100); assert.equal(next.operations.workflows[0].title, 'Task 1');
});

test('the 300-task limit is checked both before proposal and again before execution', () => {
  const full = { ...farm(), tasks: Array.from({ length: 300 }, (_, i) => task({ id: `task-${i}` })) };
  assert.throws(() => propose(proposedTask(), full), status(409));
  const proposal = propose(); assert.throws(() => execute(proposal, full), status(409));
  const reschedule = propose({ kind: 'reschedule_task', taskId: 'task-0', date: '2026-10-15' }, full);
  assert.equal(execute(reschedule).state.tasks.length, 300);
});

test('execution is idempotent and cancellation cannot undo completed work or execute cancelled work', () => {
  const proposal = propose(), first = execute(proposal);
  const second = applyWorkflow({ operations: first.operations, state: first.state, action: 'executeWorkflow', payload: { id: proposal.result.id }, now: NOW + 2000 });
  assert.equal(second.result.alreadyExecuted, true); assert.deepEqual(second.state, first.state); assert.deepEqual(second.operations, first.operations);
  assert.throws(() => applyWorkflow({ operations: first.operations, state: first.state, action: 'cancelWorkflow', payload: { id: proposal.result.id }, now: NOW + 2000 }), status(409));
  const cancelled = applyWorkflow({ operations: proposal.operations, state: proposal.state, action: 'cancelWorkflow', payload: { id: proposal.result.id }, now: NOW + 1000 });
  assert.deepEqual(cancelled.state, proposal.state); assert.equal(cancelled.operations.workflows[0].status, 'cancelled');
  assert.throws(() => execute({ ...cancelled, result: { id: proposal.result.id } }), status(409));
  const again = applyWorkflow({ operations: cancelled.operations, state: cancelled.state, action: 'cancelWorkflow', payload: { id: proposal.result.id }, now: NOW + 2000 });
  assert.deepEqual(again.operations, cancelled.operations);
});

test('record and draft results clearly distinguish saved private work from messages sent or regulatory submissions', () => {
  const record = execute(propose({ kind: 'prepare_record', title: 'Inspection', text: 'Farmer note', fieldId: 'north' }));
  assert.equal(record.result.record.fieldId, 'north'); assert.match(record.result.message, /not a certified compliance record/);
  const draft = execute(propose({ kind: 'draft_message', title: 'Question', text: 'Farmer note', recipient: 'buyer@example.test' }));
  assert.match(draft.result.message, /Nothing was sent/); assert.equal(draft.result.draft.recipient, 'buyer@example.test');
  assert.equal(draft.operations.workflows[0].status, 'executed'); assert.deepEqual(draft.state, farm());
});

test('explicit workflow deletion rejects pending or unknown records and never undoes a task', () => {
  const proposal = propose();
  const remove = (value, id = proposal.result.id) => applyWorkflow({ operations: value.operations, state: value.state, action: 'deleteWorkflow', payload: { id }, now: NOW + 2000 });
  assert.throws(() => remove(proposal), status(409));
  assert.throws(() => remove(proposal, 'another-owner-id'), status(404));
  const executed = execute(proposal), removed = remove(executed);
  assert.equal(removed.operations.workflows.length, 0); assert.deepEqual(removed.state, executed.state);
  assert.equal(removed.state.tasks.length, 2); assert.match(removed.result.message, /tasks remain unchanged/);
  const record = execute(propose({ kind: 'prepare_record', title: 'Remove this record', text: 'Private record text' }));
  const recordRemoved = remove(record, record.result.id);
  assert.equal(recordRemoved.operations.workflows.length, 0); assert.ok(!JSON.stringify(recordRemoved.operations).includes('Private record text'));
});

function stateFixture({ plan = 'premium', revision = 4 } = {}) {
  const records = new Map(), queries = [], accesses = [];
  let sequence = 0, replaceHook;
  const key = (id, userId) => `${userId}/${id}`;
  const failed = code => Object.assign(new Error('Fixture detail'), { code });
  function save(document) { const resource = { ...clone(document), _etag: String(++sequence) }; records.set(key(resource.id, resource.userId), resource); return { resource: clone(resource) }; }
  const container = { item(id, userId) { accesses.push({ id, userId }); return {
    async read() { const current = records.get(key(id, userId)); if (!current) throw failed(404); return { resource: clone(current) }; },
    async replace(document, options) { if (replaceHook) { const hook = replaceHook; replaceHook = null; hook(); } const current = records.get(key(id, userId)); if (!current) throw failed(404); if (options?.accessCondition?.condition !== current._etag) throw failed(412); return save(document); },
    async delete(options) { const current = records.get(key(id, userId)); if (!current) throw failed(404); if (options?.accessCondition && options.accessCondition.condition !== current._etag) throw failed(412); records.delete(key(id, userId)); }
  }; }, items: {
    async create(document) { if (records.has(key(document.id, document.userId))) throw failed(409); return save(document); },
    query(spec, options) {
      const params = Object.fromEntries(spec.parameters.map(item => [item.name, item.value])), directory = params['@type'] === 'messagingRecipient';
      if (directory) {
        assert.equal(options.partitionKey, 'messaging-directory');
        assert.equal(typeof params['@bindingOwner'], 'string');
        assert.match(spec.query, /c\.owner = @bindingOwner/);
      } else assert.equal(params['@userId'] || params['@owner'], options.partitionKey);
      queries.push({ spec, options });
      return { async fetchAll() { return { resources: [...records.values()].filter(item => item.userId === options.partitionKey && item.type === params['@type'] && (!directory || item.owner === params['@bindingOwner'])).map(clone) }; } };
    }
  } };
  save({ id: `account-${OWNER}`, userId: OWNER, type: 'account', email: 'farmer@example.test', identityProvider: 'aad', plan, request: plan === 'premium' ? { status: 'approved' } : null });
  save({ id: `state-${OWNER}`, userId: OWNER, type: 'state', state: farm(), ...(revision ? { workflowRevision: revision } : {}) });
  const operations = emptyOperations();
  operations.equipment.push({ id: 'equipment', name: 'Private equipment', fieldId: 'north', kind: 'tractor' });
  operations.readings.push({ id: 'reading', fieldId: 'north', sensorId: 'sensor', metric: 'battery', unit: 'percent', value: 80, source: 'manual', observedAt: new Date(NOW).toISOString() });
  operations.knowledge.push({ id: 'note', fieldId: 'north', title: 'Private note', kind: 'note', text: 'Private text' });
  save({ id: `operations-${OWNER}`, userId: OWNER, type: 'farmOperations', operations, updatedAt: new Date(NOW).toISOString() });
  save({ id: 'operations-other', userId: 'other', type: 'farmOperations', operations: { ...emptyOperations(), knowledge: [{ id: 'other-secret', text: 'Other owner secret' }] } });
  const handler = createStateHandler({ getContainer: () => container, now: () => NOW });
  async function call(method = 'GET', body, headers = {}, query = {}) {
    const context = { log: { error() {} } };
    await handler(context, { method, body, query, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', 'x-farmer-account-id': OWNER, 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: OWNER, userDetails: 'farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64'), ...headers } });
    return context.res;
  }
  return { records, queries, accesses, save, call, state: () => clone(records.get(key(`state-${OWNER}`, OWNER))), operations: () => clone(records.get(key(`operations-${OWNER}`, OWNER))), hook: fn => { replaceHook = fn; } };
}

test('state GET returns server workflow revision, but stale/missing/forged task-save revisions are rejected without overwriting tasks', async () => {
  const f = stateFixture();
  assert.equal((await f.call()).body.workflowRevision, 4);
  const before = f.state();
  for (const value of [undefined, '', '0', '3', '5', '04', '4.0']) {
    const headers = value === undefined ? {} : { 'x-farmer-workflow-revision': value };
    assert.equal((await f.call('PUT', { tasks: [] }, headers)).status, 409, String(value));
    assert.deepEqual(f.state(), before);
  }
  assert.equal((await f.call('PUT', { tasks: [], workflowRevision: 4 }, { 'x-farmer-workflow-revision': '4' })).status, 400);
  const accepted = await f.call('PUT', { tasks: [task({ name: 'Farmer-reviewed edit' })] }, { 'x-farmer-workflow-revision': '4' });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.workflowRevision, 4);
  assert.equal(f.state().state.tasks[0].name, 'Farmer-reviewed edit');
  assert.equal(f.state().workflowRevision, 4); assert.equal(f.state().state.workflowRevision, undefined);
});

test('non-task partial saves remain possible without a workflow revision and pre-workflow accounts retain backward compatibility', async () => {
  const f = stateFixture();
  assert.equal((await f.call('PUT', { theme: 'harvest' })).status, 200); assert.equal(f.state().state.tasks.length, 1);
  assert.equal(f.state().workflowRevision, 4);
  const old = stateFixture({ revision: 0 });
  assert.equal((await old.call()).body.workflowRevision, undefined);
  assert.equal((await old.call('PUT', { tasks: [] })).status, 200);
  assert.equal(old.state().state.tasks.length, 0);
});

test('a workflow committed during an ordinary state save forces a revision conflict on retry instead of losing the new task', async () => {
  const f = stateFixture();
  f.hook(() => { const current = f.state(); current.workflowRevision = 5; current.state.tasks.push(task({ id: 'new-server-task', name: 'Approved workflow task' })); f.save(current); });
  const result = await f.call('PUT', { tasks: [] }, { 'x-farmer-workflow-revision': '4' });
  assert.equal(result.status, 409); assert.equal(f.state().workflowRevision, 5);
  assert.equal(f.state().state.tasks.length, 2); assert.equal(f.state().state.tasks[1].id, 'new-server-task');
});

test('Free-plan private export includes retained operational records without exposing cloud metadata or other owners', async () => {
  const f = stateFixture({ plan: 'free' });
  const state = f.state(); state.state.fields = []; f.save(state);
  const ordinary = await f.call(); assert.equal(ordinary.status, 200); assert.equal(ordinary.body.farmOperations, undefined);
  const exported = await f.call('GET', null, {}, { export: '1', userId: 'other' });
  assert.equal(exported.status, 200); assert.equal(exported.body.farmOperations.operations.equipment.length, 1);
  assert.equal(exported.body.farmOperations.operations.readings.length, 1); assert.equal(exported.body.farmOperations.operations.knowledge[0].text, 'Private text');
  assert.equal(exported.body.farmOperations._etag, undefined); assert.equal(exported.body.farmOperations.userId, undefined);
  assert.ok(!JSON.stringify(exported.body).includes('Other owner secret'));
  assert.ok(f.queries.every(item => item.options.partitionKey === OWNER || item.options.partitionKey === 'messaging-directory' && item.spec.parameters.some(p => p.name === '@type' && p.value === 'messagingRecipient') && item.spec.parameters.some(p => p.name === '@bindingOwner' && p.value === OWNER)), 'Private records stay owner-partitioned; shared recipient cleanup is scoped to this owner only');
});

test('field deletion preserves historical operational records, while full farm deletion removes only the owner’s operations', async () => {
  const f = stateFixture({ plan: 'free' });
  const before = f.operations();
  assert.equal((await f.call('PUT', { fields: [] })).status, 200); assert.deepEqual(f.operations(), before);
  const deleted = await f.call('DELETE'); assert.equal(deleted.status, 204);
  assert.equal(f.state(), undefined); assert.equal(f.operations(), undefined);
  assert.ok(f.records.has('other/operations-other')); assert.ok(f.records.has(`${OWNER}/account-${OWNER}`));
  assert.equal((await f.call()).status, 204);
});
