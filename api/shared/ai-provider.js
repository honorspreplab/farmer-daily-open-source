'use strict';
const { HttpError } = require('./access');
const { MAX_REQUEST_BYTES, MAX_OUTPUT_TOKENS, INPUT_TOKEN_BOUND, costMicros } = require('./ai-budget');
const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE_BYTES = 65536;
const MODELS = Object.freeze({ economy: 'gpt-6-luna', analysis: 'gpt-6.1-sol' });
function configuration(env) {
  const limit = Number(env.AI_DAILY_BUDGET_USD), key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  let reason = '';
  if (env.AI_ENABLED !== 'true') reason = 'Optional AI is not enabled on this server. Your rule-based brief still works.';
  else if (!key || key.length > 512 || /\s/.test(key)) reason = 'The server AI credentials are not configured.';
  else if (env.OPENAI_MODEL !== MODELS.analysis) reason = 'The approved analysis model is not configured.';
  else if (!Number.isFinite(limit) || limit <= 0 || limit > 10) reason = 'A daily AI budget greater than zero and no more than $10 is required.';
  return { enabled: !reason, reason, key, models: MODELS, dailyLimitUsd: Number.isFinite(limit) && limit > 0 && limit <= 10 ? limit : 0 };
}
function route(task, mode) {
  const writer = mode === 'analysis' || (mode === 'auto' && ['daily','compare'].includes(task)) ? MODELS.analysis : MODELS.economy;
  const writerReason = mode === 'auto' ? (task === 'daily' ? 'A personalized daily message uses Sol to combine selected agricultural tools.' : task === 'compare' ? 'Cross-field comparison uses Sol.' : 'A concise explanation uses lower-cost Luna.') : `You selected ${mode} mode.`;
  return [ ...(task === 'daily' ? [{ purpose: 'planner', model: mode === 'economy' ? MODELS.economy : MODELS.analysis, routeReason: mode === 'economy' ? 'Economy mode also uses the smaller model to select read-only tools.' : 'The analysis model selects relevant read-only agricultural tools.' }] : []), { purpose: 'writer', model: writer, routeReason: writerReason } ];
}
function answerSchema(evidence) {
  return { type: 'object', properties: {
    summary: { type: 'string', minLength: 1, maxLength: 450 },
    points: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: {
      text: { type: 'string', minLength: 1, maxLength: 600 }, evidenceIds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: evidence.records.map(record => record.id) } }
    }, required: ['text','evidenceIds'], additionalProperties: false } }
  }, required: ['summary','points'], additionalProperties: false };
}
const INSTRUCTIONS = [
  'You explain Farmer Daily evidence, not make diagnoses or operate a farm. Use only the supplied structured evidence; never invent measurements, causes, prices, sensors, services or actions.',
  'Write briefly in the evidence language (en or es). Use only the Field N aliases. Do not infer location, personal identity, crop variety or missing data. Missing evidence is not an all-clear.',
  'Keep official weather-alert priorities prominent. A weather refresh is a forecast, not a field measurement; it does not refresh stored alerts. If newer weather differs from a saved priority, clearly distinguish their timestamps and advise checking the original brief, not silently overriding it.',
  'If coverage omits fields or the original brief was partial, disclose this; never claim the whole farm was reviewed. A stored alert feed is not refreshed by the AI and cannot establish a current all-clear.',
  'Dated satellite reflectance/NDVI can suggest scouting, never establish disease, water stress or yield. Soil is mapped context, not current moisture; AQI is preliminary regional awareness, not worker-safety compliance; drought is regional, not a farm water allocation.',
  'When changeComparisonSupported is false, satellite history is dated context only: never infer vegetation improvement, decline, a trend, anomaly, disease or water stress by subtracting or comparing history numbers. The image grids and clear-pixel populations may be incompatible. Refer to an original validated satellite-scout priority if one is present; do not create a new change advisory from these history values, even if comparisonStatus says detected or stable.',
  'No pesticide, dosage, treatment, irrigation-volume, legal-compliance or purchase recommendation. Suggest reviewing/scouting/checking local conditions and consulting a qualified professional for important decisions.',
  'Return a short summary of your cited points and 1-3 useful points. Each point must cite existing evidence IDs supporting every factual claim. Acknowledge expired/unavailable data and uncertainties. Do not output HTML, links or new facts. Do not claim that a message was sent or a task completed.'
].join('\n');
function writerPayload(step, task, evidence, toolsUsed) {
  const tasks = { daily: 'Construct a personalized daily message from the tool results and saved priorities, considering crop category, growth stage and due task counts.', summary: 'Summarize the saved evidence into a short daily message.', explain: 'Explain why the recorded priority categories may matter, using only available weather and due-task evidence.', compare: 'Compare the available fields using recorded evidence. If fewer than two fields or adequate comparable data are available, state that limitation.' };
  return { model: step.model, store: false, service_tier: 'default', reasoning: { effort: 'low' }, max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: INSTRUCTIONS, input: JSON.stringify({ task: tasks[task], evidence, toolsUsed }),
    text: { format: { type: 'json_schema', name: 'farmer_daily_answer', strict: true, schema: answerSchema(evidence) } } };
}
function exactKeys(value, keys) { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); }
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\u0000-\u001f\u007f]|https?:|www\./i.test(value); }
function validateAnswer(value, evidence) {
  const allowed = new Set(evidence.records.map(record => record.id));
  if (!exactKeys(value, ['summary','points']) || !validText(value.summary, 450) || !Array.isArray(value.points) || value.points.length < 1 || value.points.length > 3 || value.points.some(point =>
    !exactKeys(point, ['text','evidenceIds']) || !validText(point.text, 600) || !Array.isArray(point.evidenceIds) || point.evidenceIds.length < 1 || point.evidenceIds.length > 5 || new Set(point.evidenceIds).size !== point.evidenceIds.length || point.evidenceIds.some(id => !allowed.has(id)))) throw new HttpError(502, 'The AI answer did not pass evidence validation. Use the original rule-based brief.');
  return value;
}
async function boundedJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES || !response.body?.getReader) throw new Error('Invalid AI response size');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('AI response too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function createProvider({ fetchImpl = globalThis.fetch, timeoutMs = 22000 } = {}) {
  return async function invoke(payload, key, remainingMs = timeoutMs) {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new HttpError(504, 'The AI workflow deadline passed before a provider request could start.');
    const body = JSON.stringify(payload);
    if (!Object.values(MODELS).includes(payload.model) || Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new HttpError(413, 'This evidence packet is too large for a bounded AI request.');
    const controller = new AbortController(); let timer;
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
          if (!response.ok) { await response.body?.cancel?.(); throw new Error('AI provider unavailable'); }
          return boundedJson(response);
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HttpError(504, 'The AI request timed out. No automatic retry was made.')); }, Math.max(1, Math.min(timeoutMs, remainingMs))); })
      ]);
      const input = data.usage?.input_tokens, output = data.usage?.output_tokens;
      if (data.status !== 'completed' || data.error || data.incomplete_details || !Array.isArray(data.output) || !Number.isSafeInteger(input) || input <= 0 || input > INPUT_TOKEN_BOUND || !Number.isSafeInteger(output) || output <= 0 || output > MAX_OUTPUT_TOKENS ||
          typeof data.model !== 'string' || !(data.model === payload.model || new RegExp(`^${payload.model.replace(/\./g, '\\.')}-(?:20\\d{2})-\\d{2}-\\d{2}$`).test(data.model))) throw new HttpError(502, 'The AI response was incomplete or its usage could not be verified. Use the original brief.');
      return { data, usage: { inputTokens: input, outputTokens: output, estimatedUsd: costMicros(payload.model, input, output) / 1000000 } };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'The AI service could not complete a verified answer. No automatic retry was made.');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
function answerFromResponse(data, evidence) {
  const messages = [];
  for (const output of data.output) {
    if (output.type === 'reasoning') continue;
    if (output.type !== 'message' || output.role !== 'assistant' || output.status !== 'completed' || !Array.isArray(output.content)) throw new HttpError(502, 'Unexpected AI output. Use the original brief.');
    for (const part of output.content) {
      if (part.type !== 'output_text' || typeof part.text !== 'string') throw new HttpError(502, 'The AI could not provide a verified answer.');
      messages.push(part.text);
    }
  }
  if (messages.length !== 1) throw new HttpError(502, 'Unexpected AI output. Use the original brief.');
  let answer; try { answer = JSON.parse(messages[0]); } catch { throw new HttpError(502, 'The AI answer was not valid structured data.'); }
  return validateAnswer(answer, evidence);
}
module.exports = { MODELS, configuration, route, INSTRUCTIONS, writerPayload, exactKeys, createProvider, answerFromResponse, validateAnswer, MAX_RESPONSE_BYTES };
