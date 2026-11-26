const test = require('node:test');
const assert = require('node:assert/strict');
const {createBriefHandler} = require('../api/brief');
const {createProtectedWeatherHandler} = require('../api/weather');
const {contextId} = require('../api/shared/field-data');
const {locationKey} = require('../api/shared/field-geometry');
const clone = value => value === undefined ? undefined : structuredClone(value);
const field = {id:'field-1',name:'West orchard',crop:'Apple',location:{latitude:47.67,longitude:-122.2},dataConsent:true};
const start = Date.parse('2026-10-03T16:30:00Z');
const iso = value => new Date(value).toISOString();
function memory() {
  const docs=new Map();let version=0;
  const key=(id,userId)=>`${userId}/${id}`;
  function failure(code){return Object.assign(new Error('storage'),{code});}
  function save(doc){const stored={...clone(doc),_etag:`v${++version}`};docs.set(key(doc.id,doc.userId),stored);return clone(stored);}
  return {docs,save,
    item(id,userId){return {
      async read(){const resource=docs.get(key(id,userId));if(!resource)throw failure(404);return {resource:clone(resource)};},
      async replace(doc,options){const old=docs.get(key(id,userId));if(!old)throw failure(404);if(old._etag!==options.accessCondition.condition)throw failure(412);return {resource:save(doc)};},
      async delete(){if(!docs.delete(key(id,userId)))throw failure(404);}
    };},
    items:{
      async create(doc){if(docs.has(key(doc.id,doc.userId)))throw failure(409);return {resource:save(doc)};},
      async batch(operations,userId){
        for(const [index,operation] of operations.entries()){
          assert.equal(operation.resourceBody.userId,userId);
          const existing=docs.get(key(operation.id||operation.resourceBody.id,userId));
          const code=operation.operationType==='Create'?(existing?409:0):(!existing?404:existing._etag!==operation.ifMatch?412:0);
          if(code)return {code,result:operations.map((unused,i)=>({statusCode:i===index?code:424}))};
        }
        return {code:200,result:operations.map(operation=>({statusCode:200,resourceBody:save(operation.resourceBody)}))};
      }
    }
  };
}
function request(method='POST',userId='farmer',body={}) {
  return {method,body,headers:{'content-type':'application/json','x-ms-client-principal':Buffer.from(JSON.stringify({userId,userDetails:`${userId}@example.test`,identityProvider:'aad',userRoles:['authenticated']})).toString('base64')}};
}
async function call(handler,req=request()) {const context={log:{error(){},warn(){}}};await handler(context,req);assert.equal(context.res.headers['Cache-Control'],'no-store');return context.res;}
function fieldResult(item,now=start) {
  return {fieldId:item.id,locationKey:`${item.location.latitude},${item.location.longitude}`,weatherStatus:'live',elevation:{status:'loaded',feet:400,meters:121.9},
    weather:{source:{id:'nws',name:'NWS',url:'https://forecast.weather.gov/MapClick.php?lat=47.67&lon=-122.2'},fetchedAt:iso(now),hourly:[{startTime:iso(now-60000),endTime:iso(now+3540000),temperature:50,temperatureUnit:'F',windSpeed:'4 mph',probabilityOfPrecipitation:{value:20},relativeHumidity:{value:80}}]},
    alerts:{status:'live',items:[],fetchedAt:iso(now)}};
}
function fixture({fields=[field],getFieldData}={}) {
  const container=memory();let timestamp=start,calls=0;
  container.save({id:'state-farmer',userId:'farmer',type:'state',state:{profile:{firstName:'Sam',farmName:'Sunrise',address:'PRIVATE ADDRESS',language:'English'},fields,tasks:[]}});
  const handler=createBriefHandler({getContainer:()=>container,now:()=>timestamp,fieldDataService:{async getFieldData(args){calls++;assert.equal(args.userId,'farmer');return getFieldData ? getFieldData(args,container,timestamp) : fieldResult(args.field,timestamp);}}});
  return {container,handler,setTime(value){timestamp=value;},calls:()=>calls};
}

test('Free Phase 1 weather access is authenticated but no longer premium-only',async()=>{
  const container=memory();let calls=0;
  const handler=createProtectedWeatherHandler({getContainer:()=>container,now:()=>start,weatherHandler:async context=>{calls++;context.res={status:200,body:{source:'nws'}};}});
  assert.equal((await call(handler,request('GET'))).status,200);assert.equal(calls,1);
  assert.equal((await call(handler,{method:'GET',headers:{}})).status,401);assert.equal(calls,1);
});

test('internal scheduler brief entry requires an existing real account and uses the same private field pipeline',async()=>{
  const f=fixture();
  await assert.rejects(f.handler.forOwner('farmer'),/Account is unavailable/);
  await call(f.handler,request('GET'));
  const brief=await f.handler.forOwner('farmer');
  assert.equal(brief.coverage.reviewedFields,1);assert.equal(f.calls(),1);
  assert.equal((await call(f.handler,request('GET'))).body.brief.createdAt,brief.createdAt);
  await assert.rejects(f.handler.forOwner('other'),/Account is unavailable/);
  await assert.rejects(f.handler.forOwner('../farmer'),/Invalid brief owner/);
});

