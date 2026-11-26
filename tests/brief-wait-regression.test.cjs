'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the actual browser coordinators with fictional records, fake time,
// and deferred HTTP responses. Nothing contacts a provider or sends a message.
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const cloudStart = app.indexOf('let cloudEnabled=false,cloudSyncing=false,');
const cloudEnd = app.indexOf('const farmStorageKeys=', cloudStart);
assert.ok(cloudStart >= 0 && cloudEnd > cloudStart, 'Shipped cloud-save coordinator exists');
const membershipSource = fs.readFileSync(path.join(__dirname, '..', 'membership.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, type: 'basic', json: async () => data };
}
function brief(label = 'Saved priorities') {
  return { date: '2026-11-01', createdAt: '2026-11-01T18:00:00Z', summary: label, items: [label] };
}

function fixture(handleFetch = () => { throw new Error('Unexpected HTTP request'); }) {
  let now = 0, nextTimer = 1;
  const timers = new Map(), calls = [], nodes = new Map(), statuses = [], reloads = [];
  const storage = new Map([
    ['farmerDailyCloudOwner', 'owner-a'],
    ['farmerDailyProfile', JSON.stringify({ farmName: 'Fictional orchard', firstName: 'Demo' })],
    ['farmerDailyFields', '[]'], ['farmerDailyTasks', '[]'],
    ['farmerDailyRemoteUpdatedAt', 'previous-stamp']
  ]);
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      hidden: false, disabled: false, textContent: '', dataset: {}, children: [],
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
      setAttribute() {}, addEventListener() {}
    });
    return nodes.get(selector);
  }
  const context = vm.createContext({
    AbortController, Intl, URL, URLSearchParams, console,
    fetch: (url, options) => { calls.push({ url, options }); return handleFetch(url, options, calls.length); },
    setTimeout: (fn, milliseconds) => { const id = nextTimer++; timers.set(id, { fn, at: now + milliseconds }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    profile: { farmName: 'Fictional orchard', firstName: 'Demo' },
    readReadingPreferences: () => ({ enabled: false }),
    setSyncStatus: message => statuses.push(message),
    openProfileEditor() { throw new Error('Unexpected onboarding'); },
    document: {
      body: node('body'), hidden: false, querySelector: node, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => node(Symbol()), createTextNode: text => ({ textContent: text })
    },
    window: { addEventListener() {} },
    location: { search: '', reload: () => reloads.push(true), replace() {} }, waLocations: {}
  });
  vm.runInContext(membershipSource, context, { filename: 'membership.js' });
  vm.runInContext(app.slice(cloudStart, cloudEnd), context, { filename: 'app.js:cloud-save' });
  vm.runInContext("membership={user:{id:'owner-a'},plan:'free'};cloudEnabled=true;", context);
  const read = expression => vm.runInContext(expression, context);
  async function advance(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick();
    }
    now = target; await tick();
  }
  function switchOwner() {
    read("membership={user:{id:'owner-b'},plan:'free'};");
    storage.set('farmerDailyCloudOwner', 'owner-b');
  }
  const seedBrief = () => context.renderDailyBrief(brief());
  return { context, calls, node, storage, statuses, reloads, timers, read, advance, switchOwner, seedBrief };
}

test('many cloud-save waiters share one failed PUT rather than recursively retrying', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const saves = Array.from({ length: 30 }, () => f.context.saveCloudState());
  assert.equal(f.calls.length, 1);
  pending.resolve(response({ error: 'Unavailable' }, 503));
  assert.deepEqual(await Promise.all(saves), Array(30).fill(false));
  await f.advance(120000);
  assert.equal(f.calls.length, 1, 'No hidden multi-minute retry queue');
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'previous-stamp');
  assert.equal(f.read('cloudSavePromise'), null);
});

test('a later explicit save may retry after the failed shared attempt', async () => {
  const first = deferred(), f = fixture((_url, _options, count) => count === 1 ? first.promise : response({ updatedAt: 'new-stamp' }));
  const saves = [f.context.saveCloudState(), f.context.saveCloudState()];
  first.resolve(response({}, 503));
  assert.deepEqual(await Promise.all(saves), [false, false]);
  assert.equal(await f.context.saveCloudState(), true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'new-stamp');
});

