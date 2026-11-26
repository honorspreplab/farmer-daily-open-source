'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function response(status, data, { html = false, invalidJson = false } = {}) {
  return {
    status, ok: status >= 200 && status < 300, type: 'basic',
    headers: { get: () => html ? 'text/html' : 'application/json' },
    json: async () => {
      if (html || invalidJson) throw new SyntaxError('Invalid JSON');
      return data;
    }
  };
}

function harness(filename, fetch, { search = '' } = {}) {
  const nodes = new Map();
  const cleared = [];
  const replacements = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, inert: false, textContent: '', dataset: {}, listeners: {},
      replaceChildren() {}, append() {}, setAttribute() {},
      addEventListener(name, listener) { this.listeners[name] = listener; }
    });
    return nodes.get(id);
  }
  const context = vm.createContext({
    fetch, AbortController, Intl, URL, URLSearchParams, console,
    setTimeout: () => 1, clearTimeout: id => cleared.push(id), setInterval: () => 1,
    document: {
      body: node('body'), hidden: false,
      getElementById: node, querySelector: node, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => node(Symbol()), createDocumentFragment: () => node(Symbol())
    },
    window: { addEventListener() {} }, location: { search, reload() {}, replace: destination => replacements.push(destination) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, { filename });
  return { context, node, cleared, replacements };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('server-confirmed administrators land in the portal before farm initialization', async () => {
  for (const email of ['admin1@example.invalid', 'admin2@example.invalid', 'admin3@example.invalid']) {
    const account = { user: { id: 'verified-admin', email }, isAdmin: true, plan: 'premium', request: null };
    const calls = [];
    const { context, node, replacements } = harness('membership.js', async url => {
      calls.push(url);
      return response(200, account);
    });
    await context.refreshMembership(true);
    assert.deepEqual(replacements, ['/admin.html']);
    assert.deepEqual(calls, ['/api/account']);
    assert.equal(await vm.runInContext('membershipReady', context), null, 'No farmer-state boot while navigating to administration');
    assert.equal(node('.shell').inert, true);
    assert.equal(node('#accountGate').hidden, false);
    assert.match(node('#accountGateMessage').textContent, /admin portal/i);
  }
});

test('admin Back to app is explicit, repeatable, and does not loop on refresh', async () => {
  const account = { user: { id: 'verified-admin', email: 'admin@example.test' }, isAdmin: true, plan: 'premium' };
  const { context, replacements } = harness('membership.js', async () => response(200, account), { search: '?view=farmer' });
  await context.refreshMembership(true);
  await context.refreshMembership(false);
  assert.deepEqual(replacements, []);
  assert.equal((await vm.runInContext('membershipReady', context)).user.id, account.user.id);
});

test('client email, plan, and query flags do not grant admin routing or custom redirect destinations', async () => {
  for (const plan of ['free', 'premium']) {
    const account = { user: { id: 'farmer', email: 'admin1@example.invalid' }, isAdmin: false, plan };
    const { context, replacements } = harness('membership.js', async () => response(200, account), { search: '?isAdmin=true&redirect=/admin.html' });
    await context.refreshMembership(true);
    assert.deepEqual(replacements, []);
    assert.equal((await vm.runInContext('membershipReady', context)).isAdmin, false);
  }
  const { context, replacements } = harness('membership.js', async () => response(200, { user: { id: 'admin' }, isAdmin: true, plan: 'premium' }), { search: '?redirect=https://example.invalid&view=admin' });
  await context.refreshMembership(true);
  assert.deepEqual(replacements, ['/admin.html']);
});

test('main screen explains HTML 404 and 5xx service failures without unlocking the farm', async () => {
  for (const status of [404, 500, 502, 503]) {
    const { context, node, cleared } = harness('membership.js', async () => response(status, null, { html: true }));
    assert.equal(await context.refreshMembership(true), null);
    assert.match(node('#accountGateMessage').textContent, /account service is temporarily unavailable/);
    assert.match(node('#accountGateMessage').textContent, new RegExp(`HTTP ${status}`));
    assert.equal(node('#accountGate').hidden, false);
    assert.equal(node('.shell').inert, true);
    assert.equal(node('#accountRetryBtn').hidden, false);
    assert.equal(node('#accountSignIn').hidden, true);
    assert.equal(vm.runInContext('membership', context), null);
    assert.deepEqual(cleared, [1]);
  }
});

test('main screen keeps authentication errors and account guards distinct', async () => {
  for (const status of [401, 302]) {
    const { context, node } = harness('membership.js', async () => response(status, null, { html: true }));
    await context.refreshMembership(true);
    assert.match(node('#accountGateMessage').textContent, /sign in again/);
    assert.equal(node('#accountSignIn').hidden, false);
    assert.equal(node('.shell').inert, true);
  }
  const { context } = harness('membership.js', async (_url, options) => {
    assert.equal(options.headers['X-Farmer-Account-Id'], 'farmer-one');
    return response(409, { error: 'Your signed-in account changed. Please reload.' });
  });
  vm.runInContext("membership = { user: { id: 'farmer-one' }, plan: 'free' };", context);
  await assert.rejects(context.memberFetch('/api/state'), error => error.status === 409 && /account changed/.test(error.message));
});

test('main screen gives retryable timeout, network, and malformed-response messages', async () => {
  for (const [name, expected] of [['AbortError', /took too long.*retry/i], ['TypeError', /Check your connection and retry/]]) {
    const { context, node, cleared } = harness('membership.js', async () => { throw Object.assign(new Error('browser detail'), { name }); });
    await context.refreshMembership(true);
    assert.match(node('#accountGateMessage').textContent, expected);
    assert.equal(node('.shell').inert, true);
    assert.deepEqual(cleared, [1]);
  }
  const { context, node } = harness('membership.js', async () => response(200, null, { html: true }));
  await context.refreshMembership(true);
  assert.match(node('#accountGateMessage').textContent, /unexpected response.*retry/i);
  assert.equal(node('#accountSignIn').hidden, true);
  assert.equal(node('.shell').inert, true);
});

test('valid JSON null and HTTP 204 are empty state, not malformed responses', async () => {
  for (const makeResponse of [
    () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => new Response(null, { status: 204 })
  ]) {
    const { context } = harness('membership.js', async () => makeResponse());
    assert.equal(await context.memberFetch('/api/state'), null);
    assert.equal(await context.memberFetch('/api/state?export=1'), null);
    assert.equal(vm.runInContext('membership', context), null, 'An empty state is not an identity or access grant');
  }
});

test('malformed or empty HTTP 200 still fails closed; null account is incomplete', async () => {
  for (const body of ['', '<html>Sign in</html>', '{']) {
    const { context, node } = harness('membership.js', async () => new Response(body, { status: 200 }));
    await assert.rejects(context.memberFetch('/api/state'), /unexpected response/);
    await context.refreshMembership(true);
    assert.equal(node('.shell').inert, true);
    assert.equal(node('#accountGate').hidden, false);
  }
  const { context, node } = harness('membership.js', async () => new Response('null', { status: 200 }));
  await context.refreshMembership(true);
  assert.match(node('#accountGateMessage').textContent, /incomplete response/);
  assert.equal(node('.shell').inert, true);
});

test('admin screen explains unavailable service without treating it as denied access', async () => {
  for (const status of [404, 500, 502, 503]) {
    let calls = 0;
    const { node, cleared } = harness('admin.js', async () => { calls += 1; return response(status, null, { html: true }); });
    await settle();
    assert.equal(node('accessTitle').textContent, 'Account service unavailable');
    assert.match(node('accessCopy').textContent, new RegExp(`temporarily unavailable \\(HTTP ${status}\\)`));
    assert.equal(node('adminContent').hidden, true);
    assert.equal(node('retryAccess').hidden, false);
    assert.equal(node('signInLink').hidden, true);
    assert.equal(calls, 1, 'must not query private accounts after a failed access check');
    assert.deepEqual(cleared, [1]);
  }
});

test('admin screen retains real sign-in and administrator-denial states', async () => {
  for (const status of [401, 302, 403]) {
    const { node } = harness('admin.js', async () => response(status, null, { html: true }));
    await settle();
    assert.equal(node('accessTitle').textContent, status === 403 ? 'Administrator access only' : 'Sign in to continue');
    assert.equal(node('adminContent').hidden, true);
    assert.equal(node('signInLink').hidden, status === 403);
    assert.equal(node('retryAccess').hidden, true);
  }
});

test('admin screen keeps timeout and invalid responses retryable without suggesting sign-in', async () => {
  const scenarios = [
    [async () => { throw Object.assign(new Error('timed out'), { name: 'AbortError' }); }, /took too long.*retry/i],
    [async () => { throw new TypeError('Failed to fetch'); }, /Check your connection and retry/],
    [async () => response(200, null, { html: true }), /unexpected response.*retry/i],
    [async () => response(200, null, { invalidJson: true }), /unexpected response.*retry/i]
  ];
  for (const [fetch, expected] of scenarios) {
    const { node } = harness('admin.js', fetch);
    await settle();
    assert.equal(node('accessTitle').textContent, 'Account service unavailable');
    assert.match(node('accessCopy').textContent, expected);
    assert.equal(node('retryAccess').hidden, false);
    assert.equal(node('signInLink').hidden, true);
    assert.equal(node('adminContent').hidden, true);
  }
});

test('admin retry checks access again before requesting any account list', async () => {
  let calls = 0;
  const { node } = harness('admin.js', async url => {
    assert.equal(url, '/api/account');
    calls += 1;
    return calls === 1 ? response(503, null, { html: true }) : response(200, { isAdmin: false, user: { id: 'free-farmer' } });
  });
  await settle();
  await node('retryAccess').listeners.click();
  assert.equal(calls, 2);
  assert.equal(node('accessTitle').textContent, 'Administrator access only');
  assert.equal(node('adminContent').hidden, true);
});

test('incomplete account payloads are service errors, never access grants or admin denials', async () => {
  for (const account of [null, {}, { isAdmin: true, user: {} }]) {
    let calls = 0;
    const { node } = harness('admin.js', async () => { calls += 1; return response(200, account); });
    await settle();
    assert.equal(node('accessTitle').textContent, 'Account service unavailable');
    assert.match(node('accessCopy').textContent, /incomplete response.*retry/i);
    assert.equal(node('adminContent').hidden, true);
    assert.equal(node('retryAccess').hidden, false);
    assert.equal(calls, 1);
  }
});
