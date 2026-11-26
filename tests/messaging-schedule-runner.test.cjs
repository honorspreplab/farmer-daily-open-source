const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const load = () => import('../scripts/run-messaging-schedule.mjs');
const origin = 'https://calm-desert-02e51f41e.1.azurestaticapps.net';
const env = { FARMER_MESSAGING_SCHEDULE_ENABLED: 'true', APP_ORIGIN: origin, MESSAGING_DISPATCH_KEY: 'synthetic_scheduler_test_key_not_a_real_secret_123' };
const body = overrides => ({ processed: 1, accepted: 1, failed: 0, skipped: 0, nextCursor: null, ...overrides });
const reply = overrides => new Response(JSON.stringify(body(overrides)), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });

test('scheduler requires explicit enablement, exact approved HTTPS origin and strong header key before network access', async () => {
  const { runMessagingSchedule, configuration } = await load();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return reply(); };
  for (const change of [
    { FARMER_MESSAGING_SCHEDULE_ENABLED: undefined }, { FARMER_MESSAGING_SCHEDULE_ENABLED: 'false' }, { FARMER_MESSAGING_SCHEDULE_ENABLED: true },
    { APP_ORIGIN: undefined }, { APP_ORIGIN: '' }, { APP_ORIGIN: origin.replace('https:', 'http:') },
    { APP_ORIGIN: 'https://example.com' }, { APP_ORIGIN: `${origin}.example.com` }, { APP_ORIGIN: `${origin}:444` },
    { APP_ORIGIN: `${origin}/api` }, { APP_ORIGIN: `${origin}?key=x` }, { APP_ORIGIN: `${origin}#x` },
    { APP_ORIGIN: `${origin}\n` }, { APP_ORIGIN: `https://user:password@${new URL(origin).hostname}` },
    { MESSAGING_DISPATCH_KEY: undefined }, { MESSAGING_DISPATCH_KEY: 'x'.repeat(42) }, { MESSAGING_DISPATCH_KEY: 'x'.repeat(129) },
    { MESSAGING_DISPATCH_KEY: `${'x'.repeat(43)}\n` }, { MESSAGING_DISPATCH_KEY: ` ${'x'.repeat(43)}` },
    { MESSAGING_DISPATCH_KEY: `${'x'.repeat(43)}=` }, { MESSAGING_DISPATCH_KEY: `${'x'.repeat(43)}+` }
  ]) await assert.rejects(runMessagingSchedule({ env: { ...env, ...change }, fetchImpl }), /stopped safely/);
  assert.equal(calls, 0);
  assert.equal(configuration({ ...env, APP_ORIGIN: `${origin}/` }).endpoint, `${origin}/api/messaging-dispatch`);
  assert.equal(configuration({ ...env, MESSAGING_DISPATCH_KEY: `${'A'.repeat(43)}_-` }).key.length, 45);
});

test('scheduler POSTs only an opaque pagination cursor and prints aggregate results, not private content', async () => {
  const { runMessagingSchedule, main } = await load(), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return reply(calls.length === 1 ? { nextCursor: 'opaque_cursor_1', privateFarm: 'never log this' } : { processed: 2, accepted: 0, failed: 0, skipped: 2 });
  };
  const result = await runMessagingSchedule({ env, fetchImpl });
  assert.deepEqual(result, { pages: 2, processed: 3, accepted: 1, failed: 0, skipped: 2, complete: true, stopReason: 'complete' });
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body)), [{}, { cursor: 'opaque_cursor_1' }]);
  for (const { url, options } of calls) {
    assert.equal(url, `${origin}/api/messaging-dispatch`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { 'content-type': 'application/json', 'x-farmer-messaging-key': env.MESSAGING_DISPATCH_KEY });
    assert.ok(options.signal instanceof AbortSignal);
  }
  const output = [];
  assert.equal(await main({ env, fetchImpl: async () => reply({ privateFarm: 'private address' }), write: text => output.push(text) }), 0);
  assert.match(output.join(''), /1 accepted by provider/);
  assert.doesNotMatch(output.join(''), /private address|synthetic.scheduler|opaque_cursor/);
});