test('successful saves coalesce identical payloads for all waiters', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const saves = Array.from({ length: 30 }, () => f.context.saveCloudState());
  pending.resolve(response({ updatedAt: 'new-stamp' }));
  assert.deepEqual(await Promise.all(saves), Array(30).fill(true));
  assert.equal(f.calls.length, 1);
  assert.equal(f.read('lastCloudPayload'), JSON.stringify(f.context.collectCloudState()));
  assert.equal(f.calls[0].options.headers['X-Farmer-Account-Id'], 'owner-a');
});

test('edits during a successful save produce only one shared follow-up PUT', async () => {
  const first = deferred(), second = deferred();
  const f = fixture((_url, _options, count) => count === 1 ? first.promise : second.promise);
  const saves = Array.from({ length: 20 }, () => f.context.saveCloudState());
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'scout', name: 'Scout north block' }]));
  first.resolve(response({ updatedAt: 'first-stamp' })); await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0].options.body).tasks.length, 0);
  assert.equal(JSON.parse(f.calls[1].options.body).tasks[0].id, 'scout');
  second.resolve(response({ updatedAt: 'second-stamp' }));
  assert.deepEqual(await Promise.all(saves), Array(20).fill(true));
  assert.equal(f.calls.length, 2);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'second-stamp');
});

test('a failed follow-up save is shared even when many callers observed edits during the first PUT', async () => {
  const first = deferred(), second = deferred();
  const f = fixture((_url, _options, count) => count === 1 ? first.promise : second.promise);
  const saves = Array.from({ length: 20 }, () => f.context.saveCloudState());
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'unsynced-task' }]));
  first.resolve(response({ updatedAt: 'first-stamp' })); await tick();
  second.resolve(response({}, 503));
  const results = await Promise.all(saves);
  assert.equal(results.filter(Boolean).length, 1, 'Only the original snapshot was saved');
  assert.equal(f.calls.length, 2, 'Failure does not spawn one retry for each remaining caller');
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'first-stamp');
  assert.equal(JSON.parse(f.storage.get('farmerDailyTasks'))[0].id, 'unsynced-task');
});

test('an account change during a save prevents stamps and waiter retries under the new owner', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const saves = Array.from({ length: 10 }, () => f.context.saveCloudState());
  f.switchOwner(); pending.resolve(response({ updatedAt: 'old-owner-result' }));
  assert.deepEqual(await Promise.all(saves), Array(10).fill(false));
  assert.equal(f.calls.length, 1);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'previous-stamp');
  assert.equal(f.read('lastCloudPayload'), '');
  assert.equal(f.statuses.filter(text => text === 'Protected in Azure').length, 0);
});

test('repeated build and scheduler calls share one save and one brief POST', async () => {
  const save = deferred(), build = deferred();
  const f = fixture(url => url === '/api/state' ? save.promise : build.promise);
  f.seedBrief();
  const builds = Array.from({ length: 30 }, () => f.context.loadDailyBrief(true));
  assert.equal(f.calls.length, 1); assert.equal(f.node('#dailyBriefBtn').disabled, true);
  save.resolve(response({ updatedAt: 'saved' })); await tick();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/state', '/api/brief']);
  assert.equal(f.calls[1].options.method, 'POST');
  build.resolve(response({ brief: brief('New priorities') }));
  const results = await Promise.all(builds);
  assert.equal(results.length, 30); assert.ok(results.every(result => result.brief.summary === 'New priorities'));
  assert.equal(f.calls.length, 2);
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.equal(f.node('#dailyBriefRefreshBtn').disabled, false);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'New priorities');
});

test('brief preflight waits for edits made during its original save before posting', async () => {
  const first = deferred(), second = deferred();
  let stateRequests = 0;
  const f = fixture(url => {
    if (url === '/api/state') return ++stateRequests === 1 ? first.promise : second.promise;
    return response({ brief: brief('Includes current tasks') });
  });
  const build = f.context.loadDailyBrief(true);
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'new-task', name: 'Check orchard' }]));
  const autosave = f.context.saveCloudState();
  first.resolve(response({ updatedAt: 'original-snapshot' })); await tick();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url === '/api/state'), 'Brief POST must wait for current edits');
  assert.equal(JSON.parse(f.calls[1].options.body).tasks[0].id, 'new-task');
  assert.equal(f.node('#dailyBriefBtn').disabled, true);
  second.resolve(response({ updatedAt: 'current-snapshot' }));
  await Promise.all([build, autosave]);
  assert.equal(stateRequests, 2, 'Preflight and autosave share the edit-flush PUT');
  assert.deepEqual(f.calls.map(call => call.url), ['/api/state', '/api/state', '/api/brief']);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Includes current tasks');
});