test('Free creates one owner/day field brief, coalesces concurrency, and refreshes after minimum interval',async()=>{
  const f=fixture();assert.equal((await call(f.handler,request('GET'))).body.brief,null);assert.equal(f.calls(),0);
  const results=await Promise.all(Array.from({length:6},()=>call(f.handler,request('POST','farmer',{userId:'someone-else',lat:0,lon:0,date:'2099-01-01'}))));
  assert.ok(results.every(result=>result.status===200));assert.equal(f.calls(),1);
  assert.ok(results.every(result=>JSON.stringify(result.body.brief)===JSON.stringify(results[0].body.brief)));
  assert.equal(results[0].body.date,'2026-10-03');assert.equal(results[0].body.brief.coverage.reviewedFields,1);
  assert.ok(!JSON.stringify(results[0].body.brief).includes('PRIVATE ADDRESS'));
  const rapid=await call(f.handler,request('POST','farmer',{refresh:true}));assert.equal(rapid.body.reused,true);assert.equal(f.calls(),1);
  f.setTime(start+61000);const refreshed=await call(f.handler,request('POST','farmer',{refresh:true}));assert.equal(refreshed.status,200);assert.equal(refreshed.body.reused,false);assert.equal(f.calls(),2);
  assert.notEqual(refreshed.body.brief.createdAt,results[0].body.brief.createdAt);
  assert.equal([...f.container.docs.values()].filter(doc=>doc.type==='dailyBrief').length,1);
});

test('each owner sees only their own saved snapshot and stale browser owner headers cannot cross accounts',async()=>{
  const f=fixture();await call(f.handler);
  const other=await call(f.handler,request('GET','other'));assert.equal(other.body.brief,null);
  const wrong=request('GET');wrong.headers['x-farmer-account-id']='other';assert.equal((await call(f.handler,wrong)).status,409);
  assert.equal((await call(f.handler,{method:'POST',headers:{'content-type':'application/json'},body:{}})).status,401);
});

test('missing location or data permission creates actionable setup brief without any external query',async()=>{
  const f=fixture({fields:[{...field,dataConsent:false}]});
  const result=await call(f.handler);assert.equal(result.status,200);assert.equal(result.body.brief.advisories[0].kind,'setup');assert.equal(f.calls(),0);
});

test('field forecast outage returns visible unavailable advisory and may be refreshed without consuming a quota',async()=>{
  let outage=true;
  const f=fixture({getFieldData:async({field},container,now)=>outage?{fieldId:field.id,weather:null,weatherStatus:'unavailable',alerts:{status:'unavailable'},elevation:{status:'unavailable'}}:fieldResult(field,now)});
  assert.equal((await call(f.handler)).body.brief.advisories[0].kind,'unavailable');
  outage=false;f.setTime(start+61000);
  assert.equal((await call(f.handler,request('POST','farmer',{refresh:true}))).body.brief.advisories[0].kind,'conditions');
});

test('tool cache ETag-only changes are accepted but concurrent task/profile edits reject stale generation',async()=>{
  const unchanged=fixture({getFieldData:async({field},container,now)=>{const saved=(await container.item('state-farmer','farmer').read()).resource;container.save(saved);return fieldResult(field,now);}});
  assert.equal((await call(unchanged.handler)).status,200);
  const changed=fixture({getFieldData:async({field},container,now)=>{const saved=(await container.item('state-farmer','farmer').read()).resource;saved.state.tasks=[{id:'new',name:'New task',done:false,date:'2026-10-03'}];container.save(saved);return fieldResult(field,now);}});
  assert.equal((await call(changed.handler)).status,409);
  assert.equal([...changed.container.docs.values()].filter(doc=>doc.type==='dailyBrief').length,0);
});

test('farm deletion during slow field queries cannot recreate private daily content',async()=>{
  let started,release;const began=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);
  const f=fixture({getFieldData:async({field})=>{started();await wait;return fieldResult(field);}});
  const pending=call(f.handler);await began;await f.container.item('state-farmer','farmer').delete();release();
  assert.equal((await pending).status,409);assert.equal([...f.container.docs.values()].filter(doc=>doc.type==='dailyBrief').length,0);
});

test('deleted brief stays deleted without farm setup but a newly saved profile can create it again without a quota override',async()=>{
  const f=fixture();await call(f.handler);
  const tombstone={id:'brief-farmer-2026-10-03',userId:'farmer',type:'dailyBrief',date:'2026-10-03',deleted:true,brief:null};
  f.container.save(tombstone);await f.container.item('state-farmer','farmer').delete();
  const loaded=await call(f.handler,request('GET'));assert.equal(loaded.body.deleted,true);assert.equal(loaded.body.brief,null);
  assert.equal((await call(f.handler)).status,409);
  assert.equal(f.container.docs.get('farmer/brief-farmer-2026-10-03').deleted,true);
  f.container.save({id:'state-farmer',userId:'farmer',type:'state',state:{profile:{firstName:'Sam',farmName:'New setup'},fields:[],tasks:[]}});
  const rebuilt=await call(f.handler);assert.equal(rebuilt.status,200);assert.equal(rebuilt.body.deleted,false);assert.equal(rebuilt.body.reused,false);
  assert.match(rebuilt.body.brief.summary,/New setup/);assert.equal(rebuilt.body.brief.advisories[0].kind,'setup');
  assert.ok(!JSON.stringify(rebuilt.body.brief).includes('West orchard'));
});

