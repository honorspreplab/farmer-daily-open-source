const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'calendar-callback.js'), 'utf8');
const STATE = 'a'.repeat(43);
const principal = { userId: 'owner-a', identityProvider: 'aad', userRoles: ['authenticated'], userDetails: 'user@example.test' };

async function fixture({ url = `https://farm.example/calendar-callback/google?state=${STATE}&code=SECRET_AUTHORIZATION_CODE`, identity = principal, result = { connected: true, provider: 'google' }, failure, responseStatus = 200, mime = 'application/json' } = {}) {
  const calls = [], redirects = [], replacements = [], text = { textContent: '' }, listeners = {};
  const context = {
    URL, AbortController,
    location: { href: url, replace: target => redirects.push(target) },
    history: { replaceState: (state, title, target) => replacements.push(target) },
    document: { getElementById: id => { assert.equal(id, 'calendarCallbackStatus'); return text; } },
    window: { addEventListener: (event, handler) => { listeners[event] = handler; } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (target, options) => {
      assert.equal(replacements.length, 1, 'URL query is removed before the first request');
      calls.push({ target, options });
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      if (failure === target) throw new Error('SECRET_TOKEN must not be displayed');
      const value = target === '/.auth/me' ? { clientPrincipal: identity } : result;
      const status = target === '/.auth/me' ? 200 : responseStatus;
      return { ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': mime }), json: async () => value };
    },
    console: { log() { throw new Error('Callback must not log credentials'); }, error() { throw new Error('Callback must not log credentials'); } }
  };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('Callback must not use localStorage'); } });
  Object.defineProperty(context, 'sessionStorage', { get() { throw new Error('Callback must not use sessionStorage'); } });
  vm.runInNewContext(source, context);
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));
  return { calls, redirects, replacements, text, listeners };
}

test('calendar callback removes its query first and completes only for trusted signed-in owner', async () => {
  const f = await fixture();
  assert.deepEqual(f.replacements, ['/calendar-callback/google']);
  assert.deepEqual(f.calls.map(call => call.target), ['/.auth/me', '/api/calendar-connections']);
  const post = f.calls[1];
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['X-Farmer-Account-Id'], 'owner-a');
  assert.deepEqual(JSON.parse(post.options.body), { action: 'complete', provider: 'google', code: 'SECRET_AUTHORIZATION_CODE', state: STATE });
  assert.deepEqual(f.redirects, ['/?view=farmer&calendar=connected#connected']);
});

test('Outlook callback chooses its own provider and ignores arbitrary return destinations', async () => {
  const f = await fixture({ url: `https://farm.example/calendar-callback/outlook?state=${STATE}&code=abc&returnTo=https://evil.example/#private`, result: { connected: true, provider: 'outlook' } });
  assert.equal(JSON.parse(f.calls[1].options.body).provider, 'outlook');
  assert.deepEqual(f.replacements, ['/calendar-callback/outlook']);
  assert.deepEqual(f.redirects, ['/?view=farmer&calendar=connected#connected']);
});

test('cancelled authorization makes no identity, token or mutation request', async () => {
  const f = await fixture({ url: `https://farm.example/calendar-callback/google?state=${STATE}&error=access_denied&error_description=SECRET` });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.redirects, ['/?view=farmer&calendar=cancelled#connected']);
  assert.doesNotMatch(f.text.textContent, /SECRET/);
});

test('unknown callback paths and missing or duplicate state fail without network access', async () => {
  for (const suffix of ['/calendar-callback/evil?state='+STATE+'&code=abc', '/calendar-callback.html?state='+STATE+'&code=abc', '/calendar-callback/google?code=abc', '/calendar-callback/google?state=x&code=abc', `/calendar-callback/google?state=${STATE}&state=${STATE}&code=abc`]) {
    const f = await fixture({ url: 'https://farm.example' + suffix });
    assert.equal(f.calls.length, 0);
    assert.equal(f.redirects.length, 0);
    assert.match(f.text.textContent, /incomplete or expired/);
  }
});

test('blank, duplicate, oversized and control-character codes are rejected before posting', async () => {
  for (const codeQuery of ['', '&code=', '&code=a&code=b', '&code=a%0Ab', '&code='+'x'.repeat(12001)]) {
    const f = await fixture({ url: `https://farm.example/calendar-callback/google?state=${STATE}${codeQuery}` });
    assert.equal(f.calls.length, 0);
    assert.equal(f.redirects.length, 0);
    assert.match(f.text.textContent, /No valid authorization/);
  }
});

test('expired, non-Microsoft and unauthenticated identities cannot redeem a code', async () => {
  for (const identity of [null, { ...principal, identityProvider: 'google' }, { ...principal, userRoles: [] }, { ...principal, userId: '../other' }]) {
    const f = await fixture({ identity });
    assert.equal(f.calls.length, 1);
    assert.equal(f.redirects.length, 0);
    assert.match(f.text.textContent, /sign-in expired/);
  }
});

test('network and API failures disclose no sensitive provider content and never retry', async () => {
  for (const options of [{ failure: '/.auth/me' }, { failure: '/api/calendar-connections' }, { responseStatus: 409, result: { error: 'SECRET' } }, { responseStatus: 503 }, { mime: 'text/html' }]) {
    const f = await fixture(options);
    assert.equal(f.redirects.length, 0);
    assert.ok(f.calls.length <= 2);
    assert.match(f.text.textContent, /could not be confirmed.*reload connections/);
    assert.doesNotMatch(f.text.textContent, /SECRET/);
  }
});

test('malformed or mismatched success does not report a connection', async () => {
  for (const result of [null, {}, { connected: 'true', provider: 'google' }, { connected: true, provider: 'outlook' }]) {
    const f = await fixture({ result });
    assert.equal(f.redirects.length, 0);
    assert.match(f.text.textContent, /could not be confirmed/);
  }
});

test('leaving the isolated callback aborts in-flight work without resubmission', async () => {
  const f = await fixture();
  f.listeners.pagehide();
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.calls.length, 2);
});

test('callback routes/assets are isolated public no-store exceptions, never the farm shell', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'staticwebapp.config.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'calendar-callback.html'), 'utf8');
  for (const provider of ['google','outlook']) {
    const route = config.routes.find(item => item.route === `/calendar-callback/${provider}`);
    assert.deepEqual(route.allowedRoles, ['anonymous']);
    assert.equal(route.rewrite, '/calendar-callback.html');
    assert.equal(route.headers['Cache-Control'], 'no-store');
    assert.equal(route.headers['Referrer-Policy'], 'no-referrer');
    assert.match(route.headers['Content-Security-Policy'], /default-src 'none'/);
  }
  for (const file of ['calendar-callback.js','calendar-callback.css']) {
    const route = config.routes.find(item => item.route === `/${file}`);
    assert.deepEqual(route.allowedRoles, ['anonymous']);
    assert.equal(route.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(config.routes.find(item => item.route === '/api/*').allowedRoles, ['authenticated']);
  assert.doesNotMatch(html, /https:\/\/|src="(?:app|membership|connected-farm)\.js/);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  assert.doesNotMatch(worker.slice(0, worker.indexOf("self.addEventListener('install'")), /calendar-callback/);
  assert.match(worker, /url\.pathname\.startsWith\('\/calendar-callback'\)/);
});