test('flushing edits shares the original sync deadline and cannot resume with late saves or a brief POST', async () => {
  const first = deferred(), second = deferred();
  const f = fixture((_url, _options, count) => count === 1 ? first.promise : second.promise);
  f.seedBrief(); const build = f.context.loadDailyBrief(true);
  await f.advance(6000);
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'second-snapshot' }]));
  first.resolve(response({ updatedAt: 'original-snapshot' })); await tick();
  assert.equal(f.calls.length, 2);
  await f.advance(4001); await build;
  assert.match(f.node('#dailyBriefStatus').textContent, /sync.*too long/i);
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'newer-unsynced-edit' }]));
  second.resolve(response({ updatedAt: 'late-second-snapshot' })); await tick();
  assert.equal(f.calls.length, 2, 'Timed-out preflight cannot schedule a third PUT or a brief POST');
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  assert.equal(JSON.parse(f.storage.get('farmerDailyTasks'))[0].id, 'newer-unsynced-edit');
});

test('changing accounts during the edit-flush PUT cannot trigger a further save, brief, or stamp', async () => {
  const first = deferred(), second = deferred();
  const f = fixture((_url, _options, count) => count === 1 ? first.promise : second.promise);
  const build = f.context.loadDailyBrief(true);
  f.storage.set('farmerDailyTasks', JSON.stringify([{ id: 'edit' }]));
  first.resolve(response({ updatedAt: 'first-stamp' })); await tick();
  assert.equal(f.calls.length, 2);
  f.switchOwner(); second.resolve(response({ updatedAt: 'old-owner-stamp' })); await build;
  assert.equal(f.calls.length, 2);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'first-stamp');
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
});

test('a saved-brief GET queues at most one requested build and preserves refresh intent', async () => {
  const saved = deferred(), build = deferred();
  const f = fixture((url, options) => url === '/api/state' ? response({}) : options.method === 'POST' ? build.promise : saved.promise);
  const read = f.context.loadDailyBrief();
  const builds = Array.from({ length: 20 }, () => f.context.loadDailyBrief(true, true));
  assert.equal(f.calls.length, 1);
  saved.resolve(response({ brief: brief() })); await read; await tick();
  assert.deepEqual(f.calls.map(call => [call.url, call.options.method || 'GET']), [
    ['/api/brief', 'GET'], ['/api/state', 'PUT'], ['/api/brief', 'POST']
  ]);
  assert.equal(JSON.parse(f.calls[2].options.body).refresh, true);
  build.resolve(response({ brief: brief('Refreshed') })); await Promise.all(builds);
  assert.equal(f.calls.length, 3);
});

test('a queued build does not cross accounts when the initial GET finishes', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const read = f.context.loadDailyBrief();
  const build = f.context.loadDailyBrief(true);
  f.switchOwner(); pending.resolve(response({ brief: brief('Owner A only') }));
  await Promise.all([read, build]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.read('savedDailyBrief'), null);
  assert.equal(f.read('queuedDailyBriefRequest'), null);
});

test('a queued build gives up after its read-wait deadline and does not build automatically when the read finishes late', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const read = f.context.loadDailyBrief();
  const builds = Array.from({ length: 20 }, () => f.context.loadDailyBrief(true));
  await f.advance(5001); await Promise.all(builds);
  assert.match(f.node('#dailyBriefStatus').textContent, /still loading.*retry/i);
  assert.equal(f.read('queuedDailyBriefRequest'), null);
  pending.resolve(response({ brief: brief() })); await read; await tick();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/brief']);
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
});

