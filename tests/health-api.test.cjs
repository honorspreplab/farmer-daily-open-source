const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../api/health');
const { version } = require('../api/package.json');
const config = require('../staticwebapp.config.json');

test('public liveness returns only deployment status and version, never account data', async () => {
  const context = {};
  await health(context, { method: 'GET', headers: { 'x-ms-client-principal': 'untrusted' }, query: { userId: 'other-user' } });
  assert.equal(context.res.status, 200);
  assert.equal(context.res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(context.res.body, { status: 'ok', version });
  await health(context, { method: 'POST' });
  assert.equal(context.res.status, 405);
});

test('only liveness, isolated calendar assets and service-authenticated messaging callbacks are public; farmer APIs remain authenticated', () => {
  const healthIndex = config.routes.findIndex(route => route.route === '/api/health');
  const privateIndex = config.routes.findIndex(route => route.route === '/api/*');
  assert.ok(healthIndex >= 0 && healthIndex < privateIndex);
  assert.deepEqual(config.routes[healthIndex].methods, ['GET']);
  assert.deepEqual(config.routes[healthIndex].allowedRoles, ['anonymous']);
  assert.deepEqual(config.routes[privateIndex].allowedRoles, ['authenticated']);
  assert.deepEqual(config.routes.find(route => route.route === '/*').allowedRoles, ['authenticated']);
  assert.deepEqual(config.routes.filter(route => route.allowedRoles?.includes('anonymous')).map(route => route.route).sort(), [
    '/api/health', '/api/messaging-dispatch', '/api/messaging-webhook/*', '/calendar-callback.css', '/calendar-callback.js', '/calendar-callback/google', '/calendar-callback/outlook'
  ].sort());
  assert.equal(config.routes.filter(route => route.route.startsWith('/api/') && route.allowedRoles?.includes('anonymous')).length, 3);
  for (const path of ['/api/messaging-dispatch', '/api/messaging-webhook/*']) {
    const index = config.routes.findIndex(route => route.route === path);
    assert.ok(index < privateIndex); assert.deepEqual(config.routes[index].methods, ['POST']);
  }
});
