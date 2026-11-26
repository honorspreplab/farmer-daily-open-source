const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateHandler } = require('../api/state');

const THEMES = ['field', 'harvest', 'slate', 'sunrise', 'prairie', 'midnight', 'orchard', 'coastal', 'lavender', 'highcontrast'];
const timestamp = '2026-10-04T18:00:00.000Z';
const farmer = { userId: 'theme-farmer', userDetails: 'theme-farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'] };
const other = { ...farmer, userId: 'theme-other', userDetails: 'theme-other@example.test' };
const clone = value => structuredClone(value);
const storageError = code => Object.assign(new Error('Fixture storage error'), { code });

function fixture(plan = 'free') {
  const documents = new Map(), writes = [], accesses = [];
  const key = (id, userId) => `${userId}/${id}`;
  let version = 0;
  function save(document) {
    const stored = { ...clone(document), _etag: `theme-${++version}` };
    documents.set(key(stored.id, stored.userId), stored);
    return { resource: clone(stored) };
  }
  for (const identity of [farmer, other]) {
    save({ id: `account-${identity.userId}`, userId: identity.userId, type: 'account', email: identity.userDetails, identityProvider: identity.identityProvider, plan, request: plan === 'premium' ? { status: 'approved' } : null });
    save({ id: `state-${identity.userId}`, userId: identity.userId, type: 'state', state: {
      profile: { firstName: identity === farmer ? 'Farmer' : 'Other owner' },
      fields: [{ id: `field-${identity.userId}`, name: 'Private orchard', crop: 'Apples' }],
      tasks: [{ id: `task-${identity.userId}`, name: 'Inspect orchard', done: false }],
      observations: [{ id: 'retained-note', field: 'Private orchard', note: 'Previously approved private note' }],
      theme: 'field', updatedAt: timestamp
    } });
  }
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
          writes.push(clone(document));
          return save(document);
        }
      };
    },
    items: {
      async create(document) {
        if (documents.has(key(document.id, document.userId))) throw storageError(409);
        writes.push(clone(document)); return save(document);
      }
    }
  };
  const handler = createStateHandler({ getContainer: () => container, now: () => Date.parse(timestamp) });
  return {
    accesses, writes,
    stored(identity = farmer) { return clone(documents.get(key(`state-${identity.userId}`, identity.userId))); },
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
  for (const theme of THEMES) {
    test(`${plan} can save and retrieve the ${theme} theme without changing farm records`, async () => {
      const f = fixture(plan), before = f.stored(), anotherBefore = f.stored(other);
      assert.equal((await f.call('PUT', { theme })).status, 200);
      assert.deepEqual(f.stored().state, { ...before.state, theme, updatedAt: timestamp });
      const response = await f.call('GET');
      assert.equal(response.status, 200); assert.equal(response.body.theme, theme);
      assert.deepEqual(response.body.fields, before.state.fields);
      assert.deepEqual(response.body.tasks, before.state.tasks);
      assert.deepEqual(response.body.observations, plan === 'premium' ? before.state.observations : undefined);
      assert.deepEqual(f.stored(other), anotherBefore, 'Theme changes never write another account');
      assert.equal(f.writes.length, 1);
    });
  }
}

test('unknown, malformed and unsafe theme values are rejected without a write', async () => {
  const invalid = ['', 'Field', ' field', 'field ', 'field harvest', 'high-contrast', 'unknown', '../field', '__proto__', 'constructor', 'toString', 'field\0', '<script>alert(1)</script>', 'url(javascript:alert(1))', 'https://example.test/theme.css', 'x'.repeat(500), null, false, true, 0, 1, [], ['orchard'], {}, { theme: 'coastal' }];
  for (const plan of ['free', 'premium']) {
    const f = fixture(plan), before = f.stored();
    for (const theme of invalid) {
      const response = await f.call('PUT', { theme });
      assert.equal(response.status, 400, `${plan}: ${JSON.stringify(theme)}`);
      assert.equal(response.body.error, 'Invalid theme');
      assert.deepEqual(f.stored(), before, 'An invalid theme preserves the state and concurrency token');
    }
    assert.equal(f.writes.length, 0);
  }
});

test('theme preference does not grant Free accounts access to protected records or unknown keys', async () => {
  const f = fixture(), before = f.stored();
  for (const protectedKey of ['observations', 'jobs', 'jobEvents']) {
    assert.equal((await f.call('PUT', { theme: 'orchard', [protectedKey]: [] })).status, 403);
  }
  for (const unsupportedKey of ['userId', 'plan', 'isAdmin', 'themeCss']) {
    assert.equal((await f.call('PUT', { theme: 'highcontrast', [unsupportedKey]: 'premium' })).status, 400);
  }
  assert.deepEqual(f.stored(), before); assert.equal(f.writes.length, 0);
});

test('theme updates use authenticated ownership and reject stale-account or cross-site requests', async () => {
  const f = fixture(), before = f.stored(), otherBefore = f.stored(other);
  assert.equal((await f.call('PUT', { theme: 'coastal' }, { identity: null })).status, 401);
  assert.equal((await f.call('PUT', { theme: 'coastal' }, { headers: { 'x-farmer-account-id': other.userId } })).status, 409);
  assert.equal((await f.call('PUT', { theme: 'coastal' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.call('PUT', { theme: 'coastal' }, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.deepEqual(f.stored(), before); assert.equal(f.writes.length, 0);
  assert.equal((await f.call('PUT', { theme: 'lavender' }, { query: { userId: other.userId, id: `state-${other.userId}` } })).status, 200);
  assert.equal(f.stored().state.theme, 'lavender'); assert.deepEqual(f.stored(other), otherBefore);
  assert.ok(f.accesses.every(access => access.userId === farmer.userId));
});

test('a partial update that omits theme preserves the saved preference', async () => {
  const f = fixture();
  assert.equal((await f.call('PUT', { theme: 'highcontrast' })).status, 200);
  assert.equal((await f.call('PUT', { profile: { firstName: 'Updated' } })).status, 200);
  assert.equal((await f.call('GET')).body.theme, 'highcontrast');
});
