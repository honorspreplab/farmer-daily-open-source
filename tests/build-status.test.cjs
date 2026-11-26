require('./helpers/admin-environment.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {createBuildStatusHandler} = require('../api/build-status');
const progress = require('../api/shared/build-progress');
const ADMIN_EMAILS=['admin1@example.invalid','admin2@example.invalid','admin3@example.invalid'];
const identity=(email='farmer@example.test',overrides={})=>({userId:'person-1',userDetails:email,identityProvider:'aad',userRoles:['anonymous','authenticated'],...overrides});
function request(principal,extras={}) {
  return {method:'GET',headers:principal?{'x-ms-client-principal':Buffer.from(JSON.stringify(principal)).toString('base64')}:{},...extras};
}
function fixture() {
  const reads=[],created=[],queries=[],documents=new Map();
  const container={
    item(id,userId){return {async read(){reads.push({id,userId});const resource=documents.get(`${userId}/${id}`);if(!resource)throw Object.assign(new Error('missing'),{code:404});return {resource:structuredClone(resource)};}};},
    items:{
      async create(document){created.push(structuredClone(document));documents.set(`${document.userId}/${document.id}`,structuredClone(document));return {resource:structuredClone(document)};},
      query(){queries.push(true);throw new Error('Build status must not query user or farm records');}
    }
  };
  const handler=createBuildStatusHandler({getContainer:()=>container,now:()=>Date.parse('2026-10-03T16:00:00Z')});
  return {reads,created,queries,documents,async call(req){const context={log:{error(){}}};await handler(context,req);assert.equal(context.res.headers['Cache-Control'],'no-store');assert.equal(context.res.headers['Content-Type'],'application/json');return context.res;}};
}

test('build status requires authentication and denies non-administrators before storage access',async()=>{
  const f=fixture();
  assert.equal((await f.call(request(null))).status,401);
  assert.equal((await f.call(request(identity()))).status,403);
  assert.equal(f.reads.length,0);assert.equal(f.created.length,0);assert.equal(f.queries.length,0);
});

test('each configured administrator gets build status through trusted Microsoft identity, independent of role claims',async()=>{
  for(const [index,email]of ADMIN_EMAILS.entries()) {
    const f=fixture(),principal=identity(` ${email.toUpperCase()} `,{userId:`admin-${index}`});
    const response=await f.call(request(principal));
    assert.equal(response.status,200);assert.deepEqual(response.body.features,progress.features);
    assert.deepEqual(f.reads,[{id:`account-admin-${index}`,userId:`admin-${index}`}]);
    assert.equal(f.created[0].email,email);assert.equal(f.queries.length,0);
    assert.equal(response.body.user,undefined);assert.equal(response.body.account,undefined);assert.equal(response.body.state,undefined);
  }
});

test('body, query, administrator role, and untrusted provider claims cannot promote a user',async()=>{
  const f=fixture();
  for(const req of [
    request(identity(),{body:{email:ADMIN_EMAILS[0],isAdmin:true,plan:'premium'},query:{email:ADMIN_EMAILS[0],admin:'true'}}),
    request(identity('farmer@example.test',{userRoles:['authenticated','administrator','admin','farmer']})),
    request(identity(`${ADMIN_EMAILS[0]}.attacker.test`)),
    request(identity(ADMIN_EMAILS[0],{identityProvider:'google'})),
    request(identity(ADMIN_EMAILS[0],{identityProvider:'github'})),
    request(identity(ADMIN_EMAILS[0],{userRoles:['anonymous']}))
  ]) assert.ok([401,403].includes((await f.call(req)).status));
  assert.equal(f.reads.length,0);assert.equal(f.created.length,0);
});

test('malformed identity and stale owner headers never expose administrator build status',async()=>{
  const f=fixture();
  for(const encoded of ['not base64',Buffer.from('null').toString('base64'),Buffer.from('{}').toString('base64'),'x'.repeat(16001)]) {
    assert.equal((await f.call(request(null,{headers:{'x-ms-client-principal':encoded}}))).status,401);
  }
  const mismatch=request(identity(ADMIN_EMAILS[0]));mismatch.headers['x-farmer-account-id']='another-person';
  assert.equal((await f.call(mismatch)).status,409);assert.equal(f.reads.length,0);
});

test('build status is read-only and never enumerates other accounts or private farm data',async()=>{
  const f=fixture();
  assert.equal((await f.call(request(identity(ADMIN_EMAILS[0]),{method:'POST',body:{status:'Validated'}}))).status,405);
  assert.equal(f.reads.length,0);
  f.documents.set('person-1/account-person-1',{id:'account-person-1',userId:'person-1',email:ADMIN_EMAILS[0],identityProvider:'aad',plan:'free',privateNote:'DO NOT EXPOSE'});
  f.documents.set('another/state-another',{id:'state-another',userId:'another',state:{fields:[{name:'PRIVATE FIELD'}]}});
  const result=await f.call(request(identity(ADMIN_EMAILS[0])));
  assert.equal(result.status,200);assert.doesNotMatch(JSON.stringify(result.body),/DO NOT EXPOSE|PRIVATE FIELD/);assert.equal(f.queries.length,0);
  assert.deepEqual(f.reads,[{id:'account-person-1',userId:'person-1'}]);
});

test('progress exposes exactly four maturity states with unique features across phases zero through five',async()=>{
  const response=await fixture().call(request(identity(ADMIN_EMAILS[0]))),data=response.body;
  assert.equal(response.status,200);assert.match(data.version,/^\d+\.\d+\.\d+$/);
  const statuses=['Not started','Building','Working','Validated'];assert.deepEqual(data.statuses,statuses);
  assert.deepEqual(Object.keys(data.meaning),statuses);
  for(const status of statuses)assert.equal(typeof data.meaning[status],'string');
  assert.match(data.meaning.Validated,/not a guarantee of provider uptime/);
  assert.ok(data.features.length>0);assert.equal(new Set(data.features.map(item=>item.id)).size,data.features.length);
  assert.deepEqual([...new Set(data.features.map(item=>item.phase))].sort(),[0,1,2,3,4,5]);
  for(const feature of data.features) {
    assert.ok(statuses.includes(feature.status));assert.equal(typeof feature.name,'string');assert.ok(feature.name.length>0);
    assert.equal(typeof feature.detail,'string');assert.ok(feature.detail.length>0);
  }
});

test('future integrations and closed-app delivery are not represented as working or validated',async()=>{
  const data=(await fixture().call(request(identity(ADMIN_EMAILS[0])))).body;
  for(const id of ['sensors','wsu','actions','background'])assert.equal(data.features.find(item=>item.id===id).status,'Not started',id);
  for(const id of ['equipment-records','sensor-imports','knowledge','internal-workflows','calendar-export'])assert.ok(['Working','Validated'].includes(data.features.find(item=>item.id===id).status),id);
  for(const id of ['markets','statistics','air','water'])assert.equal(data.features.find(item=>item.id===id).status,'Building',id);
  assert.equal(data.features.find(item=>item.id==='calendar-connections').status,'Building');
  assert.match(data.features.find(item=>item.id==='calendar-connections').detail,/real-account validation still required/);
  for(const id of ['soil','satellite','crop-history'])assert.ok(['Working','Validated'].includes(data.features.find(item=>item.id===id).status),id);
  assert.match(data.features.find(item=>item.id==='schedule').detail,/while open or on return; not background delivery/);
  assert.match(data.features.find(item=>item.id==='notifications').detail,/generic notification hides farm details/);
  assert.match(data.limitations.join(' '),/No closed-app scheduler.*Optional OpenAI.*API keys.*current-year.*No Phase 4/);
  assert.deepEqual(require('../build-progress'),progress,'client and API present the same build roadmap');
});
