'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiBriefHandler } = require('../api/ai-brief');
const { MODELS, route, writerPayload, answerFromResponse } = require('../api/shared/ai-provider');
const { reserveGlobal, reserveMicros, PARTITION, dayKey } = require('../api/shared/ai-budget');
const { makeEvidence } = require('../api/shared/ai-evidence');
const { satelliteRecords, contextRecords, validateCalls } = require('../api/shared/ai-tools');
const { memoryContainer, sampleRecords, request, providerResponse, plannerResponse, enabledEnv } = require('./helpers/ai-fixture.cjs');
const NOW = Date.parse('2026-10-24T15:00:00Z');
function setup(options = {}) {
  const container = options.container || memoryContainer(sampleRecords(NOW)), requests = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => { const payload = JSON.parse(init.body); requests.push({ url, init, payload }); return Response.json(payload.tools ? plannerResponse(payload.model) : providerResponse(payload.model)); });
  const handler = createAiBriefHandler({ getContainer: () => container, now: () => NOW, env: enabledEnv(), fetchImpl, ...options });
  const call = async req => { const context = {}; await handler(context, req); return context.res; };
  const preview = () => call(request());
  const send = async (overrides = {}, previewToken) => { const token = previewToken || (await preview()).body.previewToken; return call(request('POST', 'sample-owner', { task: 'summary', mode: 'auto', consent: true, consentVersion: 'ai-evidence-v1', previewToken: token, ...overrides })); };
  return { container, requests, call, preview, send };
}
test('preview is available while AI is disabled, minimized and never calls a provider', async () => {
  const s = setup({ env: {} }), preview = await s.preview();
  assert.equal(preview.status, 200); assert.equal(preview.body.enabled, false); assert.equal(preview.body.available, true); assert.equal(s.requests.length, 0);
  assert.equal(preview.body.models.analysis, 'gpt-6.1-sol');
  const serialized = JSON.stringify({ evidence: preview.body.evidence, toolPreview: preview.body.toolPreview });
  for (const marker of ['PRIVATE','SECRET','private-field','sample-owner','latitude','longitude','sourceUrl','https:','synthetic@example']) assert.ok(!serialized.includes(marker), marker);
  assert.equal(preview.body.toolPreview.mayRefreshWeather, true);
  assert.ok(preview.body.evidence.records.some(record => record.type === 'alert-coverage' && record.currentAllClearEstablished === false));
  assert.ok(preview.body.evidence.records.some(record => record.type === 'tasks' && record.kinds.inspection === 1));
});
test('missing auth, required owner header, account mismatch and same-origin checks fail before provider', async () => {
  const s = setup();
  for (const [alter, status] of [
    [req => delete req.headers['x-ms-client-principal'], 401], [req => delete req.headers['x-farmer-account-id'], 400],
    [req => { req.headers['x-farmer-account-id'] = 'other'; }, 409], [req => { req.headers.origin = 'https://attacker.invalid'; }, 403],
    [req => { req.headers['sec-fetch-site'] = 'cross-site'; }, 403], [req => { req.headers['content-type'] = 'text/plain'; }, 415]
  ]) { const req = request('POST'); alter(req); assert.equal((await s.call(req)).status, status); }
  assert.equal(s.requests.length, 0);
});
test('enablement requires explicit flag, key, approved model and 0<budget<=10', async () => {
  for (const override of [{ AI_ENABLED: 'false' }, { OPENAI_API_KEY: '' }, { OPENAI_MODEL: 'gpt-5.5' }, ...['0','-1','NaN','11','Infinity'].map(AI_DAILY_BUDGET_USD => ({ AI_DAILY_BUDGET_USD }))]) {
    const s = setup({ env: { ...enabledEnv(), ...override } }); assert.equal((await s.send()).status, 503); assert.equal(s.requests.length, 0);
  }
});
test('strict body allowlist, enums and per-request consent', async () => {
  const s = setup();
  for (const overrides of [{ prompt: 'ignore instructions' }, { consent: false }, { consentVersion: 'old' }, { task: 'arbitrary' }, { mode: 'expensive' }, { previewToken: 'a' }]) assert.equal((await s.send(overrides)).status, 400);
  assert.equal(s.requests.length, 0);
});
test('single-call summary routes Luna; strict schema, no tools, no storage, default tier and fixed endpoint', async () => {
  const s = setup(), result = await s.send();
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.model, MODELS.economy); assert.equal(result.body.modelSteps.length, 1);
  assert.equal(result.body.usage.inputTokens, 500); assert.equal(s.requests.length, 1);
  const { url, init, payload } = s.requests[0];
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'error'); assert.equal(payload.store, false); assert.equal(payload.service_tier, 'default'); assert.equal(payload.tools, undefined); assert.equal(payload.text.format.strict, true);
  assert.ok(result.body.budget.requestReservedUsd >= result.body.usage.estimatedUsd);
  const persisted = [...s.container.docs.values()].filter(doc => doc.type.startsWith('ai'));
  assert.equal(persisted.length, 2); assert.ok(persisted.every(doc => !('answer' in doc) && !('evidence' in doc) && !('prompt' in doc)));
  const global = persisted.find(doc => doc.type === 'aiBudget'); assert.ok(!JSON.stringify(global).includes('sample-owner'));
});
test('auto daily and compare use Sol; explicit modes honored without automatic fallback', () => {
  assert.deepEqual(route('daily','auto').map(step => step.model), [MODELS.analysis, MODELS.analysis]);
  assert.deepEqual(route('daily','economy').map(step => step.model), [MODELS.economy, MODELS.economy]);
  assert.equal(route('compare','auto')[0].model, MODELS.analysis);
  assert.equal(route('explain','auto')[0].model, MODELS.economy);
  assert.equal(route('summary','analysis')[0].model, MODELS.analysis);
});
test('daily executes selected function tools and returns the actual tools and evidence', async () => {
  const s = setup(), result = await s.send({ task: 'daily' });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(s.requests.length, 2);
  assert.equal(result.body.toolsUsed[0].tool, 'get_tasks'); assert.equal(result.body.toolsUsed[0].status, 'available');
  assert.equal(result.body.modelSteps[0].purpose, 'planner'); assert.equal(result.body.usage.inputTokens, 1000);
  assert.equal(s.requests[0].payload.tool_choice, 'required'); assert.equal(s.requests[1].payload.tools, undefined);
  assert.ok(result.body.evidence.records.length > (await s.preview()).body.evidence.records.length);
});
test('stale/deleted/revoked state, account or brief invalidate a preview before provider', async () => {
  for (const target of ['state','account','brief','delete','revoke']) {
    const s = setup(), preview = (await s.preview()).body;
    const id = target === 'brief' ? sampleRecords(NOW)[2].id : target === 'account' ? 'account-sample-owner' : 'state-sample-owner';
    const doc = s.container.get(id, 'sample-owner');
    if (target === 'delete') s.container.remove(id, 'sample-owner');
    else { if (target === 'revoke') doc.state.fields[0].dataConsent = false; if (target === 'account') doc.plan = 'premium'; s.container.put(doc); }
    assert.equal((await s.send({}, preview.previewToken)).status, 409, target); assert.equal(s.requests.length, 0);
  }
});
test('account polling heartbeat does not invalidate preview or an in-flight answer', async () => {
  const container = memoryContainer(sampleRecords(NOW));
  function heartbeat() { const account = container.get('account-sample-owner','sample-owner'); account.lastSeenAt = new Date(NOW).toISOString(); container.put(account); }
  const s = setup({ container, fetchImpl: async (url, init) => { heartbeat(); return Response.json(providerResponse(JSON.parse(init.body).model)); } });
  const preview = (await s.preview()).body; heartbeat();
  assert.equal((await s.send({},preview.previewToken)).status,200);
});
test('account/state/brief changes during provider work discard answer, preserve reservation, never restore records', async () => {
  for (const target of ['state','account','brief']) {
    const container = memoryContainer(sampleRecords(NOW)); let count = 0;
    const s = setup({ container, fetchImpl: async (url, init) => {
      count++; const id = target === 'brief' ? sampleRecords(NOW)[2].id : `${target}-sample-owner`;
      container.remove(id, 'sample-owner'); return Response.json(providerResponse(JSON.parse(init.body).model));
    } });
    const result = await s.send(); assert.equal(result.status, 409, target); assert.equal(count, 1); assert.equal([...container.docs.values()].filter(doc => doc.type === 'aiBudget').length, 1);
    assert.equal(container.get(target === 'brief' ? sampleRecords(NOW)[2].id : `${target}-sample-owner`, 'sample-owner'), undefined);
  }
});
test('a preview from another owner is rejected', async () => {
  const container = memoryContainer([...sampleRecords(NOW), ...sampleRecords(NOW, 'owner-two')]); const s = setup({ container });
  const preview = (await s.preview()).body;
  const result = await s.call(request('POST','owner-two',{ task:'summary', mode:'auto', consent:true, consentVersion:'ai-evidence-v1', previewToken:preview.previewToken }));
  assert.equal(result.status, 409); assert.equal(s.requests.length, 0);
});
test('per-owner daily cap is durable across handler instances and UTC reset is distinct', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await s.send()).status, 200);
  const second = setup({ container: s.container }); assert.equal((await second.send()).status, 429); assert.equal(second.requests.length, 0);
  const usage = s.container.get(`ai-usage-sample-owner-${dayKey(NOW)}`, 'sample-owner'); assert.equal(usage.requests, 10);
  assert.notEqual(dayKey(NOW), dayKey(NOW + 86400000));
});
test('global reservations remain bounded under concurrent handlers/owners', async () => {
  const container = memoryContainer(), amount = reserveMicros([MODELS.analysis, MODELS.analysis]);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveGlobal(container, dayKey(NOW), amount, 1)));
  const accepted = results.filter(result => result.status === 'fulfilled').length;
  const stored = container.get(`ai-budget-${dayKey(NOW)}`, PARTITION);
  assert.equal(accepted, Math.floor(1000000 / amount)); assert.ok(stored.reservedMicros <= 1000000); assert.equal(stored.requests, accepted);
});
test('global exhausted or malformed budget fails closed before provider', async () => {
  for (const amount of [10000000, -1, '0', NaN]) {
    const s = setup(); s.container.put({ id: `ai-budget-${dayKey(NOW)}`, userId: PARTITION, type: 'aiBudget', day: dayKey(NOW), reservedMicros: amount, requests: 1 });
    const result = await s.send(); assert.ok([429,503].includes(result.status)); assert.equal(s.requests.length, 0);
  }
});
test('malformed owner quota fails closed; reservation transaction prevents deletion race', async () => {
  const s = setup(); s.container.put({ id:`ai-usage-sample-owner-${dayKey(NOW)}`, userId:'sample-owner', type:'aiUsage', day:dayKey(NOW), requests:-1 });
  assert.equal((await s.send()).status,503); assert.equal(s.requests.length,0);
  const s2 = setup(), original = s2.container.items.batch;
  s2.container.items.batch = async (...args) => { s2.container.remove('state-sample-owner','sample-owner'); return original(...args); };
  assert.equal((await s2.send()).status,409); assert.equal(s2.requests.length,0);
});
test('Cosmos batch post-quota ETag works from operation eTag or returned resource _etag; missing both fails closed',async()=>{
  for(const shape of ['operation-etag','resource-etag','missing']){
    const s=setup(),original=s.container.items.batch;
    s.container.items.batch=async(...args)=>{const result=await original(...args);if(shape==='operation-etag')delete result.result[0].resourceBody;else if(shape==='resource-etag')delete result.result[0].eTag;else{delete result.result[0].eTag;delete result.result[0].resourceBody;}return result;};
    const result=await s.send();assert.equal(result.status,shape==='missing'?503:200,shape);assert.equal(s.requests.length,shape==='missing'?0:1);
  }
});
test('provider faults never retry, leak provider text, refund or silently route to a different model', async () => {
  for (const fault of ['http','network','incomplete','refusal','no-usage','huge-usage','wrong-model','extra-output','malformed-json','oversized','unknown-citation','extra-property']) {
    let count = 0;
    const s = setup({ fetchImpl: async (url, init) => {
      count++;
      if (fault === 'http') return new Response('PRIVATE PROVIDER ERROR', {status:429});
      if (fault === 'network') throw new Error('PRIVATE PROVIDER ERROR');
      if (fault === 'malformed-json') return new Response('not-json');
      if (fault === 'oversized') return new Response('x'.repeat(66000));
      const data = providerResponse(JSON.parse(init.body).model);
      if (fault === 'incomplete') data.status = 'incomplete';
      if (fault === 'refusal') data.output[0].content = [{type:'refusal',refusal:'PRIVATE PROVIDER ERROR'}];
      if (fault === 'no-usage') delete data.usage;
      if (fault === 'huge-usage') data.usage.output_tokens = 1501;
      if (fault === 'wrong-model') data.model = 'unknown';
      if (fault === 'extra-output') data.output.push({type:'web_search_call'});
      if (fault === 'unknown-citation') data.output[0].content[0].text = JSON.stringify({summary:'Summary',points:[{text:'Point',evidenceIds:['E999']} ]});
      if (fault === 'extra-property') data.output[0].content[0].text = JSON.stringify({summary:'Summary',points:[{text:'Point',evidenceIds:['E1']} ],extra:true});
      return Response.json(data);
    } });
    const result = await s.send(); assert.equal(result.status,502,fault); assert.equal(count,1,fault); assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok([...s.container.docs.values()].find(doc => doc.type === 'aiBudget').reservedMicros > 0);
  }
});
test('provider timeout is bounded with no retry and preserves reservation', async () => {
  let calls=0;
  const s=setup({timeoutMs:5,fetchImpl:async()=>{calls++;return new Promise(()=>{});}});
  assert.equal((await s.send()).status,504); assert.equal(calls,1); assert.ok([...s.container.docs.values()].some(doc=>doc.type==='aiBudget'));
});
test('all planner calls are validated before any tool execution', async () => {
  for (const calls of [[{name:'fetch_url',arguments:'{}'}], [{name:'get_weather',arguments:'{"fieldRef":"Field 99"}'}], [{name:'get_weather',arguments:'{"fieldRef":"Field 1","url":"https://attacker.invalid"}'}], [{name:'get_tasks',arguments:'{}'},{name:'get_tasks',arguments:'{}'}], Array.from({length:5},(_,i)=>({name:'get_weather',arguments:JSON.stringify({fieldRef:`Field ${i+1}`})}))]) {
    let providerCalls=0,toolCalls=0;
    const s=setup({fetchImpl:async(url,init)=>{providerCalls++;return Response.json(plannerResponse(JSON.parse(init.body).model,calls));},weatherHandler:async()=>{toolCalls++;}});
    assert.equal((await s.send({task:'daily'})).status,502); assert.equal(providerCalls,1); assert.equal(toolCalls,0);
  }
});
test('revoked weather permission excludes the tool and rejects a fabricated call', async () => {
  const container=memoryContainer(sampleRecords(NOW)), state=container.get('state-sample-owner','sample-owner'); state.state.fields.forEach(field=>{field.dataConsent=false;}); container.put(state);
  const s=setup({container,fetchImpl:async(url,init)=>Response.json(plannerResponse(JSON.parse(init.body).model,[{name:'get_weather',arguments:'{"fieldRef":"Field 1"}'}]))});
  assert.ok(!(await s.preview()).body.toolPreview.tools.some(tool=>tool.name==='get_weather'));
  assert.equal((await s.send({task:'daily'})).status,502);
});
test('new weather is normalized, source identified and no upstream location reaches the LLM', async () => {
  const payloads=[], weatherQueries=[];
  const s=setup({fetchImpl:async(url,init)=>{const payload=JSON.parse(init.body);payloads.push(payload);return Response.json(payload.tools?plannerResponse(payload.model,[{name:'get_weather',arguments:'{"fieldRef":"Field 1"}'}]):providerResponse(payload.model));},
    weatherHandler:async(context,req)=>{weatherQueries.push(req.query);context.res={status:200,body:{source:{id:'nws',name:'SECRET STATION'},fetchedAt:new Date(NOW).toISOString(),hourly:[{startTime:new Date(NOW).toISOString(),endTime:new Date(NOW+3600000).toISOString(),temperature:45,temperatureUnit:'F',windSpeed:'8 mph',probabilityOfPrecipitation:{value:20},relativeHumidity:{value:70},shortForecast:'PRIVATE'}]}};}});
  const result=await s.send({task:'daily'}); assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(weatherQueries.length,1);
  const record=result.body.evidence.records.find(item=>item.source==='weather-tool');assert.equal(record.provider,'nws');assert.equal(record.next24Hours.lowF,45);
  for(const marker of ['SECRET STATION','PRIVATE','47.71','-122.2','latitude','longitude'])assert.ok(!JSON.stringify(payloads).includes(marker),marker);
});
test('freshness failures yield unavailable evidence, never zero-valued fabricated weather',()=>{
  const records=sampleRecords(NOW), brief=records[2].brief; brief.fieldSummaries[0].fetchedAt=new Date(NOW-7*3600000).toISOString();
  const evidence=makeEvidence(records[1].state,brief,NOW).evidence;
  const weather=evidence.records.find(record=>record.type==='weather');assert.equal(weather.status,'unavailable');assert.equal(weather.next24Hours,null);assert.deepEqual(weather.samples,[]);
});
test('display labels stay outside the evidence and outbound provider requests',async()=>{
  const s=setup(),preview=await s.preview();assert.equal(preview.body.fieldLabels[0].name,'PRIVATE FIELD NAME 1');
  const response=await s.send();assert.equal(response.status,200);
  for(const call of s.requests)assert.ok(!JSON.stringify(call.payload).includes('PRIVATE FIELD NAME'));
});
test('satellite tool strips scene IDs, URLs and geometry and independently respects NASA/Sentinel permissions',()=>{
  const part={status:'cached',fetchedAt:new Date(NOW-60000).toISOString(),validUntil:new Date(NOW+3600000).toISOString(),history:[{date:new Date(NOW-86400000).toISOString(),status:'clear',ndvi:0.6,ndre:0.2,clearPercent:90,sourceId:'SECRET SCENE',sourceUrl:'https://private.invalid'}],problemAreas:[{coordinates:[1,2]}]};
  const result=satelliteRecords({...part,landsat:part},{satelliteConsent:false,landsatConsent:true},'Field 1',NOW);
  assert.equal(result.length,1);assert.equal(result[0].provider,'nasa-usgs-landsat');assert.equal(result[0].history[0].ndvi,0.6);
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('https:'));assert.ok(!JSON.stringify(result).includes('coordinates'));
  const stale=satelliteRecords({...part,fetchedAt:new Date(NOW-3*86400000).toISOString()},{satelliteConsent:true},'Field 1',NOW);
  assert.equal(stale[0].status,'unavailable');assert.deepEqual(stale[0].history,[]);
});
test('cached context emits only safe numeric/category data, not report labels, bare prices or notes',()=>{
  const part={status:'cached',fetchedAt:new Date(NOW-60000).toISOString(),validUntil:new Date(NOW+3600000).toISOString()};
  const records=contextRecords({
    soil:{...part,source:{id:'nrcs-ssurgo'},data:{mapUnits:[{name:'SECRET MAP',components:[{name:'SECRET SOIL',percent:60,slopePercent:4,topHorizon:{availableWaterCapacityCmPerCm:0.15,organicMatterPercent:2,texture:'SECRET TEXTURE'}}]}]}},
    markets:{...part,source:{id:'usda-ams'},data:{reportLabel:'SECRET LABEL',items:[{low:100,high:200,unit:'SECRET UNIT'}]}},
    water:{...part,source:{id:'wa-ecology'},data:{year:2026,areas:[{watershed:'SECRET LOCATION',status:'Drought Advisory Area'}]}}
  },'Field 1',NOW);
  const text=JSON.stringify(records);assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('"low"'));assert.equal(records.find(item=>item.type==='soil').mappedComponents[0].availableWaterCapacityCmPerCm,0.15);
  assert.equal(records.find(item=>item.type==='markets').recordCount,1);assert.equal(records.find(item=>item.type==='air').status,'unavailable');
});
test('deleting owner data during a tool prevents writer call and does not restore state',async()=>{
  const container=memoryContainer(sampleRecords(NOW));let providers=0;
  const s=setup({container,fetchImpl:async(url,init)=>{providers++;return Response.json(plannerResponse(JSON.parse(init.body).model,[{name:'get_weather',arguments:'{"fieldRef":"Field 1"}'}]));},weatherHandler:async(context)=>{container.remove('state-sample-owner','sample-owner');context.res={status:503};}});
  assert.equal((await s.send({task:'daily'})).status,409);assert.equal(providers,1);assert.equal(container.get('state-sample-owner','sample-owner'),undefined);
});
test('request size bound prevents a paid call for oversized packets',async()=>{
  const { createProvider }=require('../api/shared/ai-provider');let calls=0;
  const invoke=createProvider({fetchImpl:async()=>{calls++;throw Error('not expected');}});
  await assert.rejects(invoke({model:MODELS.analysis,input:'x'.repeat(20001)},'synthetic-test-key'),error=>error.status===413);assert.equal(calls,0);
  for (const remaining of [0,-1,NaN,Infinity]) await assert.rejects(invoke({model:MODELS.analysis,input:'small'},'synthetic-test-key',remaining),error=>error.status===504);
  assert.equal(calls,0);
});
test('coverage discloses omitted fields and prioritizes saved weather alerts',()=>{
  const records=sampleRecords(NOW),state=records[1].state,brief=records[2].brief;
  state.fields.push(...Array.from({length:8},(_,i)=>({...state.fields[0],id:`more-${i}`})));
  brief.advisories[0].fieldId='more-7';brief.advisories[0].kind='alert-0';
  const result=makeEvidence(state,brief,NOW);assert.equal(result.fields.length,5);assert.equal(result.fields[0].id,'more-7');
  const coverage=result.evidence.records.find(record=>record.type==='coverage');assert.equal(coverage.omittedFields,5);assert.equal(coverage.allFieldsReviewed,false);
  assert.ok(result.evidence.records.some(record=>record.category==='weather-alert'));
});
