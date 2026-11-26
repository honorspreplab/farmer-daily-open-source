require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateHandler } = require('../api/state');

const stamp = '2026-10-04T18:00:00.000Z';
const farmer = { userId: 'reading-farmer', userDetails: 'reading-farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'] };
const other = { ...farmer, userId: 'reading-other', userDetails: 'reading-other@example.test' };
const admin = { ...farmer, userId: 'reading-admin', userDetails: 'admin1@example.invalid' };
const clone = value => structuredClone(value);
const storageError = code => Object.assign(new Error('Fixture storage error'), { code });

function fixture(plan = 'free') {
  const documents = new Map(), writes = [], accesses = [];
  let version = 0;
  const key = (id, userId) => `${userId}/${id}`;
  const save = document => {
    const stored = { ...clone(document), _etag: `reading-${++version}` };
    documents.set(key(stored.id, stored.userId), stored);
    return { resource: clone(stored) };
  };
  for (const identity of [farmer, other, admin]) {
    save({ id: `account-${identity.userId}`, userId: identity.userId, type: 'account', email: identity.userDetails, identityProvider: identity.identityProvider, plan, request: plan === 'premium' ? { status: 'approved' } : null });
  }
  save({ id: `state-${farmer.userId}`, userId: farmer.userId, type: 'state', state: {
    profile: { firstName: 'Farmer', farmName: 'Private orchard' },
    fields: [{ id: 'field-one', name: 'North block', crop: 'Apples' }],
    tasks: [{ id: 'task-one', name: 'Walk the orchard', done: false }],
    observations: [{ id: 'note-one', field: 'North block', note: 'Previously approved private observation' }],
    theme: 'orchard', updatedAt: stamp
  } });
  const container = {
    item(id, userId) {
      accesses.push({ id, userId });
      return {
        async read() { const stored = documents.get(key(id, userId)); if (!stored) throw storageError(404); return { resource: clone(stored) }; },
        async replace(document, options) {
          const stored = documents.get(key(id, userId));
          if (!stored) throw storageError(404);
          assert.equal(options?.accessCondition?.type, 'IfMatch');
          if (options.accessCondition.condition !== stored._etag) throw storageError(412);
          assert.equal(document.id, id); assert.equal(document.userId, userId);
          writes.push(clone(document)); return save(document);
        },
        async delete() { if (!documents.delete(key(id, userId))) throw storageError(404); }
      };
    },
    items: {
      async create(document) {
        if (documents.has(key(document.id, document.userId))) throw storageError(409);
        writes.push(clone(document)); return save(document);
      },
      query(spec, options) {
        const parameters = Object.fromEntries(spec.parameters.map(parameter => [parameter.name, parameter.value]));
        const directory = parameters['@type'] === 'messagingRecipient';
        if (directory) {
          assert.equal(options.partitionKey, 'messaging-directory');
          assert.equal(typeof parameters['@bindingOwner'], 'string');
          assert.match(spec.query, /c\.owner = @bindingOwner/);
        } else assert.equal(options.partitionKey, parameters['@userId'] || parameters['@owner']);
        accesses.push({ query: parameters['@type'], userId: options.partitionKey, bindingOwner: parameters['@bindingOwner'] });
        return { async fetchAll() { return { resources: [...documents.values()].filter(document => document.userId === options.partitionKey && document.type === parameters['@type'] && (!directory || document.owner === parameters['@bindingOwner'])).map(clone) }; } };
      }
    }
  };
  const handler = createStateHandler({ getContainer: () => container, now: () => Date.parse(stamp) });
  return {
    accesses, writes,
    stored(identity = farmer) { return clone(documents.get(key(`state-${identity.userId}`, identity.userId))); },
    membership(identity = farmer) { return clone(documents.get(key(`account-${identity.userId}`, identity.userId))); },
    async call(method, body, { identity = farmer, query = {}, headers = {} } = {}) {
      const context = { log: { error() {}, warn() {} } };
      await handler(context, { method, body, query, headers: {
        host: 'localhost:8080', origin: 'http://localhost:8080', 'content-type': 'application/json',
        ...(identity ? { 'x-ms-client-principal': Buffer.from(JSON.stringify(identity)).toString('base64'), 'x-farmer-account-id': identity.userId } : {}),
        ...headers
      } });
      assert.equal(context.res.headers['Cache-Control'], 'no-store');
      return context.res;
    }
  };
}

for (const plan of ['free', 'premium']) {
  for (const enabled of [false, true]) {
    for (const textSize of ['comfortable', 'large']) {
      test(`${plan} saves reading preference ${enabled ? 'enabled' : 'disabled'}/${textSize} without changing farm records`, async () => {
        const f = fixture(plan), before = f.stored(), membershipBefore = f.membership();
        const readingPreferences = { enabled, textSize };
        assert.equal((await f.call('PUT', { readingPreferences })).status, 200);
        assert.deepEqual(f.stored().state, { ...before.state, readingPreferences, updatedAt: stamp });
        const response = await f.call('GET');
        assert.equal(response.status, 200); assert.deepEqual(response.body.readingPreferences, readingPreferences);
        assert.deepEqual(response.body.fields, before.state.fields); assert.deepEqual(response.body.tasks, before.state.tasks);
        assert.deepEqual(response.body.observations, plan === 'premium' ? before.state.observations : undefined);
        assert.deepEqual(f.membership(), membershipBefore, 'Display preferences do not enter account/admin metadata');
        assert.equal(f.writes.length, 1);
      });
    }
  }
}

