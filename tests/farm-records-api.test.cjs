require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateHandler } = require('../api/state');

const clone = value => structuredClone(value);
const farmer = { userId: 'records-farmer', userDetails: 'records@example.test', identityProvider: 'aad', userRoles: ['authenticated'] };
const admin = { ...farmer, userId: 'records-admin', userDetails: 'admin1@example.invalid' };
const another = { ...farmer, userId: 'records-other', userDetails: 'other@example.test' };
const field = { id: 'field-1', name: 'North orchard', crop: 'Apples', stage: 'Harvest', acres: 4.5, createdAt: '2026-10-01T16:00:00.000Z' };
// These tests exercise byte/signature validation, not a browser image decoder.
const photo = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString('base64');
const observation = { id: 'note-1', fieldId: field.id, field: field.name, note: 'Check fruit on the east row tomorrow.', hasPhoto: true, photo, createdAt: field.createdAt, sync: 'local' };
const legacyObservation = { id: 1720000000000, field: 'Old field', note: 'Earlier field visit.', hasPhoto: true, createdAt: '2026-09-01T12:00:00.000Z', sync: 'local' };

function storageError(code) { return Object.assign(new Error('Simulated storage error'), { code }); }
function fixture({ premium = true } = {}) {
  const documents = new Map();
  const accesses = [];
  let version = 0;
  const key = (id, userId) => `${userId}/${id}`;
  const save = doc => {
    const stored = { ...clone(doc), _etag: `records-${++version}` };
    documents.set(key(doc.id, doc.userId), stored);
    return { resource: clone(stored) };
  };
  const container = {
    item(id, userId) {
      accesses.push({ id, userId });
      return {
        async read() { const stored = documents.get(key(id, userId)); if (!stored) throw storageError(404); return { resource: clone(stored) }; },
        async replace(doc, options) {
          const stored = documents.get(key(id, userId));
          if (!stored) throw storageError(404);
          assert.equal(options?.accessCondition?.type, 'IfMatch');
          if (options.accessCondition.condition !== stored._etag) throw storageError(412);
          assert.equal(doc.id, id);
          assert.equal(doc.userId, userId);
          return save(doc);
        },
        async delete() { if (!documents.delete(key(id, userId))) throw storageError(404); }
      };
    },
    items: {
      async create(doc) { if (documents.has(key(doc.id, doc.userId))) throw storageError(409); return save(doc); },
      query(spec, options) {
        const params = Object.fromEntries(spec.parameters.map(param => [param.name, param.value]));
        const directory = params['@type'] === 'messagingRecipient';
        if (directory) {
          assert.equal(options.partitionKey, 'messaging-directory');
          assert.equal(typeof params['@bindingOwner'], 'string');
          assert.match(spec.query, /c\.owner = @bindingOwner/);
        } else assert.equal(options.partitionKey, params['@userId'] || params['@owner']);
        return { async fetchAll() { return { resources: [...documents.values()].filter(doc => doc.userId === options.partitionKey && doc.type === params['@type'] && (!directory || doc.owner === params['@bindingOwner'])).map(doc => /^SELECT c\.id FROM/.test(spec.query) ? { id: doc.id } : clone(doc)) }; } };
      }
    }
  };
  save({ id: `account-${farmer.userId}`, userId: farmer.userId, type: 'account', email: farmer.userDetails, identityProvider: farmer.identityProvider, plan: premium ? 'premium' : 'free', request: premium ? { status: 'approved' } : null });
  const handler = createStateHandler({ getContainer: () => container, now: () => Date.parse(field.createdAt) });
  return {
    documents, accesses, save,
    async call(method, body, identity = farmer, query = {}) {
      const context = { log: { error() {}, warn() {} } };
      await handler(context, {
        method, body, query,
        headers: {
          host: 'calm-desert-02e51f41e.1.azurestaticapps.net', origin: 'https://calm-desert-02e51f41e.1.azurestaticapps.net',
          'content-type': 'application/json',
          ...(identity ? { 'x-ms-client-principal': Buffer.from(JSON.stringify(identity)).toString('base64') } : {})
        }
      });
      assert.equal(context.res.headers['Cache-Control'], 'no-store');
      return context.res;
    }
  };
}

test('Premium saves and retrieves real fields and inline JPEG observations only from own state', async () => {
  const f = fixture();
  const state = { fields: [field], observations: [observation, legacyObservation], profile: { firstName: 'Sam' }, theme: 'field' };
  assert.equal((await f.call('PUT', state)).status, 200);
  const saved = await f.call('GET');
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ...state, updatedAt: field.createdAt });
  const exported = await f.call('GET', undefined, farmer, { export: '1' });
  assert.deepEqual(exported.body, saved.body);
  assert.equal((await f.call('GET', undefined, null)).status, 401);
  assert.equal((await f.call('GET', undefined, another, { userId: farmer.userId, export: '1' })).status, 204);
});

