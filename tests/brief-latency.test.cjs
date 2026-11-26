'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBriefHandler } = require('../api/brief');
const { HttpError } = require('../api/shared/access');
const NOW = Date.parse('2026-11-01T22:00:00Z');
const iso = value => new Date(value).toISOString();
const clone = value => structuredClone(value);
const field = { id:'field-a', name:'Sample orchard', crop:'Apples', dataConsent:true, contextConsent:true,
  satelliteConsent:true, boundary:{type:'Polygon',coordinates:[[[-120.36,47.35],[-120.359,47.35],[-120.359,47.351],[-120.36,47.35]]]},
  location:{latitude:47.35,longitude:-120.36} };
function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; }
function weather(selected, timestamp=NOW) {
  return { fieldId:selected.id, locationKey:'sample-location', weatherStatus:'live', alerts:{status:'live',items:[],fetchedAt:iso(timestamp)},
    elevation:{status:'unavailable',feet:null,meters:null}, weather:{source:{id:'nws',name:'NWS',url:'https://forecast.weather.gov/MapClick.php?lat=47.35&lon=-120.36'},
      fetchedAt:iso(timestamp), hourly:[{startTime:iso(timestamp-60000),endTime:iso(timestamp+3540000),temperature:55,temperatureUnit:'F',windSpeed:'3 mph',probabilityOfPrecipitation:{value:10},relativeHumidity:{value:50}}]} };
}
function fixture({getFieldData, readCachedFarmContext, readCachedSatellite, fields=[field], sourceTimeoutMs=25}={}) {
  const docs=new Map(), calls={weather:[],context:[],satellite:[]}; let version=0, timestamp=NOW, onBatch;
  const key=(id,owner)=>`${owner}/${id}`, fail=code=>Object.assign(new Error('fixture'),{code});
  const save=doc=>{const stored={...clone(doc),_etag:`v${++version}`};docs.set(key(doc.id,doc.userId),stored);return clone(stored);};
  const container={item(id,owner){return {
    async read(){const doc=docs.get(key(id,owner));if(!doc)throw fail(404);return {resource:clone(doc)};},
    async replace(doc,options){const old=docs.get(key(id,owner));if(!old||old._etag!==options.accessCondition.condition)throw fail(412);return {resource:save(doc)};},
    async delete(){if(!docs.delete(key(id,owner)))throw fail(404);}
  };},items:{
    async create(doc){if(docs.has(key(doc.id,doc.userId)))throw fail(409);return {resource:save(doc)};},
    async batch(operations,owner){
      if(onBatch)await onBatch();
      for(const op of operations){const old=docs.get(key(op.id||op.resourceBody.id,owner));assert.equal(op.resourceBody.userId,owner);
        if(op.operationType==='Create'&&old)throw fail(409);
        if(op.operationType==='Replace'&&(!old||old._etag!==op.ifMatch))throw fail(412);}
      return {code:200,result:operations.map(op=>({statusCode:200,resourceBody:save(op.resourceBody)}))};
    }
  }};
  save({id:'state-owner',userId:'owner',type:'state',state:{profile:{firstName:'Sam',farmName:'Sample farm'},fields:clone(fields),tasks:[{id:'task-1',name:'Check irrigation',date:'2026-11-01',done:false}]}});
  const handler=createBriefHandler({getContainer:()=>container,now:()=>timestamp,sourceTimeoutMs,fetchImpl:async()=>assert.fail('No real network request'),
    fieldDataService:{async getFieldData(args){assert.equal(args.cacheOnlyElevation,true);calls.weather.push(args);return getFieldData?getFieldData(args):weather(args.field,timestamp);}},
    farmContextService:{async readCachedFarmContext(args){calls.context.push(args);return readCachedFarmContext?readCachedFarmContext(args):null;},async getFarmContext(){assert.fail('Never refresh optional source providers in brief');}},
    satelliteService:{async readCachedSatellite(args){calls.satellite.push(args);return readCachedSatellite?readCachedSatellite(args):null;},async getSatellite(){assert.fail('Never process imagery in brief');}}
  });
  return {docs,calls,container,save,setTime(value){timestamp=value;},beforeBatch(callback){onBatch=callback;},async request(body={},userId='owner'){
    const context={log:{error(){},warn(){}}}; await handler(context,{method:'POST',body,headers:{'content-type':'application/json','x-ms-client-principal':Buffer.from(JSON.stringify({userId,userDetails:`${userId}@example.test`,identityProvider:'aad',userRoles:['authenticated']})).toString('base64')}});return context.res;
  }};
}

