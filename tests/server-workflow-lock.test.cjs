const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped function, not a duplicate implementation. The shell,
// sync preflight and server responses are controllable isolation fixtures.
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = app.indexOf('async function runServerWorkflowRequest(callback){');
const end = app.indexOf('\nwindow.applyServerWorkflowState=', start);
assert.ok(start >= 0 && end > start, 'Shipped workflow coordinator exists');
const shipped = app.slice(start, end);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const preflights = [], calls = [], applied = [], shell = { inert: false };
  const context = vm.createContext({
    membership: { user: { id: 'owner-a' } },
    cloudEnabled: true,
    serverWorkflowPromise: null,
    membershipAllowsPremium: () => true,
    saveCloudState: () => { const pending = deferred(); preflights.push(pending); return pending.promise; },
    collectCloudState: () => ({ tasks: [], fields: [] }),
    applyServerWorkflowState: (state, owner) => applied.push({ state, owner }),
    setSyncStatus: text => calls.push(text),
    localStorage: { setItem() { throw new Error('Unexpected backup during lock test'); } },
    document: { querySelector: selector => selector === '.shell' ? shell : { hidden: true } }
  });
  vm.runInContext(shipped, context);
  return { context, preflights, calls, applied, shell, run: context.runServerWorkflowRequest };
}

for (const winningIndex of [0, 1]) {
  test(`two approvals awaiting sync permit only the first completed preflight (request ${winningIndex + 1})`, async () => {
    const f = fixture(), execution = deferred(), callbacks = [], loser = 1 - winningIndex;
    const requests = [0, 1].map(index => f.run(() => {
      callbacks.push(index);
      // A racing callback returning null used to release the first callback's
      // lock and re-enable the shell while its server mutation was pending.
      return index === winningIndex ? execution.promise : null;
    }));
    const rejected = assert.rejects(requests[loser], /Another workflow is still running/);
    assert.equal(f.preflights.length, 2);
    assert.equal(f.context.serverWorkflowPromise, null);
    f.preflights[winningIndex].resolve(true);
    await tick();
    const originalLock = f.context.serverWorkflowPromise;
    assert.ok(originalLock);
    assert.equal(f.shell.inert, true);
    assert.deepEqual(callbacks, [winningIndex]);
    let released = false;
    originalLock.then(() => { released = true; });
    f.preflights[loser].resolve(true);
    await rejected;
    await tick();
    assert.deepEqual(callbacks, [winningIndex], 'The second mutation callback never runs');
    assert.equal(f.context.serverWorkflowPromise, originalLock, 'The first execution retains its exact lock');
    assert.equal(f.shell.inert, true, 'Rejected racing approval cannot unlock user controls');
    assert.equal(released, false, 'Rejected racing approval cannot release waiting autosave');
    const result = { state: { tasks: [{ id: 'approved-once' }], workflowRevision: 1 } };
    execution.resolve(result);
    assert.equal(await requests[winningIndex], result);
    await tick();
    assert.equal(f.context.serverWorkflowPromise, null);
    assert.equal(f.shell.inert, false);
    assert.equal(released, true);
    assert.deepEqual(f.applied, [{ state: result.state, owner: 'owner-a' }]);
    assert.equal(f.context.cloudEnabled, true);
    assert.deepEqual(f.calls, []);
  });
}