test('Free users save fields and tasks but observations still require approval; retained records remain exportable', async () => {
  const f = fixture({ premium: false });
  f.save({ id: `state-${farmer.userId}`, userId: farmer.userId, type: 'state', state: { fields: [field], observations: [observation], profile: { firstName: 'Sam' }, theme: 'field' } });
  for (const name of ['observations', 'jobs', 'jobEvents']) assert.equal((await f.call('PUT', { [name]: [] })).status, 403);
  assert.equal((await f.call('PUT', { fields: [field], tasks: [{ id: 'task-1', name: 'Walk the orchard', place: field.name, fieldId: field.id, date: '2026-10-03', time: '08:00', done: false }] })).status, 200);
  const normal = await f.call('GET');
  assert.deepEqual(normal.body.fields, [field]);
  assert.equal(normal.body.tasks.length, 1);
  assert.equal(normal.body.observations, undefined);
  assert.equal((await f.call('PUT', { profile: { firstName: 'Updated' }, theme: 'harvest' })).status, 200);
  const exported = await f.call('GET', undefined, farmer, { export: '1' });
  assert.deepEqual(exported.body.fields, [field]);
  assert.deepEqual(exported.body.observations, [observation]);
  assert.equal(exported.body.profile.firstName, 'Updated');
  assert.equal((await f.call('DELETE')).status, 204);
  assert.equal((await f.call('GET', undefined, farmer, { export: '1' })).status, 204);
});

test('geolocated Free fields normalize polygons and validate dates, consent, profile time and tasks', async () => {
  const f = fixture({ premium: false });
  const point = { ...field, location: { latitude: 47.68, longitude: -122.2 }, dataConsent: true, variety: 'Honeycrisp', bloomDate: '2026-04-22' };
  assert.equal((await f.call('PUT', { fields: [point], profile: { language: 'Español', briefTime: '06:30' } })).status, 200);
  assert.deepEqual((await f.call('GET')).body.fields, [point]);
  for (const change of [{ plantingDate: '2026-02-30' }, { bloomDate: 'yesterday' }, { transplantDate: '2026-1-01' }, { dataConsent: 'yes' }, { location: { latitude: 44, longitude: -122 } }, { variety: 'x'.repeat(81) }, { elevation: 12 }]) {
    assert.equal((await f.call('PUT', { fields: [{ ...point, ...change }] })).status, 400);
  }
  for (const profile of [{ language: 'French' }, { briefTime: '25:00' }, { briefTime: 630 }, { scheduleEnabled: 'yes' }, { notificationPreference: 'whatsapp' }]) assert.equal((await f.call('PUT', { profile })).status, 400);
  assert.equal((await f.call('PUT', { profile: { language: 'en', briefTime: '06:30', scheduleEnabled: true, notificationPreference: 'browser', existingLegacyPreference: 'preserved' } })).status, 200);
  const task = { id: 'task-1', name: 'Inspect', fieldId: field.id, place: field.name, date: '2026-10-03', time: '', done: false };
  for (const tasks of [[task, task], [{ ...task, name: '' }], [{ ...task, date: '2026-02-30' }], [{ ...task, time: '24:00' }], [{ ...task, fieldId: 'x'.repeat(101) }], [{ ...task, done: 'yes' }], [{ ...task, ownerId: 'other' }], Array.from({ length: 301 }, (_, i) => ({ ...task, id: String(i) }))]) {
    assert.equal((await f.call('PUT', { tasks })).status, 400);
  }
  assert.equal((await f.call('PUT', { tasks: [{ id: 1, name: 'Legacy task', time: '8:00 AM' }] })).status, 200);
  assert.equal((await f.call('PUT', { derivedFieldData: [] })).status, 400);
});

test('partial state saves preserve field records for Free and approved plans', async () => {
  for (const premium of [false, true]) {
    const f = fixture({ premium });
    await f.call('PUT', { fields: [field], profile: { firstName: 'Before' } });
    assert.equal((await f.call('PUT', { profile: { firstName: 'After' } })).status, 200);
    assert.deepEqual((await f.call('GET')).body.fields, [field]);
  }
});

test('administrator status cannot read, overwrite, or delete another farmer’s fields or photos', async () => {
  const f = fixture();
  await f.call('PUT', { fields: [field], observations: [observation] });
  f.accesses.length = 0;
  const attackQuery = { userId: farmer.userId, id: `state-${farmer.userId}`, export: '1' };
  assert.equal((await f.call('GET', undefined, admin, attackQuery)).status, 204);
  assert.equal((await f.call('PUT', { fields: [], observations: [] }, admin, attackQuery)).status, 200);
  assert.equal((await f.call('DELETE', undefined, admin, attackQuery)).status, 204);
  assert.ok(f.accesses.every(access => access.userId === admin.userId));
  assert.deepEqual((await f.call('GET')).body.observations, [observation]);
});

