require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createStateHandler } = require('../api/state');
const { normalizeGeometry, locationKey } = require('../api/shared/field-geometry');
const { farmContextId, contextKey } = require('../api/shared/farm-context');
const { contextId: satelliteContextId } = require('../api/shared/satellite');
const { contextId: weatherContextId } = require('../api/shared/field-data');
const { outcome } = require('../api/shared/context-providers');

const NOW = Date.parse('2026-10-07T18:00:00Z');
const clone = value => structuredClone(value);
const farmer = { userId: 'phase23-farmer', userDetails: 'farmer@example.test', identityProvider: 'aad', userRoles: ['authenticated'] };
const other = { ...farmer, userId: 'phase23-other', userDetails: 'other@example.test' };
const admin = { ...farmer, userId: 'phase23-admin', userDetails: 'admin1@example.invalid' };
const originalField = { id: 'same-field-id', name: 'Private orchard', crop: 'Apples', dataConsent: true, contextConsent: true, satelliteConsent: true, landsatConsent: true, marketReportId: '1234', marketLabel: 'Preferred wholesale report', boundary: { type: 'Polygon', coordinates: [[[-120.36,47.35],[-120.359,47.35],[-120.359,47.351],[-120.36,47.351],[-120.36,47.35]]] } };
const field = { ...originalField, ...normalizeGeometry(originalField) };

function fixture() {
  const documents = new Map(), accesses = []; let revision = 0;
  const key = (id, userId) => `${userId}/${id}`;
  const error = code => Object.assign(new Error('Fixture storage error'), { code });
  const save = document => { const stored = { ...clone(document), _etag: `state-fixture-${++revision}` }; documents.set(key(stored.id,stored.userId),stored); return { resource:clone(stored) }; };
  const container = {
    item(id,userId) { accesses.push({id,userId}); return {
      async read() { const value = documents.get(key(id,userId)); if (!value) throw error(404); return {resource:clone(value)}; },
      async replace(document,options) { const value = documents.get(key(id,userId)); if (!value) throw error(404); assert.equal(document.userId,userId); assert.equal(document.id,id); assert.equal(options?.accessCondition?.type,'IfMatch'); if (options.accessCondition.condition!==value._etag) throw error(412); return save(document); },
      async delete(options) { const value=documents.get(key(id,userId));if(!value)throw error(404);if(options?.accessCondition&&value._etag!==options.accessCondition.condition)throw error(412);documents.delete(key(id,userId)); }
    }; },
    items: {
      async create(document) { if(documents.has(key(document.id,document.userId)))throw error(409);return save(document); },
      query(spec,options) {
        const params=Object.fromEntries(spec.parameters.map(p=>[p.name,p.value])),directory=params['@type']==='messagingRecipient';
        if(directory){assert.equal(options.partitionKey,'messaging-directory');assert.equal(typeof params['@bindingOwner'],'string');assert.match(spec.query,/c\.owner = @bindingOwner/);}
        else assert.equal(params['@userId']||params['@owner'],options.partitionKey);
        accesses.push({query:spec.query,type:params['@type'],userId:options.partitionKey,bindingOwner:params['@bindingOwner']});
        return {async fetchAll(){return {resources:[...documents.values()].filter(d=>d.userId===options.partitionKey&&d.type===params['@type']&&(!directory||d.owner===params['@bindingOwner'])).map(clone)};}};
      }
    }
  };
  for(const identity of [farmer,other,admin])save({id:`account-${identity.userId}`,userId:identity.userId,type:'account',email:identity.userDetails,identityProvider:'aad',plan:identity===farmer?'free':'premium',request:identity===farmer?null:{status:'approved'},requestHistory:[]});
  const handler=createStateHandler({getContainer:()=>container,now:()=>NOW});
  const stateFor = identity => clone(documents.get(key(`state-${identity.userId}`,identity.userId))?.state);
  async function call(method,body,identity=farmer,query={},headers={}) {
    const context={log:{error(){},warn(){}}};
    await handler(context,{method,body:clone(body),query,headers:{host:'localhost',origin:'http://localhost','content-type':'application/json',...(identity?{'x-ms-client-principal':Buffer.from(JSON.stringify(identity)).toString('base64')}:{}),...headers}});
    assert.equal(context.res.headers['Cache-Control'],'no-store');return context.res;
  }
  function derived(identity=farmer,selected=stateFor(identity).fields[0]) {
    const userId=identity.userId,keyValue=locationKey(selected);
    const farm={id:farmContextId(userId,selected.id),userId,type:'farmContext',schemaVersion:1,fieldId:selected.id,locationKey:keyValue,contextKey:contextKey(selected),fetchedAt:new Date(NOW).toISOString(),
      soil:outcome('soil','ready',NOW,'Fixture soil',{scope:'representative_point',mapUnits:[{id:'123',name:`Soil owned by ${userId}`,components:[]}]}),markets:outcome('markets','needs_configuration',NOW,'Fixture missing key'),statistics:outcome('statistics','needs_configuration',NOW,'Fixture missing key'),air:outcome('air','needs_configuration',NOW,'Fixture missing key'),water:outcome('water','unavailable',NOW,'Fixture unavailable')};
    const satellite={id:satelliteContextId(userId,selected.id),userId,type:'satelliteContext',version:1,fieldId:selected.id,locationKey:keyValue,fingerprint:createHash('sha256').update(JSON.stringify(selected)).digest('hex'),result:{fieldId:selected.id,locationKey:keyValue,fetchedAt:new Date(NOW).toISOString(),status:'live',history:[{date:'2026-10-05T19:00:00Z',ndvi:.67,sourceId:`fixture-owned-by-${userId}`}],problemAreas:[],cropHistory:[],landsat:{status:'live',resolutionMeters:30,source:{name:'NASA/USGS Landsat 8/9'},history:[{date:'2026-10-04T19:00:00Z',ndvi:.61,ndre:null,sourceId:`landsat-owned-by-${userId}`}],problemAreas:[]}}};
    const weather={id:weatherContextId(userId,selected.id),userId,type:'fieldContext',fieldId:selected.id,locationKey:keyValue,elevation:{status:'loaded',feet:980,meters:298.704,fetchedAt:new Date(NOW).toISOString(),source:{id:'usgs'}}};
    for(const doc of [farm,satellite,weather])save(doc);
    return {farm,satellite,weather};
  }
  return {documents,accesses,save,call,derived,stateFor,ownerDocuments:identity=>[...documents.values()].filter(d=>d.userId===identity.userId)};
}

