'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Exercise the real browser answer function without duplicating its implementation.
const script = fs.readFileSync(path.join(__dirname, '../phase-one.js'), 'utf8');
const start = script.indexOf('  async function answer(question){');
const end = script.indexOf('  function boot(){', start);
assert.ok(start >= 0 && end > start);
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const advisory = changes => ({fieldId:'one',fieldName:'Block 12',title:'Check the frost forecast',whatChanged:'The forecast reaches 32°F.',whyItMatters:'Inspect the recorded bloom-stage block first.',suggestedAction:'Review your protection plan.',confidence:'medium',validUntil:new Date(Date.now()+3600000).toISOString(),...changes});
const brief = changes => ({date:today(),createdAt:new Date().toISOString(),advisories:[advisory()],...changes});
function harness({saved=null,remote={brief:null},load,language='en',snapshotOwner='owner'}={}){
  const reads=[],actions=[];
  const context={membership:{user:{id:'owner'},plan:'free'},cloudEnabled:true,cloudOwner:'owner',savedDailyBrief:saved,savedDailyBriefOwner:snapshotOwner,tasks:[],profile:{language},Date,
    fields:()=>[{id:'one',name:'Block 12'},{id:'two',name:'Block 7'}],pacificDate:today,
    tr:(en,es)=>language==='es'?es:en,stamp:value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():'Unavailable',
    showModal:()=>actions.push('task'),openPage:page=>actions.push(page),window:{FarmerFieldMap:{loadFieldData:()=>{actions.push('weather');throw new Error('Unexpected weather lookup');}}}};
  context.localStorage={getItem:()=>context.cloudOwner};
  context.loadDailyBrief=async (...args)=>{reads.push(args);return load?load(context):remote;};
  vm.createContext(context);vm.runInContext(script.slice(start,end)+'\nthis.answer=answer;',context);
  return {context,reads,actions,answer:q=>context.answer(q)};
}
test('exact suggested priority question with no brief has a concrete next step, never the same prompt',async()=>{
  const h=harness();
  for(let i=0;i<2;i++){
    const result=await h.answer('Why these priorities?');
    assert.match(result,/no priorities to explain/);assert.match(result,/Get today’s brief/);assert.doesNotMatch(result,/Try .*Why these priorities|I can explain/);
  }
  assert.deepEqual(h.reads,[[false],[false]]);assert.deepEqual(h.actions,[]);
});
test('missing local brief recovers saved server evidence using a read, not generation',async()=>{
  const h=harness({remote:{brief:brief()}}),result=await h.answer('Why these priorities?');
  assert.match(result,/32°F/);assert.match(result,/recorded bloom-stage/);assert.match(result,/Confidence: medium/);assert.deepEqual(h.reads,[[false]]);assert.deepEqual(h.actions,[]);
});
test('loaded current-owner brief is explained directly without fetching or writing',async()=>{
  const h=harness({saved:brief()}),result=await h.answer('Why these priorities?');
  assert.match(result,/1\. Block 12/);assert.match(result,/Review your protection plan/);assert.deepEqual(h.reads,[]);assert.deepEqual(h.actions,[]);
});
test('empty and legacy summaries need refresh, not fabricated reasons',async()=>{
  for(const saved of [brief({advisories:[]}),{date:today(),items:['Unsupported older summary']},brief({advisories:'invalid'}),brief({advisories:[null,{}]})]){
    const h=harness({saved,remote:{brief:saved}}),result=await h.answer('Why these priorities?');
    assert.match(result,/no detailed priority explanations/);assert.match(result,/Refresh brief/);assert.doesNotMatch(result,/32°F|undefined/);assert.deepEqual(h.reads,[[false]]);
  }
});
test('deleted brief directs farm setup and never repeats removed content',async()=>{
  const h=harness({saved:brief({deleted:true}),remote:{deleted:true,brief:brief()}}),result=await h.answer('Why these priorities?');
  assert.match(result,/deleted with your farm data/);assert.doesNotMatch(result,/32°F|bloom-stage/);assert.deepEqual(h.actions,[]);
});
test('uncovered named field explains limited coverage without substituting another field or weather',async()=>{
  const h=harness({saved:brief()}),result=await h.answer('Why Block 7?');
  assert.match(result,/no priority for Block 7/);assert.match(result,/does not mean the field has no risks/);assert.doesNotMatch(result,/Block 12|32°F/);assert.deepEqual(h.actions,[]);assert.deepEqual(h.reads,[]);
});
test('expired or malformed validity is warned about before the saved condition',async()=>{
  for(const validUntil of ['invalid',null,new Date(Date.now()-3600000).toISOString()]){
    const h=harness({saved:brief({advisories:[advisory({validUntil})]})}),result=await h.answer('Why these priorities?');
    assert.match(result,/expired or has no verified expiry/);assert.ok(result.indexOf('refresh before acting')<result.indexOf('32°F'));
  }
});
test('yesterday snapshot is checked against todays saved snapshot before explanation',async()=>{
  const h=harness({saved:brief({date:'2000-01-01'}),remote:{brief:null}}),result=await h.answer('What changed?');
  assert.match(result,/no priorities to explain/);assert.doesNotMatch(result,/32°F/);assert.deepEqual(h.reads,[[false]]);
});
test('failed or unavailable brief read has an honest retry path with no help-loop',async()=>{
  for(const load of [async()=>undefined,async()=>{throw new Error('provider detail should not be repeated');}]){
    const h=harness({load}),result=await h.answer('Why these priorities?');
    assert.match(result,/couldn’t load your saved brief/);assert.match(result,/retry/);assert.doesNotMatch(result,/provider detail|Try .*Why|32°F/);
  }
});
test('Spanish why and priorities variants retain useful empty and saved replies',async()=>{
  for(const q of ['¿Por qué estas prioridades?','¿Por que estas prioridades?','Mis prioridades']){
    assert.match(await harness({language:'es'}).answer(q),/no hay prioridades que explicar/);
    assert.match(await harness({language:'es',saved:brief()}).answer(q),/Confianza: medium/);
  }
});
test('in-memory brief from a different owner is not used',async()=>{
  const h=harness({saved:brief(),snapshotOwner:'previous-owner'}),result=await h.answer('Why these priorities?');
  assert.match(result,/no priorities to explain/);assert.doesNotMatch(result,/32°F/);assert.deepEqual(h.reads,[[false]]);
});
test('account switch, sign-out or device-owner change during a read suppresses all old-owner content',async()=>{
  for(const mutate of [ctx=>{ctx.membership.user.id='new-owner';},ctx=>{ctx.cloudEnabled=false;},ctx=>{ctx.cloudOwner='new-owner';}]){
    const h=harness({load:async context=>{mutate(context);return {brief:brief()};}});
    assert.equal(await h.answer('Why these priorities?'),'');assert.deepEqual(h.actions,[]);
  }
});
test('disconnected or wrong-owner sessions do not read briefs or expose saved evidence',async()=>{
  for(const mutate of [ctx=>{ctx.cloudEnabled=false;},ctx=>{ctx.cloudOwner='new-owner';},ctx=>{ctx.membership=null;}]){
    const h=harness({saved:brief()});mutate(h.context);assert.equal(await h.answer('Why these priorities?'),'');assert.deepEqual(h.reads,[]);
  }
});