test('deleting farm state removes photos and fields while preserving membership and brief quota', async () => {
  const f = fixture();
  await f.call('PUT', { fields: [field], observations: [observation] });
  f.save({ id: 'brief-private', userId: farmer.userId, type: 'dailyBrief', date: '2026-10-01', brief: { text: 'Private farm text' } });
  assert.equal((await f.call('DELETE')).status, 204);
  assert.equal((await f.call('GET')).status, 204);
  const remaining = [...f.documents.values()];
  assert.equal(remaining.find(doc => doc.type === 'account').plan, 'premium');
  const quota = remaining.find(doc => doc.type === 'dailyBrief');
  assert.equal(quota.date, '2026-10-01');
  assert.equal(quota.deleted, true);
  assert.equal(quota.brief, null);
  assert.ok(!JSON.stringify(remaining).includes(photo));
  assert.ok(!JSON.stringify(remaining).includes(field.name));
});

test('optional field metadata and historical observations without stored photos remain supported', async () => {
  const f = fixture();
  for (const acres of [undefined, null, 0.01, 1000000]) {
    const minimal = { id: 'minimal', name: 'Kitchen garden', crop: 'Mixed vegetables', ...(acres !== undefined ? { acres } : {}) };
    assert.equal((await f.call('PUT', { fields: [minimal], observations: [legacyObservation] })).status, 200);
  }
});

test('invalid and oversized field records are rejected without replacing saved records', async () => {
  const f = fixture();
  await f.call('PUT', { fields: [field] });
  const invalidFields = [null, {}, [null], Array.from({ length: 51 }, (_, index) => ({ ...field, id: String(index) })), [field, field],
    ...[{ id: '' }, { id: 5 }, { id: 'x'.repeat(101) }, { name: '' }, { name: 'x'.repeat(101) }, { crop: '' }, { crop: 'x'.repeat(81) }, { stage: 'x'.repeat(81) }, { acres: 0 }, { acres: -1 }, { acres: 1000001 }, { acres: '5' }, { acres: Infinity }, { createdAt: 'yesterday' }, { userId: 'other' }].map(change => [{ ...field, ...change }])];
  for (const fields of invalidFields) assert.equal((await f.call('PUT', { fields })).status, 400, JSON.stringify(fields));
  assert.deepEqual((await f.call('GET')).body.fields, [field]);
});

test('invalid observation records are rejected while legacy records remain intact', async () => {
  const f = fixture();
  await f.call('PUT', { observations: [legacyObservation] });
  const invalidObservations = [null, {}, [null], Array.from({ length: 201 }, (_, index) => ({ ...legacyObservation, id: index })), [legacyObservation, legacyObservation],
    ...[{ id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: '' }, { id: {} }, { id: 'x'.repeat(101) }, { note: 'x'.repeat(2001) }, { field: 'x'.repeat(101) }, { fieldId: 'x'.repeat(101) }, { hasPhoto: 'true' }, { sync: {} }, { createdAt: 'not-a-date' }, { userId: 'someone-else' }].map(change => [{ ...legacyObservation, ...change }])];
  for (const observations of invalidObservations) assert.equal((await f.call('PUT', { observations })).status, 400, JSON.stringify(observations));
  assert.deepEqual((await f.call('GET')).body.observations, [legacyObservation]);
});

test('remote URLs, active image formats, malformed base64 and false JPEG signatures are rejected', async () => {
  const f = fixture();
  const invalidPhotos = [null, {}, '', 'https://example.test/private.jpg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PGgxPkhpPC9oMT4=', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,%%%', 'data:image/jpeg;base64,/9j/4AAC/9k', 'data:image/jpeg;base64,YWJjZA==', 'data:image/jpeg;base64,/9j/4AACAA=='];
  for (const badPhoto of invalidPhotos) assert.equal((await f.call('PUT', { observations: [{ ...observation, photo: badPhoto }] })).status, 400, String(badPhoto));
  assert.equal((await f.call('GET')).status, 204);
});

test('per-photo and aggregate farm-state byte limits are independently enforced', async () => {
  const f = fixture();
  const jpegData = length => {
    const bytes = Buffer.alloc(length, 0);
    bytes.set([0xff, 0xd8, 0xff], 0);
    bytes.set([0xff, 0xd9], bytes.length - 2);
    return 'data:image/jpeg;base64,' + bytes.toString('base64');
  };
  const tooLarge = jpegData(62 * 1024);
  assert.ok(Buffer.byteLength(tooLarge) > 80 * 1024);
  assert.equal((await f.call('PUT', { observations: [{ ...observation, photo: tooLarge }] })).status, 413);
  const small = jpegData(50 * 1024);
  assert.ok(Buffer.byteLength(small) < 80 * 1024);
  assert.equal((await f.call('PUT', { observations: [{ ...observation, photo: small }] })).status, 200);
  const observations = Array.from({ length: 8 }, (_, index) => ({ ...observation, id: `note-${index}`, photo: small }));
  assert.ok(Buffer.byteLength(JSON.stringify({ observations })) > 512 * 1024);
  assert.equal((await f.call('PUT', { observations })).status, 413);
  assert.equal((await f.call('GET')).body.observations.length, 1);
});