test('Free state accepts context, independent satellite permissions and report fields through unrelated saves',async()=>{
  const f=fixture();assert.equal((await f.call('PUT',{fields:[field]})).status,200);
  let response=await f.call('GET');assert.deepEqual(response.body.fields,[field]);
  assert.equal((await f.call('PUT',{theme:'midnight',readingPreferences:{enabled:true,textSize:'large'}})).status,200);
  response=await f.call('GET');assert.deepEqual(response.body.fields,[field]);assert.equal(response.body.theme,'midnight');
  assert.equal(f.ownerDocuments(farmer).find(d=>d.type==='account').plan,'free');
  const blank={...field,marketReportId:'',marketLabel:'',contextConsent:false,satelliteConsent:false,landsatConsent:false};
  assert.equal((await f.call('PUT',{fields:[blank]})).status,200);assert.deepEqual((await f.call('GET')).body.fields,[blank]);
});

test('legacy fields do not gain context or satellite permission implicitly',async()=>{
  const f=fixture(),legacy={id:'legacy',name:'Earlier field',crop:'Wheat',dataConsent:true,location:{latitude:47.25,longitude:-120.25}};
  assert.equal((await f.call('PUT',{fields:[legacy]})).status,200);const saved=(await f.call('GET')).body.fields[0];assert.deepEqual(saved,legacy);
  assert.equal(saved.contextConsent,undefined);assert.equal(saved.satelliteConsent,undefined);assert.equal(saved.landsatConsent,undefined);assert.equal(saved.marketReportId,undefined);
  const noLocation={id:'old-no-location',name:'Older record',crop:'Potatoes'};
  assert.equal((await f.call('PUT',{fields:[noLocation]})).status,200);assert.deepEqual((await f.call('GET')).body.fields,[noLocation]);
});

test('NASA sharing is independently opt-in for existing Sentinel fields and supports NASA-only fields',async()=>{
  const f=fixture(),sentinelOnly={...field};delete sentinelOnly.landsatConsent;
  assert.equal((await f.call('PUT',{fields:[sentinelOnly]})).status,200);
  assert.equal((await f.call('GET')).body.fields[0].landsatConsent,undefined);
  const nasaOnly={...field,satelliteConsent:false,landsatConsent:true};
  assert.equal((await f.call('PUT',{fields:[nasaOnly]})).status,200);
  assert.deepEqual((await f.call('GET')).body.fields,[nasaOnly]);
  const derived=f.derived(farmer,nasaOnly);derived.satellite.result.history=[];f.save(derived.satellite);
  const exported=await f.call('GET',undefined,farmer,{export:'1'});
  assert.equal(exported.body.satelliteData.length,1);assert.equal(exported.body.satelliteData[0].landsat.history[0].ndvi,.61);
});