test('one shared source budget bounds all stalled sources, coalesces clicks, and preserves truthful tasks',async()=>{
  const never=()=>new Promise(()=>{}), f=fixture({getFieldData:never,readCachedFarmContext:never,readCachedSatellite:never});
  const started=performance.now(), results=await Promise.all(Array.from({length:5},()=>f.request()));
  assert.ok(performance.now()-started<1000,'Source timeout should return without waiting minutes');
  assert.ok(results.every(result=>result.status===200));
  assert.equal(f.calls.weather.length,1);assert.equal(f.calls.context.length,1);assert.equal(f.calls.satellite.length,1);
  assert.equal(f.calls.weather[0].signal.aborted,true);
  const brief=results[0].body.brief;
  assert.deepEqual(brief.coverage.timedOutSources,['farm-context','satellite-cache','weather']);
  assert.equal(brief.coverage.partial,true);assert.equal(brief.coverage.weatherAvailableFields,0);
  assert.ok(brief.advisories.some(item=>item.kind==='task-task-1'));
  assert.ok(brief.advisories.some(item=>item.kind==='unavailable'));
  assert.match(brief.coverage.notices.join(' '),/Some sources took too long/);
  assert.ok(!JSON.stringify(brief).includes('55°F'));
  assert.equal([...f.docs.values()].filter(doc=>doc.type==='dailyBrief').length,1);
});

test('healthy fields are retained when another field misses the same budget, and late results do not overwrite snapshot',async()=>{
  const late=deferred(), fields=[{...field,id:'healthy'},{...field,id:'slow'}];
  const f=fixture({fields,getFieldData:async args=>args.field.id==='healthy'?weather(args.field):late.promise});
  const result=await f.request();assert.equal(result.status,200);
  assert.equal(result.body.brief.coverage.weatherAvailableFields,1);
  assert.equal(result.body.brief.fieldSummaries.find(item=>item.fieldId==='healthy').weatherStatus,'live');
  assert.equal(result.body.brief.fieldSummaries.find(item=>item.fieldId==='slow').weatherStatus,'unavailable');
  const saved=clone(f.docs.get('owner/brief-owner-2026-11-01'));
  late.resolve(weather(fields[1]));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.docs.get('owner/brief-owner-2026-11-01'),saved);
  assert.equal((await f.request()).body.reused,true);assert.equal(f.calls.weather.length,2);
});

test('deleting farm data during a source timeout still prevents private brief persistence',async()=>{
  const started=deferred(), f=fixture({getFieldData:async()=>{started.resolve();return new Promise(()=>{});}});
  const pending=f.request();await started.promise;await f.container.item('state-owner','owner').delete();
  assert.equal((await pending).status,409);
  assert.equal([...f.docs.values()].filter(doc=>doc.type==='dailyBrief').length,0);
});

test('field consent and ownership errors are not mistaken for a source timeout',async()=>{
  const f=fixture({getFieldData:async()=>{throw new HttpError(409,'Field consent changed');}});
  assert.equal((await f.request()).status,409);
  assert.equal([...f.docs.values()].filter(doc=>doc.type==='dailyBrief').length,0);
});

test('source deadlines never abandon the final atomic private save',async()=>{
  const entered=deferred(), release=deferred(), f=fixture();let completed=false;
  f.beforeBatch(async()=>{entered.resolve();await release.promise;});
  const pending=f.request().then(result=>{completed=true;return result;});await entered.promise;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(completed,false);assert.equal([...f.docs.values()].filter(doc=>doc.type==='dailyBrief').length,0);
  release.resolve();assert.equal((await pending).status,200);
  assert.equal([...f.docs.values()].filter(doc=>doc.type==='dailyBrief').length,1);
});

test('midnight reselection shares the original budget and does not claim a missing field forecast',async()=>{
  const fields=Array.from({length:6},(_,index)=>({...field,id:`field-${index}`,contextConsent:false,satelliteConsent:false}));
  let f;
  f=fixture({fields,getFieldData:async args=>{f.setTime(Date.parse('2026-11-02T08:00:01Z'));return args.field.id==='field-0'?new Promise(()=>{}):weather(args.field,Date.parse('2026-11-02T08:00:01Z'));}});
  f.setTime(Date.parse('2026-11-02T07:59:59Z'));
  const saved=(await f.container.item('state-owner','owner').read()).resource;
  saved.state.tasks=[{id:'new-day-task',name:'Scout',date:'2026-11-02',fieldId:'field-5',done:false}];f.save(saved);
  const result=await f.request();assert.equal(result.status,200);assert.equal(result.body.date,'2026-11-02');
  assert.ok(result.body.brief.coverage.reviewedFieldIds.includes('field-5'));
  assert.equal(result.body.brief.fieldSummaries.find(item=>item.fieldId==='field-5').weatherStatus,'unavailable');
  assert.equal(f.calls.weather.length,5,'Expired budget must not start another weather lookup after midnight');
});
