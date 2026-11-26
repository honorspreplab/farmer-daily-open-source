const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateApiPackage } = require('../scripts/validate-api-package.cjs');

function fixture(t, { manifest = {}, runtime = 'node:22', metadata = {}, script = 'module.exports = async function () {};', dependencyEngine, functionName = 'account' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farmer-api-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apiDirectory = path.join(directory, 'api');
  fs.mkdirSync(path.join(apiDirectory, functionName), { recursive: true });
  fs.writeFileSync(path.join(apiDirectory, 'package.json'), JSON.stringify({ private: true, ...manifest }));
  fs.writeFileSync(path.join(apiDirectory, functionName, 'function.json'), JSON.stringify(metadata));
  if (script !== null) fs.writeFileSync(path.join(apiDirectory, functionName, 'index.js'), script);
  const configFile = path.join(directory, 'staticwebapp.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ platform: { apiRuntime: runtime } }));
  if (dependencyEngine) {
    const dependencyDirectory = path.join(apiDirectory, 'node_modules', '@azure', 'cosmos');
    fs.mkdirSync(dependencyDirectory, { recursive: true });
    fs.writeFileSync(path.join(dependencyDirectory, 'package.json'), JSON.stringify({ engines: { node: dependencyEngine } }));
  }
  return { apiDirectory, configFile };
}

test('the actual deployment package loads every API handler and avoids reserved HTTP routes', () => {
  const result = validateApiPackage();
  assert.deepEqual(result.functions.sort(), ['account', 'ai-brief', 'brief', 'build-status', 'calendar-connections', 'farm-context', 'farm-operations', 'field-data', 'field-satellite', 'health', 'management', 'messaging', 'messaging-dispatch', 'messaging-webhook', 'state', 'weather']);
  assert.ok(result.dependencies.includes('@azure/cosmos'));
  assert.ok(result.dependencies.includes('geotiff'));
  assert.ok(result.dependencies.includes('proj4'));
});

test('missing package main blocks validation even when individual v3 functions work', t => {
  const options = fixture(t, { manifest: { main: 'index.js' } });
  assert.throws(() => validateApiPackage(options), /Declared package main does not exist/);
});

test('v3 package may omit main and use each function folder index.js', t => {
  assert.deepEqual(validateApiPackage(fixture(t)).functions, ['account']);
});

test('declared package main is loaded so startup exceptions cannot be missed', t => {
  const options = fixture(t, { manifest: { main: 'startup.js' } });
  fs.writeFileSync(path.join(options.apiDirectory, 'startup.js'), 'throw new Error("startup failed");');
  assert.throws(() => validateApiPackage(options), /Declared package main cannot load: startup failed/);
});

test('every function script must exist and export a callable handler', t => {
  assert.throws(() => validateApiPackage(fixture(t, { script: null })), /Function account script does not exist/);
  assert.throws(() => validateApiPackage(fixture(t, { script: 'module.exports = { broken: 1 };' })), /does not export a callable handler/);
});

test('explicit scriptFile and named entryPoint are resolved like Azure v3', t => {
  const options = fixture(t, { metadata: { scriptFile: '../shared-handler.js', entryPoint: 'handle' }, script: null });
  fs.writeFileSync(path.join(options.apiDirectory, 'shared-handler.js'), 'module.exports = { handle: async function () {}, helper: true };');
  assert.deepEqual(validateApiPackage(options).functions, ['account']);
});

test('configured Node major must meet installed direct dependency minimum', t => {
  const manifest = { dependencies: { '@azure/cosmos': '^4.3.1' } };
  assert.throws(() => validateApiPackage(fixture(t, { manifest, runtime: 'node:20', dependencyEngine: '>=22.0.0' })), /Node 20 does not satisfy @azure\/cosmos/);
  assert.equal(validateApiPackage(fixture(t, { manifest, dependencyEngine: '>=22.0.0' })).nodeMajor, 22);
});

test('missing installed dependencies fail before deployment', t => {
  const options = fixture(t, { manifest: { dependencies: { '@azure/cosmos': '^4.3.1' } } });
  assert.throws(() => validateApiPackage(options), /Cannot read deployment metadata.*cosmos/);
});

test('deployment rejects local workspace dependency links before resolving installed packages', t => {
  for (const spec of ['file:..','file:../private-project','link:..','workspace:*']) {
    const options = fixture(t, { manifest: { dependencies: { 'accidental-workspace': spec } } });
    assert.throws(() => validateApiPackage(options), /must not link to a local workspace/);
  }
});

test('explicit HTTP routes reject reserved host prefixes regardless of case or surrounding slashes', t => {
  for (const route of ['admin', 'runtime', 'AdMiN', 'RuNtImE', '/admin', 'admin/', '//ADMIN///', '/runtime/', 'administrator', 'runtime-status', 'admin/users']) {
    const options = fixture(t, { metadata: { bindings: [{ type: 'httpTrigger', route }] } });
    assert.throws(() => validateApiPackage(options), /conflicts with Azure Functions' reserved admin\/runtime routes/, route);
  }
});

test('missing, empty, null, or whitespace-only HTTP routes default to the function name', t => {
  for (const functionName of ['admin', 'RUNTIME', 'administrator']) {
    for (const route of [undefined, null, '', ' \t ']) {
      const options = fixture(t, { functionName, metadata: { bindings: [{ type: 'httpTrigger', route }] } });
      assert.throws(() => validateApiPackage(options), /conflicts with Azure Functions' reserved admin\/runtime routes/, `${functionName} with route ${JSON.stringify(route)}`);
    }
  }
  const options = fixture(t, { functionName: 'management', metadata: { bindings: [{ type: 'httpTrigger' }] } });
  assert.deepEqual(validateApiPackage(options).functions, ['management']);
});

test('nonreserved explicit HTTP routes work even when the function folder uses a reserved name', t => {
  for (const route of ['management', '/management/', 'membership/admin', 'membership/runtime']) {
    const options = fixture(t, { functionName: 'admin', metadata: { bindings: [{ type: 'httpTrigger', route }] } });
    assert.deepEqual(validateApiPackage(options).functions, ['admin'], route);
  }
});