test('HTTP errors, redirects, provider bodies and thrown network secrets are never replayed or logged', async () => {
  const { main } = await load();
  for (const fetchResult of [
    () => new Response('private phone token secret', { status: 302, headers: { location: 'https://evil.example/' } }),
    () => new Response('private phone token secret', { status: 500 }),
    () => new Response('<html>private phone token secret</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => { throw new Error(`private phone token secret ${env.MESSAGING_DISPATCH_KEY}`); },
    () => new Response('{invalid private phone token secret', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => { const response = reply(); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => { const response = reply(); Object.defineProperty(response, 'url', { value: 'https://evil.example/' }); return response; }
  ]) {
    let count = 0;
    const output = [];
    const code = await main({ env, fetchImpl: async () => { count += 1; return fetchResult(); }, write: text => output.push(text) });
    assert.equal(code, 1);
    assert.equal(count, 1);
    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0], /private phone|token secret|synthetic.scheduler|evil\.example/);
    assert.match(output[0], /No automatic retry/);
  }
});

test('untrusted counts and cursors stop pagination without printing their values', async () => {
  const { runMessagingSchedule } = await load();
  for (const overrides of [
    { processed: -1 }, { accepted: '1' }, { failed: 0.1 }, { skipped: 10001 },
    { nextCursor: '' }, { nextCursor: undefined }, { nextCursor: 'https://evil.example' },
    { nextCursor: 'hello\r\nsecret' }, { nextCursor: 'a'.repeat(16001) }, { nextCursor: {} }
  ]) await assert.rejects(runMessagingSchedule({ env, fetchImpl: async () => reply(overrides) }), /stopped safely/);
});

test('large JSON bodies and announced oversized responses stop before further pages', async () => {
  const { runMessagingSchedule } = await load();
  for (const make of [
    () => reply({ extra: 'a'.repeat(33000) }),
    () => new Response(JSON.stringify(body()), { headers: { 'content-type': 'application/json', 'content-length': '33000' } })
  ]) await assert.rejects(runMessagingSchedule({ env, fetchImpl: async () => make() }), /stopped safely/);
});

test('pagination is limited to twenty requests and repeated cursors never loop', async () => {
  const { runMessagingSchedule } = await load();
  let count = 0;
  const result = await runMessagingSchedule({ env, fetchImpl: async () => reply({ nextCursor: `page_${++count}` }) });
  assert.equal(count, 20);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'page_limit');
  assert.equal(result.accepted, 20);
  count = 0;
  await assert.rejects(runMessagingSchedule({ env, fetchImpl: async () => { count += 1; return reply({ nextCursor: 'same' }); } }), /stopped safely/);
  assert.equal(count, 2);
});

test('the overall five-minute budget stops pagination, without a catch-up retry', async () => {
  const { runMessagingSchedule } = await load();
  let time = 0, count = 0;
  const result = await runMessagingSchedule({ env, now: () => time, fetchImpl: async () => { count += 1; time += 300000; return reply({ nextCursor: 'another' }); } });
  assert.equal(count, 1);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'time_limit');
});

test('failed deliveries produce nonzero runner status even if all pages were scanned', async () => {
  const { main } = await load();
  const output = [];
  assert.equal(await main({ env, fetchImpl: async () => reply({ accepted: 0, failed: 1 }), write: text => output.push(text) }), 1);
  assert.match(output[0], /1 failed/);
});

test('schedule example remains inactive, opt-in, read-only and concurrency guarded', () => {
  const template = readFileSync(resolve(__dirname, '../infra/messaging-schedule.example.yml'), 'utf8');
  assert.equal(existsSync(resolve(__dirname, '../.github/workflows/messaging-schedule.yml')), false);
  assert.match(template, /FARMER_MESSAGING_SCHEDULE_ENABLED == 'true'/);
  assert.match(template, /cron: '17 \* \* \* \*'/);
  assert.match(template, /contents: read/);
  assert.match(template, /cancel-in-progress: false/);
  assert.match(template, /persist-credentials: false/);
  assert.match(template, /APP_ORIGIN: \$\{\{ vars\.APP_ORIGIN \}\}/);
  assert.match(template, /MESSAGING_DISPATCH_KEY: \$\{\{ secrets\.MESSAGING_DISPATCH_KEY \}\}/);
  assert.match(template, /best-effort/);
  assert.doesNotMatch(template, /pull_request|\bpush:|npm install|npm ci/);
});