test('five-field retrieval bound prioritizes chosen block and task-related fields',async()=>{
  const fields=Array.from({length:8},(_,index)=>({...field,id:`field-${index}`,name:`Block ${index}`})),visited=[];
  const f=fixture({fields,getFieldData:async({field})=>{visited.push(field.id);return fieldResult(field);}});
  const saved=(await f.container.item('state-farmer','farmer').read()).resource;saved.state.profile.priorityField='Block 7';saved.state.tasks=[{id:'task',fieldId:'field-6',date:'2026-10-03',done:false,name:'Inspection'}];f.container.save(saved);
  const result=await call(f.handler);assert.equal(result.status,200);assert.equal(visited.length,5);assert.deepEqual(visited.slice(0,2),['field-7','field-6']);
  assert.equal(result.body.brief.coverage.partial,true);assert.match(result.body.brief.coverage.notices.join(' '),/Partial coverage/);
});

test('daily identity uses Pacific midnight independently of the client date and DST',async()=>{
  const f=fixture({fields:[]});f.setTime(Date.parse('2026-11-01T06:59:00Z'));
  assert.equal((await call(f.handler)).body.date,'2026-10-31');
  f.setTime(Date.parse('2026-11-01T07:01:00Z'));assert.equal((await call(f.handler)).body.date,'2026-11-01');
  f.setTime(Date.parse('2026-11-01T09:30:00Z'));assert.equal((await call(f.handler)).body.date,'2026-11-01');
});

test('brief reads cached elevations without enrichment writes and still atomically saves five-field weather',async()=>{
  const f=fixture({fields:Array.from({length:5},(_,index)=>({...field,id:`field-${index}`,location:{latitude:47.67+index/100,longitude:-122.2}}))});
  const saved = (await f.container.item('state-farmer','farmer').read()).resource;
  for (const item of saved.state.fields.slice(0,3)) f.container.save({id:contextId('farmer',item.id),userId:'farmer',type:'fieldContext',fieldId:item.id,locationKey:locationKey(item),elevation:{status:'loaded',feet:400,meters:121.92,fetchedAt:iso(start)}});
  const outbound=[];
  const handler=createBriefHandler({getContainer:()=>f.container,now:()=>start,
    weatherHandler:async(context,req)=>{assert.ok(req.query.lat.startsWith('47.'));context.res={status:200,body:fieldResult(field).weather};},
    fetchImpl:async(url,options)=>{outbound.push(url);assert.equal(options.redirect,'error');return {ok:true,json:async()=>url.startsWith('https://epqs.')?{value:400}:{type:'FeatureCollection',updated:iso(start),features:[]}};}
  });
  const response=await call(handler);assert.equal(response.status,200);assert.equal(response.body.brief.coverage.reviewedFields,5);
  assert.equal([...f.container.docs.values()].filter(doc=>doc.type==='fieldContext').length,3);
  assert.equal([...f.container.docs.values()].filter(doc=>doc.type==='dailyBrief').length,1);
  assert.equal(outbound.length,5);
  assert.ok(outbound.every(url=>url.startsWith('https://api.weather.gov/alerts')));
  assert.ok(outbound.every(url=>!url.includes('West')&&!url.includes('PRIVATE')&&!url.includes('farmer')));
  assert.ok(response.body.brief.fieldSummaries.slice(0,3).every(item=>item.elevation.feet===400 && item.alertsStatus==='live'));
  assert.ok(response.body.brief.fieldSummaries.slice(3).every(item=>item.elevation.status==='unavailable' && item.elevation.feet===null && item.alertsStatus==='live'));
});

test('midnight during tool work reselects fields for newly due tasks before claiming coverage',async()=>{
  let crossed=false;
  const fields=Array.from({length:6},(_,index)=>({...field,id:`field-${index}`}));
  const f=fixture({fields,getFieldData:async({field})=>{
    if(!crossed){crossed=true;f.setTime(Date.parse('2026-10-04T07:01:00Z'));}
    return fieldResult(field,Date.parse('2026-10-04T07:01:00Z'));
  }});
  f.setTime(Date.parse('2026-10-04T06:59:00Z'));
  const saved=(await f.container.item('state-farmer','farmer').read()).resource;
  saved.state.tasks=[{id:'tomorrow-task',fieldId:'field-5',name:'First inspection',date:'2026-10-04',done:false}];f.container.save(saved);
  const response=await call(f.handler);assert.equal(response.status,200);assert.equal(response.body.date,'2026-10-04');
  assert.ok(response.body.brief.coverage.reviewedFieldIds.includes('field-5'));
  assert.ok(response.body.brief.fieldSummaries.some(item=>item.fieldId==='field-5'&&item.weatherStatus==='live'));
});