test('a hung farm sync releases brief controls after its deadline, retains the old brief, and never posts late', async () => {
  const save = deferred(), f = fixture(() => save.promise);
  f.seedBrief();
  const build = f.context.loadDailyBrief(true);
  await f.advance(10001); await build;
  assert.match(f.node('#dailyBriefStatus').textContent, /sync.*too long.*changes were kept/i);
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.equal(f.node('#dailyBriefRefreshBtn').disabled, false);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  assert.equal(f.read('dailyBriefRequest'), null);
  save.resolve(response({ updatedAt: 'late-sync' })); await tick();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/state']);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
});

test('failed sync shared by autosaves and a build returns promptly with no brief POST', async () => {
  const save = deferred(), f = fixture(() => save.promise);
  f.seedBrief();
  const saves = Array.from({ length: 25 }, () => f.context.saveCloudState());
  const build = f.context.loadDailyBrief(true);
  save.resolve(response({}, 503));
  await Promise.all([...saves, build]);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/state']);
  assert.match(f.node('#dailyBriefStatus').textContent, /could not sync.*changes were kept/i);
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
});

test('switching accounts while brief preflight saves prevents any brief POST or old-owner stamp', async () => {
  const save = deferred(), f = fixture(() => save.promise);
  const build = f.context.loadDailyBrief(true);
  f.switchOwner(); save.resolve(response({ updatedAt: 'owner-a-stamp' })); await build;
  assert.deepEqual(f.calls.map(call => call.url), ['/api/state']);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'previous-stamp');
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
});

test('a workflow lock cannot make brief preflight wait forever or write under a switched account', async () => {
  const workflow = deferred(), f = fixture();
  f.context.pendingWorkflow = workflow.promise;
  f.read('serverWorkflowPromise=pendingWorkflow;');
  f.seedBrief(); const build = f.context.loadDailyBrief(true);
  await f.advance(10001); await build;
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.match(f.node('#dailyBriefStatus').textContent, /sync.*too long/i);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  f.switchOwner(); workflow.resolve(); await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'), 'previous-stamp');
  assert.equal(f.read('cloudEnabled'), false);
});

for (const hang of ['fetch', 'JSON body']) {
  test(`memberFetch enforces a whole-response deadline when ${hang} ignores abort`, async () => {
    const pending = deferred();
    const f = fixture(() => hang === 'fetch' ? pending.promise : { ...response(null), json: () => pending.promise });
    const request = f.context.memberFetch('/api/brief', {}, 25000);
    const rejected = assert.rejects(request, /took too long.*retry/i);
    await tick(); await f.advance(25001); await rejected;
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.timers.size, 0);
    pending.resolve(hang === 'fetch' ? response({ brief: brief('Late') }) : { brief: brief('Late') });
    await tick();
    assert.equal(f.read('savedDailyBrief'), null);
  });
}

test('a stalled brief response releases controls, retains saved content, and ignores the late result', async () => {
  const pending = deferred();
  const f = fixture(url => url === '/api/state' ? response({}) : { ...response(null), json: () => pending.promise });
  f.seedBrief(); const build = f.context.loadDailyBrief(true); await tick();
  await f.advance(25001); await build;
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
  assert.equal(f.node('#dailyBriefRefreshBtn').disabled, false);
  assert.match(f.node('#dailyBriefStatus').textContent, /took too long.*retry/i);
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  pending.resolve({ brief: brief('Late data must not overwrite') }); await tick();
  assert.equal(f.node('#dailyBriefSummary').textContent, 'Saved priorities');
  assert.equal(f.read('dailyBriefRequest'), null);
  assert.equal(f.timers.size, 0);
});

test('a new build is possible after a timed-out response without accumulating a hidden retry queue', async () => {
  let briefRequests = 0;
  const f = fixture(url => {
    if (url === '/api/state') return response({});
    briefRequests += 1;
    return briefRequests === 1 ? new Promise(() => {}) : response({ brief: brief('Recovered') });
  });
  const first = f.context.loadDailyBrief(true); await tick();
  await f.advance(25001); await first;
  const recovered = await f.context.loadDailyBrief(true);
  assert.equal(recovered.brief.summary, 'Recovered');
  assert.equal(briefRequests, 2);
  assert.equal(f.calls.filter(call => call.url === '/api/state').length, 1, 'Already saved data is not redundantly PUT');
  assert.equal(f.node('#dailyBriefBtn').disabled, false);
});