test('malformed, unknown, health-related and prototype reading preferences are rejected without writes', async () => {
  const valid = { enabled: true, textSize: 'comfortable' };
  const invalid = [
    undefined, null, false, true, 'large', 1, [], [valid], {}, { enabled: true }, { textSize: 'large' },
    ...['true', 'false', 0, 1, null, [], {}].map(enabled => ({ ...valid, enabled })),
    ...['', 'small', 'Large', ' comfortable', 'large ', '<script>', null, true, 1, [], {}].map(textSize => ({ ...valid, textSize })),
    ...['font', 'diagnosis', 'hasDyslexia', 'health', 'userId', 'constructor', 'prototype'].map(name => ({ ...valid, [name]: true })),
    JSON.parse('{"enabled":true,"textSize":"large","__proto__":{"isAdmin":true}}'),
    Object.assign(Object.create({ enabled: true }), { textSize: 'large' }),
    Object.assign(Object.create({ isAdmin: true }), valid),
    Object.assign(Object.create(null), valid), new Date(stamp),
    { ...valid, [Symbol('hidden')]: true }
  ];
  for (const plan of ['free', 'premium']) {
    const f = fixture(plan);
    assert.equal((await f.call('PUT', { readingPreferences: valid })).status, 200);
    const before = f.stored(); f.writes.length = 0;
    for (const [index, readingPreferences] of invalid.entries()) {
      const response = await f.call('PUT', { readingPreferences });
      assert.equal(response.status, 400, `${plan}: invalid case ${index}`);
      assert.equal(response.body.error, 'Invalid reading preferences');
      assert.deepEqual(f.stored(), before, 'Rejected preferences preserve the saved state and ETag');
    }
    assert.equal(f.writes.length, 0);
  }
  assert.equal({}.isAdmin, undefined);
});

test('omitted reading preferences are backward compatible and preserved across old-client partial saves', async () => {
  for (const plan of ['free', 'premium']) {
    const f = fixture(plan);
    assert.equal((await f.call('GET')).body.readingPreferences, undefined, 'Legacy state is not silently opted in');
    assert.equal((await f.call('PUT', { theme: 'lavender' })).status, 200);
    assert.equal((await f.call('GET')).body.readingPreferences, undefined);
    const readingPreferences = { enabled: true, textSize: 'large' };
    assert.equal((await f.call('PUT', { readingPreferences })).status, 200);
    assert.equal((await f.call('PUT', { profile: { firstName: 'Updated' }, theme: 'coastal' })).status, 200);
    assert.deepEqual((await f.call('GET')).body.readingPreferences, readingPreferences);
    assert.equal((await f.call('PUT', { readingPreferences: { enabled: false, textSize: 'large' } })).status, 200);
    assert.deepEqual((await f.call('GET')).body.readingPreferences, { enabled: false, textSize: 'large' });
  }
});

test('reading preferences remain owner-only even for administrators, spoofed queries and stale tabs', async () => {
  const f = fixture(), readingPreferences = { enabled: true, textSize: 'large' };
  await f.call('PUT', { readingPreferences });
  const before = f.stored(), attack = { userId: farmer.userId, id: `state-${farmer.userId}`, export: '1' };
  assert.equal((await f.call('GET', undefined, { identity: null })).status, 401);
  assert.equal((await f.call('PUT', { readingPreferences }, { headers: { 'x-farmer-account-id': other.userId } })).status, 409);
  assert.equal((await f.call('PUT', { readingPreferences }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const identity of [other, admin]) {
    f.accesses.length = 0;
    assert.equal((await f.call('GET', undefined, { identity, query: attack })).status, 204);
    assert.equal((await f.call('PUT', { readingPreferences: { enabled: false, textSize: 'comfortable' } }, { identity, query: attack })).status, 200);
    assert.equal((await f.call('DELETE', undefined, { identity, query: attack })).status, 204);
    assert.ok(f.accesses.every(access => access.userId === identity.userId || access.userId === 'messaging-directory' && access.query === 'messagingRecipient' && access.bindingOwner === identity.userId), 'Private records stay in the authenticated partition; shared recipient cleanup is scoped to this owner');
    assert.deepEqual(f.stored(), before);
  }
});

test('adding a reading preference does not bypass Free feature or unknown-field restrictions', async () => {
  const f = fixture(), before = f.stored(), readingPreferences = { enabled: true, textSize: 'comfortable' };
  for (const key of ['observations', 'jobs', 'jobEvents']) assert.equal((await f.call('PUT', { readingPreferences, [key]: [] })).status, 403);
  for (const key of ['plan', 'isAdmin', 'diagnosis']) assert.equal((await f.call('PUT', { readingPreferences, [key]: true })).status, 400);
  assert.deepEqual(f.stored(), before); assert.equal(f.writes.length, 0);
});

test('own export includes reading preferences and deleting farm data removes them without changing membership', async () => {
  for (const plan of ['free', 'premium']) {
    const f = fixture(plan), membershipBefore = f.membership(), readingPreferences = { enabled: true, textSize: 'large' };
    await f.call('PUT', { readingPreferences });
    const exported = await f.call('GET', undefined, { query: { export: '1' } });
    assert.equal(exported.status, 200); assert.deepEqual(exported.body.readingPreferences, readingPreferences);
    assert.equal((await f.call('DELETE')).status, 204);
    assert.equal((await f.call('GET')).status, 204);
    assert.equal(f.stored(), undefined); assert.deepEqual(f.membership(), membershipBefore);
    assert.ok(f.accesses.every(access => access.userId === farmer.userId || access.userId === 'messaging-directory' && access.query === 'messagingRecipient' && access.bindingOwner === farmer.userId));
  }
});
