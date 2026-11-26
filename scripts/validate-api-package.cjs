const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read deployment metadata ${file}: ${error.message}`); }
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} does not exist: ${file}`);
  try { return require(file); }
  catch (error) { throw new Error(`${label} cannot load: ${error.message}`); }
}

// This v3 application uses CommonJS files, not v4 glob-based registration.
// Validate the package as Azure's worker sees it, before testing any handlers.
function validateApiPackage({
  apiDirectory = path.join(projectRoot, 'api'),
  configFile = path.join(projectRoot, 'staticwebapp.config.json')
} = {}) {
  apiDirectory = path.resolve(apiDirectory);
  const manifest = readJson(path.join(apiDirectory, 'package.json'));
  const config = readJson(configFile);
  const runtime = /^node:(\d+)$/.exec(config.platform?.apiRuntime || '');
  if (!runtime) throw new Error('Configure platform.apiRuntime as node:<major> in staticwebapp.config.json');
  const nodeMajor = Number(runtime[1]);

  if (manifest.main !== undefined) {
    if (typeof manifest.main !== 'string' || !manifest.main.trim() || /[*?{}[\]]/.test(manifest.main)) {
      throw new Error('This v3 API requires a literal package main file or, preferably, no main field');
    }
    // Node 20+ treats a missing package main as a fatal worker startup error,
    // even when individual function.json handlers are otherwise valid.
    requireFile(path.resolve(apiDirectory, manifest.main), 'Declared package main');
  }

  const dependencies = [];
  for (const name of Object.keys(manifest.dependencies || {})) {
    if (/^(?:file:|link:|workspace:)/i.test(manifest.dependencies[name])) {
      throw new Error(`Deployment dependency ${name} must not link to a local workspace; use a pinned published package`);
    }
    const dependencyFile = path.join(apiDirectory, 'node_modules', name, 'package.json');
    const dependency = readJson(dependencyFile);
    const engine = dependency.engines?.node;
    if (engine) {
      // Installed direct dependencies currently declare simple minimums.
      // Fail clearly if that changes instead of guessing at a semver range.
      const minimum = /^\s*>=\s*(\d+)(?:\.\d+){0,2}\s*$/.exec(engine);
      if (!minimum) throw new Error(`Unsupported Node engine range for ${name}: ${engine}; update the package validator`);
      if (nodeMajor < Number(minimum[1])) {
        throw new Error(`Configured Node ${nodeMajor} does not satisfy ${name}'s minimum Node engine ${engine}`);
      }
    }
    dependencies.push(name);
  }

  const functions = [];
  for (const directory of fs.readdirSync(apiDirectory, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.name === 'node_modules') continue;
    const functionDirectory = path.join(apiDirectory, directory.name);
    const metadataFile = path.join(functionDirectory, 'function.json');
    if (!fs.existsSync(metadataFile)) continue;
    const metadata = readJson(metadataFile);
    const httpTrigger = metadata.bindings?.find(binding => binding.type?.toLowerCase() === 'httptrigger');
    if (httpTrigger) {
      const route = typeof httpTrigger.route === 'string' && httpTrigger.route.trim()
        ? httpTrigger.route : directory.name;
      // Match ScriptHost.ValidateHttpFunction: default to the function name,
      // trim '/' only, then reject reserved prefixes before routePrefix is added.
      // https://github.com/Azure/azure-functions-host/blob/dev/src/WebJobs.Script/Host/ScriptHost.cs
      if (/^(admin|runtime)/i.test(route.replace(/^\/+|\/+$/g, ''))) {
        throw new Error(`Function ${directory.name} route "${route}" conflicts with Azure Functions' reserved admin/runtime routes`);
      }
    }
    const scriptFile = path.resolve(functionDirectory, metadata.scriptFile || 'index.js');
    if (!scriptFile.startsWith(`${apiDirectory}${path.sep}`)) {
      throw new Error(`Function ${directory.name} script must stay inside the deployed API directory`);
    }
    let handler = requireFile(scriptFile, `Function ${directory.name} script`);
    // Match the Azure v3 worker's named/default export resolution.
    if (handler !== null && typeof handler === 'object') {
      handler = metadata.entryPoint ? handler[metadata.entryPoint]
        : Object.keys(handler).length === 1 ? handler[Object.keys(handler)[0]]
          : handler.run || handler.index;
    }
    if (typeof handler !== 'function') throw new Error(`Function ${directory.name} does not export a callable handler`);
    functions.push(directory.name);
  }
  if (!functions.length) throw new Error('No function.json handlers were found in the API deployment');
  return { nodeMajor, functions, dependencies };
}

module.exports = { validateApiPackage };

if (require.main === module) {
  try {
    const result = validateApiPackage();
    console.log(`API package validated: Node ${result.nodeMajor}, ${result.functions.length} functions, ${result.dependencies.length} direct dependencies`);
  } catch (error) {
    console.error(`API package validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
