// Run with a locally installed Azure Functions Core Tools v4 executable:
// node scripts/test-function-routes.cjs <absolute-path-to-func.exe>
// Uses real host registration, not mocked routing. Never signs in or reads Cosmos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');

const projectRoot = path.resolve(__dirname, '..');
const func = process.argv[2];
assert.ok(func && path.isAbsolute(func) && fs.statSync(func).isFile(), 'Pass an absolute path to the installed func executable');

// Use no inherited farm-storage or telemetry configuration in either host.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/COSMOS|APPINSIGHTS|APPLICATIONINSIGHTS|^AzureWebJobsStorage|^OTEL_|^TWILIO_|^MESSAGING_|^OPENAI_|^AI_/i.test(key)) delete env[key];
}
Object.assign(env, {
  FUNCTIONS_WORKER_RUNTIME: 'node',
  FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: '1',
  AzureFunctionsJobHost__logging__fileLoggingMode: 'never'
});

const help = spawnSync(func, ['start', '--help'], { env, encoding: 'utf8', windowsHide: true });
assert.equal(help.status, 0, 'Azure Functions Core Tools must be installed before running the host smoke test');
const bindArgs = /--address\b/.test(help.stdout) ? ['--address', '127.0.0.1'] : [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startHost(scriptRoot, readinessPath) {
  assert.ok(!fs.existsSync(path.join(scriptRoot, 'local.settings.json')),
    `Refusing to load local.settings.json from ${scriptRoot}; run this no-credential test only without local settings`);
  const port = await freePort();
  const child = spawn(func, ['start', '--script-root', scriptRoot, '--port', String(port), ...bindArgs], {
    cwd: scriptRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let launchError;
  const collect = data => { output = (output + data.toString()).slice(-256000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', error => { launchError = error; });
  const origin = `http://127.0.0.1:${port}`;
  const request = (route, options = {}) => fetch(new URL(route, origin), { ...options, redirect: 'manual', signal: AbortSignal.timeout(3000) });
  const stop = async () => {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        // Only terminate this test's exact child PID and its worker descendants.
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
    }
  };
  try {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Azure Functions host exited with code ${child.exitCode}`);
      try {
        const response = await request(readinessPath);
        await response.text();
        if (response.status === 200) return { request, stop, output: () => output };
      } catch {}
      await pause(500);
    }
    throw new Error('Azure Functions host did not become ready within 120 seconds');
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${output.slice(-8000)}`);
  }
}

async function main() {
  const before = await startHost(path.join(projectRoot, 'tests', 'fixtures', 'function-routes'), '/api/control');
  try {
    const response = await before.request('/api/admin');
    assert.equal(response.status, 404, 'The reserved admin route must fail registration');
    await response.text();
    assert.match(before.output(), /specified route conflicts with one or more built in routes/i);
    console.log('Reproduced in Azure Functions host: reserved admin route rejected; HTTP 404.');
  } finally { await before.stop(); }

  const after = await startHost(path.join(projectRoot, 'api'), '/api/health');
  try {
    const { version } = require('../api/package.json');
    const health = await after.request('/api/health');
    assert.deepEqual(await health.json(), { status: 'ok', version });
    for (const route of ['/api/account', '/api/management', '/api/state', '/api/brief', '/api/ai-brief', '/api/weather', '/api/field-data', '/api/farm-context', '/api/field-satellite', '/api/build-status', '/api/farm-operations', '/api/calendar-connections', '/api/messaging']) {
      const response = await after.request(route);
      assert.equal(response.status, 401, `${route} must register and reject a request with no identity`);
      assert.match(response.headers.get('content-type') || '', /application\/json/i);
      assert.equal(typeof (await response.json()).error, 'string');
      console.log(`Actual API ${route}: registered, HTTP 401 without an identity.`);
    }
    for (const route of ['/api/messaging-webhook/inbound', '/api/messaging-webhook/status?dispatch=' + '0'.repeat(64), '/api/messaging-dispatch']) {
      const response = await after.request(route, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(response.status, 403, `${route} must register and reject missing provider or scheduler credentials`);
      assert.match(response.headers.get('content-type') || '', /application\/json/i);
      console.log(`Actual API ${route.split('?')[0]}: registered, HTTP 403 without service authentication.`);
    }
    assert.doesNotMatch(after.output(), /specified route conflicts with one or more built in routes/i);
    console.log(`Actual Azure Functions host smoke passed for ${version}. No accounts or farmer data accessed.`);
  } finally { await after.stop(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