test('new consent and report fields reject malformed or provider-controlled values without altering valid saved state',async()=>{
  const f=fixture();await f.call('PUT',{fields:[field]});
  const changes=[...['contextConsent','satelliteConsent','landsatConsent'].flatMap(key=>['yes',1,0,null,{},[]].map(value=>({[key]:value}))),
    ...[1234,null,-1,'-123','1e3','123456789',' 1234','1234 ','1/../2','https://evil.example','1234?key=x'].map(marketReportId=>({marketReportId})),
    ...[null,123,{},'x'.repeat(121)].map(marketLabel=>({marketLabel})),{contextProviderUrl:'https://evil.example'},{satelliteSource:'https://evil.example'}];
  for(const change of changes){const result=await f.call('PUT',{fields:[{...field,...change}]});assert.equal(result.status,400,JSON.stringify(change));assert.deepEqual(f.stateFor(farmer).fields,[field]);}
  for(const stateKey of ['farmContextData','satelliteData','derivedFieldData'])assert.equal((await f.call('PUT',{[stateKey]:[]})).status,400);
});

test('derived data appear only in explicit owner export, never the routine state payload',async()=>{
  const f=fixture();await f.call('PUT',{fields:[field]});f.derived();
  const normal=await f.call('GET');for(const name of ['derivedFieldData','farmContextData','satelliteData'])assert.equal(normal.body[name],undefined);
  const exported=await f.call('GET',undefined,farmer,{export:'1'});assert.equal(exported.status,200);assert.equal(exported.body.farmContextData.length,1);assert.equal(exported.body.satelliteData.length,1);assert.equal(exported.body.derivedFieldData.length,1);
  assert.equal(exported.body.farmContextData[0].soil.historicalRecord,true);assert.equal(exported.body.satelliteData[0].history[0].ndvi,.67);
  assert.equal(exported.body.satelliteData[0].landsat.history[0].ndvi,.61);assert.equal(exported.body.satelliteData[0].landsat.history[0].ndre,null);assert.equal(exported.body.satelliteData[0].landsat.resolutionMeters,30);
  assert.equal((await f.call('GET',undefined,null,{export:'1'})).status,401);
});

test('other farmers and administrators cannot export another owners derived records even with matching field IDs',async()=>{
  const f=fixture();
  for(const identity of [farmer,other,admin]){await f.call('PUT',{fields:[{...field,name:`Orchard owned by ${identity.userId}`}]},identity);f.derived(identity);}
  for(const identity of [other,admin]){
    f.accesses.length=0;const exported=await f.call('GET',undefined,identity,{export:'1',userId:farmer.userId,id:`state-${farmer.userId}`});
    assert.equal(exported.status,200);assert.ok(JSON.stringify(exported.body).includes(`owned by ${identity.userId}`));assert.ok(!JSON.stringify(exported.body).includes(`owned by ${farmer.userId}`));assert.ok(!JSON.stringify(exported.body).includes(`fixture-owned-by-${farmer.userId}`));assert.ok(f.accesses.every(a=>a.userId===identity.userId));
  }
  assert.equal((await f.call('GET',undefined,farmer,{export:'1'},{'x-farmer-account-id':other.userId})).status,409);
});

test('export independently filters stale-location and revoked-consent derived documents even before pruning',async()=>{
  for(const change of [{contextConsent:false},{satelliteConsent:false},{landsatConsent:false},{crop:'Wheat'},{marketReportId:'4321'}]){
    const f=fixture();await f.call('PUT',{fields:[field]});f.derived();const state=f.ownerDocuments(farmer).find(d=>d.type==='state');Object.assign(state.state.fields[0],change);f.save(state);
    const exported=await f.call('GET',undefined,farmer,{export:'1'});
    if(change.contextConsent===false||change.crop||change.marketReportId)assert.equal(exported.body.farmContextData,undefined,JSON.stringify(change));
    assert.equal(exported.body.satelliteData,undefined,JSON.stringify(change));
  }
  const f=fixture();await f.call('PUT',{fields:[field]});f.derived();const state=f.ownerDocuments(farmer).find(d=>d.type==='state');state.state.fields[0]={...field,...normalizeGeometry({location:{latitude:47.28,longitude:-120.28}})};delete state.state.fields[0].boundary;f.save(state);
  const result=await f.call('GET',undefined,farmer,{export:'1'});assert.equal(result.body.farmContextData,undefined);assert.equal(result.body.satelliteData,undefined);assert.equal(result.body.derivedFieldData,undefined);
});

