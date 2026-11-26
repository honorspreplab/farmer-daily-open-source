'use strict';
const { getContainer: defaultContainer } = require('../shared/store');
const { createAccess, principalFrom, header, HttpError, respond, handleError } = require('../shared/access');
const { VERSION, snapshot, assertCurrent, token, tokenMatches } = require('../shared/ai-evidence');
const { configuration, route, exactKeys, writerPayload, createProvider, answerFromResponse } = require('../shared/ai-provider');
const { reserveMicros, reserveUser, reserveGlobal, dayKey } = require('../shared/ai-budget');
const { toolPreview, plannerPayload, validateCalls, createTools } = require('../shared/ai-tools');
const TASKS = ['daily','summary','explain','compare'], MODES = ['auto','economy','analysis'];
function requestBody(body) {
  if (!exactKeys(body, ['task','mode','consent','consentVersion','previewToken']) || !TASKS.includes(body.task) || !MODES.includes(body.mode) || body.consent !== true || body.consentVersion !== VERSION || typeof body.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewToken)) throw new HttpError(400, 'Choose an approved task and model mode, then consent to the current evidence and read-only tool scope.');
  return body;
}
function createAiBriefHandler({ getContainer = defaultContainer, now = Date.now, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 22000, weatherHandler, satelliteService, farmContextService } = {}) {
  const access = createAccess({ getContainer, now }), invoke = createProvider({ fetchImpl, timeoutMs });
  const runTool = createTools({ getContainer, fetchImpl, now, weatherHandler, satelliteService, farmContextService });
  return async function aiBrief(context, req) {
    try {
      if (!['GET','POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const principal = principalFrom(req);
      if (!principal) throw new HttpError(401, 'Sign in to Farmer Daily');
      if (!header(req, 'x-farmer-account-id')) throw new HttpError(400, 'Reload Farmer Daily to verify the active account.');
      await access.requireAccess(req);
      const config = configuration(env), container = getContainer();
      let saved = await snapshot(container, principal.id, now());
      if (req.method === 'GET') return respond(context, 200, {
        enabled: config.enabled, reason: config.reason || (!saved ? 'Save your farm and generate today\'s rule-based brief first.' : ''), models: config.models,
        dailyLimitUsd: config.dailyLimitUsd, consentVersion: VERSION, evidence: saved?.evidence || null,
        previewToken: saved ? token(saved) : null, available: Boolean(saved), toolPreview: toolPreview(saved),
        // Display-only owner response: never included in evidence or provider input.
        fieldLabels: saved ? saved.fields.map((field, index) => ({ alias: `Field ${index + 1}`, name: typeof field.name === 'string' ? field.name.slice(0, 120) : `Field ${index + 1}` })) : []
      });
      const body = requestBody(req.body);
      if (!config.enabled) throw new HttpError(503, config.reason);
      if (!saved || !tokenMatches(body.previewToken, token(saved))) throw new HttpError(409, 'The AI preview changed or expired. Reload it and review the evidence before sending.');
      const modelSteps = route(body.task, body.mode), started = now(), deadline = started + 60000;
      function checkTime() {
        if (now() > deadline) throw new HttpError(504, 'The bounded AI workflow timed out. No automatic retry was made.');
        if (dayKey(now()) !== dayKey(started)) throw new HttpError(409, 'The AI budget day changed. Reload the preview before a new request.');
      }
      const guard = async () => { checkTime(); await assertCurrent(container, saved, now()); checkTime(); };
      // Both independent user and global controls must succeed before any paid call.
      saved = await reserveUser(container, saved, dayKey(started));
      const budget = await reserveGlobal(container, dayKey(started), reserveMicros(modelSteps.map(step => step.model)), config.dailyLimitUsd);
      await guard();
      const evidence = structuredClone(saved.evidence), toolsUsed = [], usage = { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
      const addUsage = part => { usage.inputTokens += part.inputTokens; usage.outputTokens += part.outputTokens; usage.estimatedUsd = Math.round((usage.estimatedUsd + part.estimatedUsd) * 1000000) / 1000000; };
      if (body.task === 'daily') {
        const planned = await invoke(plannerPayload(modelSteps[0], saved), config.key, deadline - now());
        addUsage(planned.usage); await guard();
        const calls = validateCalls(planned.data, saved);
        // Validate every call before executing any; at most four fixed read-only tools.
        // Parallel independent calls avoid four sequential weather timeouts.
        const results = await Promise.all(calls.map(async call => { await guard(); const records = await runTool(call, saved); await guard(); return { call, records }; }));
        for (const { call, records } of results) {
          const ids = [];
          for (const record of records) { const id = `E${evidence.records.length + 1}`; evidence.records.push({ id, ...record }); ids.push(id); }
          toolsUsed.push({ tool: call.name, field: call.field, status: records.some(record => record.status === 'available' || record.type === 'tasks') ? 'available' : 'unavailable', evidenceIds: ids });
        }
      }
      await guard();
      const writer = modelSteps[modelSteps.length - 1];
      const completed = await invoke(writerPayload(writer, body.task, evidence, toolsUsed), config.key, deadline - now());
      addUsage(completed.usage); await guard();
      if (usage.estimatedUsd > budget.requestReservedUsd) throw new HttpError(502, 'AI usage exceeded its verified reservation. Use the original brief.');
      const answer = answerFromResponse(completed.data, evidence);
      return respond(context, 200, { answer, model: writer.model, routeReason: writer.routeReason, modelSteps, toolsUsed, usage, budget, evidence });
    } catch (error) { handleError(context, error); }
  };
}
module.exports = createAiBriefHandler();
module.exports.createAiBriefHandler = createAiBriefHandler;
module.exports.requestBody = requestBody;
