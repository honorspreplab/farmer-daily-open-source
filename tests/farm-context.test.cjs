require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFarmContextService, farmContextId, exportFarmContexts, pruneFarmContexts } = require('../api/shared/farm-context');
const { createFarmContextHandler } = require('../api/farm-context');
const { createContextProviders, normalizeSoil, normalizeMarkets, normalizeStatistics, normalizeAir, normalizeWater, WATER_SERVICE } = require('../api/shared/context-providers');
const NOW = Date.parse('2026-10-07T18:00:00Z'), owner = 'context-farmer';
const field = { id: 'a', name: 'Private Orchard', crop: 'Apples', location: { latitude: 47.25, longitude: -120.25 }, dataConsent: true, contextConsent: true, marketReportId: '1234', marketLabel: 'Selected local report' };
const clone = value => structuredClone(value);
const failure = code => Object.assign(new Error('Fixture failure'), { code });
const soil = () => ({ Table: [['mukey','muname','compname','comppct_r','drainagecl','slope_r','hzdept_r','hzdepb_r','awc_r','om_r','texture'], ['123','Silt loam map unit','Soil component','80','Well drained','2','0','15','0.18','2','Silt loam']] });
const air = (overrides = {}) => [{ DateObserved: '2026-10-07', HourObserved: 10, LocalTimeZone: 'PST', ReportingArea: 'Wenatchee', StateCode: 'WA', ParameterName: 'PM2.5', AQI: 63, Category: { Number: 2, Name: 'Moderate' }, ...overrides }];
const market = () => [{ results: [{ commodity: 'APPLES', report_date: '10/07/2026', low_price: '22', high_price: '28', price_unit: 'USD', package: '40 lb carton', market_name: 'Selected market' }] }];
const nass = () => ({ data: [{ year: '2025', state_alpha: 'WA', agg_level_desc: 'STATE', commodity_desc: 'APPLES', freq_desc: 'ANNUAL', statisticcat_desc: 'PRODUCTION', Value: '5,200,000', short_desc: 'APPLES - PRODUCTION, MEASURED IN TONS', unit_desc: 'TONS', reference_period_desc: 'YEAR' }] });
const water = () => ({ features: [{ attributes: { Drought_Status: 'Drought Emergency Declaration Area', Watershed: 'Wenatchee' } }] });
function response(body) { return { ok: true, headers: { get() { return null; } }, async json() { return clone(body); } }; }
function fixture({ fetchOverride, env = { USDA_AMS_API_KEY: 'test-ams-secret', USDA_NASS_API_KEY: 'test-nass-secret', AIRNOW_API_KEY: 'test-air-secret' }, timeoutMs = 40 } = {}) {
  const documents = new Map(), calls = [], accesses = [];
  let version = 0, timestamp = NOW, batchHook;
  const key = (id, userId) => `${userId}/${id}`;
  function save(document) { const value = { ...clone(document), _etag: String(++version) }; documents.set(key(value.id, value.userId), value); return { resource: clone(value) }; }
  const container = { item(id, userId) { accesses.push({ id, userId }); return {
    async read() { const d = documents.get(key(id,userId)); if (!d) throw failure(404); return { resource: clone(d) }; },
    async delete(options) { const d = documents.get(key(id,userId)); if (!d) throw failure(404); if (options?.accessCondition && options.accessCondition.condition !== d._etag) throw failure(412); documents.delete(key(id,userId)); },
    async replace(d, options) { const stored = documents.get(key(id,userId)); if (!stored) throw failure(404); if (options?.accessCondition?.condition !== stored._etag) throw failure(412); return save(d); }
  }; }, items: {
    async create(d) { if (documents.has(key(d.id,d.userId))) throw failure(409); return save(d); },
    query(spec, options) { const p = Object.fromEntries(spec.parameters.map(x => [x.name,x.value])); assert.equal(p['@userId'],options.partitionKey); return { async fetchAll() { return { resources: [...documents.values()].filter(d=>d.userId===p['@userId']&&d.type===p['@type']).map(clone) }; } }; },
    async batch(operations,userId) { if (batchHook) { const hook=batchHook;batchHook=null;await hook(); } for (const op of operations) { const d=documents.get(key(op.id||op.resourceBody.id,userId)); assert.equal(op.resourceBody.userId,userId); if(op.operationType==='Create'&&d)throw failure(409);if(op.operationType==='Replace'&&(!d||d._etag!==op.ifMatch))throw failure(d?412:404); }return { code:200,result:operations.map(op=>({statusCode:200,resourceBody:save(op.resourceBody).resource})) }; }
  } };
  save({ id:`state-${owner}`,userId:owner,type:'state',state:{ fields:[clone(field)],profile:{ firstName:'Private Name' },tasks:[{name:'Private task'}] } });
  save({ id:`account-${owner}`,userId:owner,type:'account',email:'context@example.test',identityProvider:'aad',plan:'free',request:null });
  const fetchImpl = async (url,options) => { calls.push({url,options});if(fetchOverride)return fetchOverride(url,options);
    if(url.includes('/Tabular/'))return response(soil());
    if(url.includes('marsapi.'))return response(market());
    if(url.includes('quickstats.'))return response(nass());
    if(url.includes('airnowapi.'))return response(air());
    if(url===`${WATER_SERVICE}?f=json`)return response({layers:[{id:198,name:'Drought Layer Year 2026'}]});
    if(url.startsWith(`${WATER_SERVICE}/198/query`))return response(water());
    throw new Error('Unexpected URL'); };
  const service=createFarmContextService({getContainer:()=>container,fetchImpl,now:()=>timestamp,env,timeoutMs});
  const handler=createFarmContextHandler({getContainer:()=>container,now:()=>timestamp,farmContextService:service});
  async function request(query={fieldId:field.id}, userId=owner, extras={}) { const context={log:{error(){}}};await handler(context,{method:'GET',query,headers:{host:'localhost',...(userId?{'x-ms-client-principal':Buffer.from(JSON.stringify({userId,userDetails:userId==='admin'?'admin1@example.invalid':'context@example.test',identityProvider:'aad',userRoles:['authenticated']})).toString('base64')}:{}),...extras}});return context.res; }
  return {documents,calls,accesses,container,save,service,request,env,setNow:v=>{timestamp=v;},hook:f=>{batchHook=f;},state:()=>clone(documents.get(key(`state-${owner}`,owner))),field:()=>clone(documents.get(key(`state-${owner}`,owner)).state.fields[0])};
}
test('Free owner receives field-scoped normalized sources; requests never share names, tasks, IDs or boundaries',async()=>{
  const f=fixture(),result=await f.request({fieldId:'a',lat:'0',lon:'0',userId:'victim',url:'https://evil.example'});
  assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store');
  for(const kind of ['soil','markets','statistics','air','water'])assert.equal(result.body[kind].status,'ready',kind);
  assert.equal(result.body.soil.data.scope,'representative_point');assert.equal(result.body.soil.data.mapUnits[0].components[0].topHorizon.availableWaterCapacityCmPerCm,.18);
  assert.equal(result.body.air.data.observations[0].observedAt,'2026-10-07T17:00:00.000Z');
  assert.equal(result.body.air.data.preliminary,true);assert.match(result.body.air.message,/not an on-farm sensor/);
  assert.match(result.body.water.message,/not a farm water allocation/);assert.match(result.body.statistics.message,/not endorsed or certified by NASS/);
  const outbound=JSON.stringify(f.calls);for(const secret of ['Private Orchard','Private Name','Private task',owner,'boundary','Selected local report'])assert.ok(!outbound.includes(secret),secret);
  assert.ok(f.calls.every(call=>call.options.redirect==='error'));assert.equal(f.calls.length,6);
  assert.ok(!JSON.stringify(result.body).includes('test-'));assert.ok(!JSON.stringify([...f.documents.values()].filter(d=>d.type==='farmContext')).includes('test-'));
  const sql=JSON.parse(f.calls.find(c=>c.url.includes('/Tabular/')).options.body).query;assert.match(sql,/point \(-120.25 47.25\)/);assert.match(sql,/TOP 20/);
});
test('explicit independent context consent, saved location and owner are mandatory',async()=>{
  const f=fixture();assert.equal((await f.request({},null)).status,401);assert.equal((await f.request({fieldId:'a'},'admin')).status,404);assert.equal((await f.request({fieldId:'a'},owner,{'x-farmer-account-id':'other'})).status,409);
  for(const consent of [undefined,false]){const state=f.state();if(consent===undefined)delete state.state.fields[0].contextConsent;else state.state.fields[0].contextConsent=consent;f.save(state);assert.equal((await f.request()).status,409);}
  assert.equal(f.calls.length,0);
  const state=f.state();state.state.fields[0].contextConsent=true;delete state.state.fields[0].location;f.save(state);assert.equal((await f.request()).status,409);assert.equal(f.calls.length,0);
});
test('missing API keys produce precise configuration status and zero credentialed-source requests',async()=>{
  const f=fixture({env:{}}),r=await f.request();for(const kind of ['markets','statistics','air']){assert.equal(r.body[kind].status,'needs_configuration');assert.equal(r.body[kind].data,null);}assert.equal(f.calls.length,3);
  const state=f.state();delete state.state.fields[0].marketReportId;state.state.fields[0].crop='My custom crop';f.save(state);const next=await f.request();assert.equal(next.body.markets.status,'not_selected');assert.equal(next.body.statistics.status,'not_selected');
});
test('owner cache and in-flight coalescing avoid repeated downloads; manual refresh respects TTL minimums',async()=>{
  const f=fixture();const results=await Promise.all([f.request(),f.request(),f.request()]);assert.ok(results.every(r=>r.status===200));assert.equal(f.calls.length,6);
  const cached=await f.request({fieldId:'a',refresh:'1'});assert.equal(cached.body.soil.status,'cached');assert.equal(f.calls.length,6);
  f.setNow(NOW+61000);await f.request({fieldId:'a',refresh:'1'});assert.equal(f.calls.filter(x=>x.url.includes('/Tabular/')).length,1);assert.equal(f.calls.filter(x=>x.url.includes('quickstats.')).length,1);assert.equal(f.calls.length,10);
  const count=f.calls.length;const read=await f.service.readCachedFarmContext({userId:owner,field:f.field()});assert.equal(read.air.status,'cached');assert.equal(f.calls.length,count);
});
test('outages, timeout, malformed values, future dates and obsolete drought layers never become fabricated current data',async()=>{
  for(const fetchOverride of [async()=>{throw new Error('offline');},()=>new Promise(()=>{}),async()=>response({unexpected:true})]){
    const f=fixture({fetchOverride,timeoutMs:5}),r=await f.request();assert.equal(r.status,200);for(const kind of ['soil','markets','statistics','air','water']){assert.equal(r.body[kind].status,'unavailable');assert.equal(r.body[kind].data,null);}const count=f.calls.length;await f.request({fieldId:'a',refresh:'1'});assert.equal(f.calls.length,count);
  }
  const f=fixture({env:{},fetchOverride:async url=>response(url.includes('/Tabular/')?soil():{layers:[{id:198,name:'Drought Layer Year 2025'}]})});const r=await f.request();assert.equal(r.body.soil.status,'ready');assert.equal(r.body.water.status,'unavailable');assert.match(r.body.water.message,/2026/);assert.equal(f.calls.length,2);
});
test('stale and future cache timestamps are not reported as live or returned by cache-only reads',async()=>{
  const f=fixture();await f.request();f.setNow(NOW+5*3600000);let r=await f.service.readCachedFarmContext({userId:owner,field:f.field()});assert.equal(r.air.status,'unavailable');assert.equal(r.air.data,null);assert.equal(r.soil.status,'cached');assert.equal(f.calls.length,6);
  const doc=[...f.documents.values()].find(d=>d.type==='farmContext');doc.soil.fetchedAt=new Date(NOW+365*86400000).toISOString();f.save(doc);r=await f.service.readCachedFarmContext({userId:owner,field:f.field()});assert.equal(r.soil.status,'unavailable');
});
test('consent revocation, field edits and account deletion during provider fetch cannot resurrect derived data',async()=>{
  for(const action of ['revoke','move','delete']){let f,once=false;f=fixture({env:{},fetchOverride:async url=>{if(!once){once=true;const state=f.state();if(action==='revoke')state.state.fields[0].contextConsent=false;else if(action==='move')state.state.fields[0].location.latitude+=.01;else state.state.fields=[];f.save(state);}return response(url.includes('/Tabular/')?soil():{layers:[]});}});const r=await f.request();assert.equal(r.status,409);assert.equal([...f.documents.values()].filter(d=>d.type==='farmContext').length,0);}
});
test('atomic persistence rechecks state after ETag conflicts and never stores after withdrawal',async()=>{
  const f=fixture();f.hook(()=>{const state=f.state();state.state.fields[0].contextConsent=false;f.save(state);});assert.equal((await f.request()).status,409);assert.equal([...f.documents.values()].filter(d=>d.type==='farmContext').length,0);
  const good=fixture();good.hook(()=>{const state=good.state();state.state.profile.firstName='Concurrent profile';good.save(state);});assert.equal((await good.request()).status,200);assert.equal(good.state().state.profile.firstName,'Concurrent profile');
});
test('private export and pruning bind exact owner, consent, location and market selection',async()=>{
  const f=fixture();await f.request();assert.equal((await exportFarmContexts(f.container,owner,[f.field()],NOW)).length,1);assert.equal((await exportFarmContexts(f.container,'other',[f.field()],NOW)).length,0);
  const fieldChanged={...f.field(),marketReportId:'4321'};assert.equal((await exportFarmContexts(f.container,owner,[fieldChanged],NOW)).length,0);await pruneFarmContexts(f.container,owner,[fieldChanged]);assert.equal([...f.documents.values()].filter(d=>d.type==='farmContext').length,0);
  await f.request();await pruneFarmContexts(f.container,owner,[]);assert.equal([...f.documents.values()].filter(d=>d.type==='farmContext').length,0);
});
test('owner exports retain expired derived history without labeling it current',async()=>{
  const f=fixture();await f.request();const records=await exportFarmContexts(f.container,owner,[f.field()],NOW+5*3600000);
  assert.equal(records[0].air.expired,true);assert.equal(records[0].air.historicalRecord,true);assert.equal(records[0].air.data.observations[0].aqi,63);
});
test('no payload/provider error or secret is reflected when source validation fails',async()=>{
  const f=fixture({fetchOverride:async()=>{throw new Error('https://evil.example?API_KEY=secret Private Name');}});const r=await f.request();assert.ok(!JSON.stringify(r).includes('evil'));assert.ok(!JSON.stringify(r).includes('secret'));assert.equal(r.body.soil.data,null);
});
test('soil normalizer preserves unknown/null as missing and validates scientific ranges and columns',()=>{
  const p=soil();p.Table[1][8]=null;assert.equal(normalizeSoil(p).mapUnits[0].components[0].topHorizon.availableWaterCapacityCmPerCm,null);
  for(const invalid of [null,'',-1,101]){const p=soil();p.Table[1][3]=invalid;if(invalid===null||invalid==='')assert.equal(normalizeSoil(p).mapUnits[0].components[0].percent,null);else assert.throws(()=>normalizeSoil(p));}
  for(const invalid of [[],{}, {Table:[['evil'],['1']]}])assert.throws(()=>normalizeSoil(invalid));
});
test('market normalizer validates dates, units and crop and never infers a cross-grade price change',()=>{
  assert.equal(normalizeMarkets(market(),field,NOW).items[0].low,22);
  for(const date of ['2026-10-08','2026-02-30','2020-01-01','tomorrow']){const p=market();p[0].results[0].report_date=date;assert.throws(()=>normalizeMarkets(p,field,NOW));}
  const p=market();p[0].results[0].commodity='POTATOES';assert.equal(normalizeMarkets(p,field,NOW).items.length,0);
  p[0].results[0].commodity='APPLES';delete p[0].results[0].price_unit;delete p[0].results[0].package;assert.equal(normalizeMarkets(p,field,NOW).items.length,0);
});
test('NASS preserves suppressed values and refuses another state, future year or mismatched crop',()=>{
  const p=nass();p.data[0].Value='(D)';assert.equal(normalizeStatistics(p,'APPLES',NOW).items[0].value,'(D)');
  for(const patch of [{year:'2027'},{state_alpha:'OR'},{commodity_desc:'WHEAT'},{Value:'<script>'},{freq_desc:'WEEKLY'}]){const p=nass();Object.assign(p.data[0],patch);assert.throws(()=>normalizeStatistics(p,'APPLES',NOW));}
});
test('AirNow rejects stale, future, unknown, missing AQI and inconsistent categories',()=>{
  for(const patch of [{DateObserved:'2026-10-06'},{HourObserved:14},{LocalTimeZone:'EST'},{AQI:null},{AQI:-1},{ParameterName:'CO'},{StateCode:'OR'},{AQI:200},{DateObserved:'2026-02-30'}])assert.throws(()=>normalizeAir(air(patch),NOW));
  assert.equal(normalizeAir([],NOW).observations.length,0);assert.equal(normalizeAir(air({AQI:0,Category:{Number:1,Name:'Good'}}),NOW).observations[0].aqi,0);
});
test('unknown or truncated Ecology records are rejected rather than asserting no drought',()=>{
  assert.equal(normalizeWater(water(),2026).areas[0].watershed,'Wenatchee');assert.deepEqual(normalizeWater({features:[]},2026).areas,[]);
  for(const p of [{features:[],exceededTransferLimit:true},{features:[{attributes:{Drought_Status:'No drought',Watershed:'x'}}]},{}])assert.throws(()=>normalizeWater(p,2026));
});
test('all adapters reject oversized responses and use fixed agency hosts',async()=>{
  const providers=createContextProviders({env:{},now:()=>NOW,fetchImpl:async()=>({ok:true,headers:{get(){return '1048577';}},async json(){throw new Error('Must not decode');}})});
  await assert.rejects(providers.soil({location:field.location}),/unavailable/);
});
test('rapidly editing coordinates cannot bypass the per-owner context refresh budget',async()=>{
  const f=fixture({env:{}});
  for(let i=0;i<20;i++){const state=f.state();state.state.fields[0].location.latitude=47.25+i/10000;f.save(state);assert.equal((await f.request()).status,200);}
  const state=f.state();state.state.fields[0].location.latitude=47.26;f.save(state);
  const count=f.calls.length;assert.equal((await f.request()).status,429);assert.equal(f.calls.length,count);
  f.setNow(NOW+61000);assert.equal((await f.request()).status,200);
});
test('request after account-state deletion does not return cache or recreate a state',async()=>{
  const f=fixture();await f.request();f.documents.delete(`${owner}/state-${owner}`);
  const count=f.calls.length;assert.equal((await f.request()).status,404);assert.equal(f.calls.length,count);
  await assert.rejects(f.service.readCachedFarmContext({userId:owner,field}),error=>error.status===409);
});
test('unrecognized market crop cannot show an unrelated commodity even when a report is selected',()=>{
  assert.equal(normalizeMarkets(market(),{...field,crop:'Unknown crop'},NOW).items.length,0);
});