test('field location, crop, permissions and market edits prune obsolete owner-derived data only',async()=>{
  const movedBoundary={type:'Polygon',coordinates:[field.boundary.coordinates[0].map(([lon,lat])=>[lon+.001,lat+.001])]};
  for(const change of [{boundary:movedBoundary},{crop:'Wheat'},{contextConsent:false},{satelliteConsent:false},{landsatConsent:false},{marketReportId:'4321'}]){
    const f=fixture();await f.call('PUT',{fields:[field]});f.derived();await f.call('PUT',{fields:[field]},other);f.derived(other);const otherBefore=clone(f.ownerDocuments(other));
    assert.equal((await f.call('PUT',{fields:[{...field,...change}]})).status,200);
    const docs=f.ownerDocuments(farmer);
    if(change.satelliteConsent!==false&&change.landsatConsent!==false)assert.equal(docs.filter(d=>d.type==='farmContext').length,0,JSON.stringify(change));
    assert.equal(docs.filter(d=>d.type==='satelliteContext').length,0,JSON.stringify(change));
    assert.deepEqual(f.ownerDocuments(other),otherBefore);
  }
});

test('removing a field prunes every derived kind while an unrelated profile save preserves them',async()=>{
  const f=fixture();await f.call('PUT',{fields:[field],profile:{firstName:'Before'}});f.derived();
  const before=f.ownerDocuments(farmer).filter(d=>d.type!=='state');assert.equal((await f.call('PUT',{profile:{firstName:'After'}})).status,200);assert.deepEqual(f.ownerDocuments(farmer).filter(d=>d.type!=='state'),before);
  assert.equal((await f.call('PUT',{fields:[]})).status,200);assert.equal(f.ownerDocuments(farmer).filter(d=>['farmContext','satelliteContext','fieldContext'].includes(d.type)).length,0);
});

test('DELETE erases own Phase 2/3 derived records, preserves memberships and other owners, and redacts brief payloads',async()=>{
  const f=fixture();for(const identity of [farmer,other,admin]){await f.call('PUT',{fields:[field]},identity);f.derived(identity);f.save({id:`brief-${identity.userId}`,userId:identity.userId,type:'dailyBrief',date:'2026-10-07',brief:{summary:`Private brief ${identity.userId}`}});}
  const otherBefore=clone(f.ownerDocuments(other)),adminBefore=clone(f.ownerDocuments(admin)),accountBefore=clone(f.ownerDocuments(farmer).find(d=>d.type==='account'));
  assert.equal((await f.call('DELETE')).status,204);assert.equal((await f.call('GET',undefined,farmer,{export:'1'})).status,204);
  assert.deepEqual(f.ownerDocuments(other),otherBefore);assert.deepEqual(f.ownerDocuments(admin),adminBefore);assert.deepEqual(f.ownerDocuments(farmer).find(d=>d.type==='account'),accountBefore);
  const own=f.ownerDocuments(farmer);assert.equal(own.filter(d=>['state','fieldContext','farmContext','satelliteContext'].includes(d.type)).length,0);
  const brief=own.find(d=>d.type==='dailyBrief');assert.equal(brief.deleted,true);assert.equal(brief.brief,null);assert.equal(brief.date,'2026-10-07');
  assert.ok(!JSON.stringify(own).includes('Private orchard'));assert.equal((await f.call('DELETE')).status,204);
});

test('administrator DELETE with another userId query still only deletes the administrator own farm records',async()=>{
  const f=fixture();for(const identity of [farmer,admin]){await f.call('PUT',{fields:[field]},identity);f.derived(identity);}
  const farmerBefore=clone(f.ownerDocuments(farmer));f.accesses.length=0;
  assert.equal((await f.call('DELETE',undefined,admin,{userId:farmer.userId,id:`state-${farmer.userId}`})).status,204);
  assert.deepEqual(f.ownerDocuments(farmer),farmerBefore);assert.ok(f.accesses.every(a=>a.userId===admin.userId||a.userId==='messaging-directory'&&a.type==='messagingRecipient'&&a.bindingOwner===admin.userId));assert.equal(f.ownerDocuments(admin).length,1);assert.equal(f.ownerDocuments(admin)[0].type,'account');assert.equal(f.ownerDocuments(admin)[0].plan,'premium');
});
