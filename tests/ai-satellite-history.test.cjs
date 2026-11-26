'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSatelliteService, contextId } = require('../api/shared/satellite');
const { locationKey } = require('../api/shared/field-geometry');
const { satelliteRecords, createTools } = require('../api/shared/ai-tools');
const { memoryContainer, sampleRecords } = require('./helpers/ai-fixture.cjs');
const NOW = Date.parse('2026-10-24T22:00:00Z'), OWNER = 'history-only-owner';
function fixture({ sentinelConsent = true, landsatConsent = true } = {}) {
  const field = { ...sampleRecords(NOW, OWNER)[1].state.fields[0], satelliteConsent: sentinelConsent, landsatConsent };
  const history = [3,2,1].map((days, i) => ({ date: new Date(NOW - days * 86400000).toISOString(), status: 'clear', ndvi: 0.61 + i * 0.01, ndre: null, clearPercent: 94, sourceId: `PRIVATE SCENE ${i}`, sourceUrl: 'https://private.invalid/scene' }));
  const result = { fieldId: field.id, locationKey: locationKey(field), status: 'unavailable', fetchedAt: new Date(NOW - 60000).toISOString(), history: [], change: { status: 'insufficient' },
    landsat: { fieldId: field.id, locationKey: locationKey(field), source: { id: 'nasa-landsat' }, status: 'live', fetchedAt: new Date(NOW - 60000).toISOString(), validUntil: new Date(NOW + 86400000).toISOString(), history, change: { status: 'insufficient', confidence: 'low' } } };
  const cached = { id: contextId(OWNER, field.id), userId: OWNER, type: 'satelliteContext', version: 1, fieldId: field.id, locationKey: locationKey(field), fingerprint: createHash('sha256').update(JSON.stringify(field)).digest('hex'), result };
  const container = memoryContainer([{ id:`state-${OWNER}`, userId:OWNER, type:'state', state:{fields:[field]} }, cached]);
  let requests = 0;
  const service = createSatelliteService({ getContainer:()=>container, now:()=>NOW, fetchImpl:async()=>{ requests++; throw Error('History reader must never request imagery'); } });
  return { field, result, cached, container, service, requests:()=>requests };
}
test('dated NASA history is available without fabricating an insufficient change advisory',async()=>{
  const f=fixture();
  assert.equal(await f.service.readCachedSatellite({userId:OWNER,field:f.field}),null);
  const history=await f.service.readCachedSatelliteHistory({userId:OWNER,field:f.field});
  assert.deepEqual(history.landsat.history,f.result.landsat.history);assert.equal(history.landsat.status,'live');
  assert.equal(history.landsat.change.status,'insufficient');assert.equal(history.landsat.change.currentDate,undefined);
  assert.equal(history.landsat.fetchedAt,f.result.landsat.fetchedAt);assert.equal(f.requests(),0);
  const evidence=satelliteRecords(history,f.field,'Field 1',NOW),nasa=evidence.find(record=>record.provider==='nasa-usgs-landsat');
  assert.equal(nasa.status,'available');assert.equal(nasa.history.length,3);assert.equal(nasa.history[2].ndvi,0.63);
  assert.equal(nasa.comparisonStatus,'insufficient');assert.equal(nasa.changeComparisonSupported,false);
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));assert.ok(!JSON.stringify(evidence).includes('https:'));
  assert.equal(await f.service.readCachedSatellite({userId:OWNER,field:f.field}),null);
});
test('raw history never authorizes trend inference, even when its cache records a comparison outcome',()=>{
  const f=fixture();
  for(const status of ['detected','stable','insufficient','PRIVATE UNKNOWN']){
    const data=structuredClone(f.result);data.landsat.change.status=status;
    const nasa=satelliteRecords(data,f.field,'Field 1',NOW).find(record=>record.provider==='nasa-usgs-landsat');
    assert.equal(nasa.changeComparisonSupported,false);assert.equal(nasa.comparisonStatus,status==='PRIVATE UNKNOWN'?'unknown':status);
  }
  const {INSTRUCTIONS}=require('../api/shared/ai-provider');
  assert.match(INSTRUCTIONS,/changeComparisonSupported is false/);assert.match(INSTRUCTIONS,/never infer vegetation improvement, decline/);
});
test('history reader enforces owner partition, current field fingerprint and exact location',async()=>{
  for(const mutate of [doc=>{doc.fingerprint='wrong';},doc=>{doc.locationKey='wrong';},doc=>{doc.version=999;},doc=>{doc.fieldId='wrong';}]){
    const f=fixture(),doc=f.container.get(f.cached.id,OWNER);mutate(doc);f.container.put(doc);
    assert.equal(await f.service.readCachedSatelliteHistory({userId:OWNER,field:f.field}),null);assert.equal(f.requests(),0);
  }
  const f=fixture();assert.equal(await f.service.readCachedSatelliteHistory({userId:'other-owner',field:f.field}),null);
  const state=f.container.get(`state-${OWNER}`,OWNER);state.state.fields[0].crop='other';f.container.put(state);
  assert.equal(await f.service.readCachedSatelliteHistory({userId:OWNER,field:f.field}),null);
});
test('history reader never returns a provider whose separate permission is off',async()=>{
  const nasa=fixture({sentinelConsent:false});const nasaResult=await nasa.service.readCachedSatelliteHistory({userId:OWNER,field:nasa.field});
  assert.ok(nasaResult.landsat);assert.equal(nasaResult.history,undefined);assert.equal(nasaResult.source,undefined);
  const sentinel=fixture({landsatConsent:false});const sentinelResult=await sentinel.service.readCachedSatelliteHistory({userId:OWNER,field:sentinel.field});
  assert.equal(sentinelResult.landsat,undefined);assert.deepEqual(sentinelResult.history,[]);
  const neither=fixture({sentinelConsent:false,landsatConsent:false});assert.equal(await neither.service.readCachedSatelliteHistory({userId:OWNER,field:neither.field}),null);
});
test('historical cache is not refreshed or relabeled current when its freshness expires',async()=>{
  const f=fixture(),doc=f.container.get(f.cached.id,OWNER);doc.result.landsat.validUntil=new Date(NOW-1).toISOString();f.container.put(doc);
  const history=await f.service.readCachedSatelliteHistory({userId:OWNER,field:f.field});
  assert.equal(history.landsat.validUntil,doc.result.landsat.validUntil);assert.equal(history.landsat.status,'live');
  const evidence=satelliteRecords(history,f.field,'Field 1',NOW);assert.equal(evidence.find(record=>record.provider==='nasa-usgs-landsat').status,'unavailable');assert.equal(f.requests(),0);
});
test('AI satellite tool explicitly uses history reader, never change-advisory or imagery refresh methods',async()=>{
  const f=fixture();let reads=0;
  const run=createTools({getContainer:()=>f.container,now:()=>NOW,fetchImpl:async()=>assert.fail('No provider requests'),satelliteService:{
    async readCachedSatelliteHistory(args){reads++;assert.equal(args.userId,OWNER);return f.service.readCachedSatelliteHistory(args);},
    async readCachedSatellite(){assert.fail('Do not use change-advisory reader for history');},async getSatellite(){assert.fail('No imagery download');}
  }});
  const records=await run({name:'get_satellite_history',field:'Field 1'},{owner:OWNER,fields:[f.field]});
  assert.equal(reads,1);assert.equal(records.find(record=>record.provider==='nasa-usgs-landsat').history.length,3);
});
test('deletion during a history read yields no private result',async()=>{
  const f=fixture(),item=f.container.item;
  f.container.item=(id,owner)=>{const original=item(id,owner);return {...original,async read(){const result=await original.read();if(id===f.cached.id)f.container.remove(`state-${OWNER}`,OWNER);return result;}};};
  assert.equal(await f.service.readCachedSatelliteHistory({userId:OWNER,field:f.field}),null);assert.equal(f.requests(),0);
});
