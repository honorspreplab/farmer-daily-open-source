const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateHandler } = require('../api/state');
const OWNER = 'calendar-state-owner';
function fixture(plan = 'premium') {
  const documents = new Map();
  let sequence = 0;
  const key = (id, owner) => owner + '/' + id;
  function save(value) { const resource = { ...structuredClone(value), _etag: String(++sequence) }; documents.set(key(value.id, value.userId), resource); return { resource: structuredClone(resource) }; }
  function failure(code) { return Object.assign(new Error('Private storage detail'), { code }); }
  const container = {
    item(id, owner) { return {
      async read() { const value = documents.get(key(id, owner)); if (!value) throw failure(404); return { resource: structuredClone(value) }; },
      async replace(value, options) { const old = documents.get(key(id, owner)); if (!old) throw failure(404); if (options?.accessCondition?.condition !== old._etag) throw failure(412); return save(value); },
      async delete(options) { const old = documents.get(key(id, owner)); if (!old) throw failure(404); if (options?.accessCondition && options.accessCondition.condition !== old._etag) throw failure(412); documents.delete(key(id, owner)); }
    }; },
    items: { async create(value) { return save(value); }, query() { return { async fetchAll() { return { resources: [] }; } }; } }
  };
  save({ id: 'account-' + OWNER, userId: OWNER, type: 'account', email: 'owner@example.test', identityProvider: 'aad', plan, request: plan === 'premium' ? { status: 'approved' } : null });
  save({ id: 'state-' + OWNER, userId: OWNER, type: 'state', state: { profile: { farmName: 'Private farm' }, fields: [], tasks: [] } });
  const calendar = owner => ({ id: 'calendar-' + owner, userId: owner, type: 'calendarConnections', schemaVersion: 1,
    connections: { google: { status: 'connected', accountLabel: 'calendar@example.test', calendarName: 'Farmer Daily', connectedAt: '2026-10-17T00:00:00Z', providerAccountId: 'PRIVATE_PROVIDER_ID', calendarId: 'PRIVATE_CALENDAR_ID', secret: { v: 1, data: 'SECRET_CIPHERTEXT' } } },
    pending: { outlook: { stateHash: 'SECRET_STATE', browserHash: 'SECRET_COOKIE', verifier: { data: 'SECRET_VERIFIER' }, tokenSecret: { data: 'SECRET_PENDING_TOKEN' } } },
    proposals: [{ id: 'proposal-1', provider: 'google', status: 'pending', preview: { title: 'Approved farm task' }, taskHash: 'PRIVATE_TASK_HASH', generation: 'PRIVATE_GENERATION', externalId: 'PRIVATE_EXTERNAL_ID' }]
  });
  save(calendar(OWNER)); save(calendar('other-owner'));
  const handler = createStateHandler({ getContainer: () => container });
  const principal = Buffer.from(JSON.stringify({ userId: OWNER, userDetails: 'owner@example.test', identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64');
  async function call(method, query = {}) { const context = { log: { error() {} } }; await handler(context, { method, query, headers: { 'x-ms-client-principal': principal, 'x-farmer-account-id': OWNER } }); return context.res; }
  return { call, documents, key };
}

test('owner export includes useful calendar history but no credentials or OAuth attempt material', async () => {
  const f = fixture();
  const response = await f.call('GET', { export: '1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.calendarConnections.connections[0].accountLabel, 'calendar@example.test');
  assert.equal(response.body.calendarConnections.proposals[0].preview.title, 'Approved farm task');
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET_|PRIVATE_PROVIDER_ID|PRIVATE_CALENDAR_ID|PRIVATE_TASK_HASH|PRIVATE_GENERATION|PRIVATE_EXTERNAL_ID/);
});

test('downgraded owners can export connection metadata; ordinary farm loads do not include it', async () => {
  const f = fixture('free');
  assert.ok((await f.call('GET', { export: '1' })).body.calendarConnections);
  assert.equal((await f.call('GET')).body.calendarConnections, undefined);
});

test('Delete farm data removes own calendar credentials, attempts and proposals, not another owner', async () => {
  const f = fixture();
  assert.equal((await f.call('DELETE')).status, 204);
  assert.equal(f.documents.has(f.key('calendar-' + OWNER, OWNER)), false);
  assert.equal(f.documents.has(f.key('state-' + OWNER, OWNER)), false);
  assert.equal(f.documents.has(f.key('account-' + OWNER, OWNER)), true);
  assert.equal(f.documents.has(f.key('calendar-other-owner', 'other-owner')), true);
});
