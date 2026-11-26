import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

const origin = new URL(process.argv[2] || 'https://calm-desert-02e51f41e.1.azurestaticapps.net');
assert.equal(origin.protocol, 'https:', 'Production checks require HTTPS');
const { version } = JSON.parse(await readFile(new URL('../api/package.json', import.meta.url), 'utf8'));
const request = (route, options = {}) => fetch(new URL(route, origin), {
  ...options,
  redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000)
});

// An HTTP redirect on a protected route proves authentication, not API startup.
// Probe the worker itself and match this release before checking access rules.
for (let attempt = 1; ; attempt += 1) {
  try {
    const response = await request('/api/health');
    assert.equal(response.status, 200, `API liveness returned HTTP ${response.status}`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.deepEqual(await response.json(), { status: 'ok', version });
    break;
  } catch (error) {
    if (attempt >= 3) throw error;
    console.log(`API startup check ${attempt} did not pass; retrying shortly.`);
    await pause(5000);
  }
}

await Promise.all(['/', '/admin.html', '/dev/status', '/api/account', '/api/management', '/api/state', '/api/brief', '/api/ai-brief', '/api/weather', '/api/field-data', '/api/farm-context', '/api/field-satellite', '/api/build-status', '/api/farm-operations', '/api/calendar-connections', '/api/messaging'].map(async route => {
  const response = await request(route);
  assert.equal(response.status, 302, `${route} must require sign-in`);
  const redirect = new URL(response.headers.get('location'), origin);
  assert.equal(redirect.origin, origin.origin);
  assert.equal(redirect.pathname, '/.auth/login/aad');
}));
for (const route of ['/api/messaging-webhook/inbound', '/api/messaging-webhook/status?dispatch=' + '0'.repeat(64), '/api/messaging-dispatch']) {
  const response = await request(route, { method: 'POST', headers: {'Content-Type':'application/json'}, body:'{}' });
  assert.equal(response.status, 403, `${route} must reject missing provider/scheduler authentication without redirecting`);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
}
for (const provider of ['google','outlook']) {
  const response = await request(`/calendar-callback/${provider}`);
  assert.equal(response.status, 200, 'Isolated callback page must load even after app sign-in expires');
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/);
  const html = await response.text();
  assert.match(html, /calendar-callback\.js/);
  assert.doesNotMatch(html, /src="(?:app|membership|connected-farm)\.js/);
}
console.log(`Live API ${version} started; all private routes require Microsoft sign-in. Individual route registration and signed-in account/data flows need separate checks; redirects and Azure's uploaded function list do not prove they work.`);
