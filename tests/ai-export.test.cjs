'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportAiUsage, PARTITION } = require('../api/shared/ai-budget');
const { createStateHandler } = require('../api/state');
const { memoryContainer, sampleRecords, request } = require('./helpers/ai-fixture.cjs');
const NOW = Date.parse('2026-10-24T15:00:00Z');
function setup() {
  const container = memoryContainer(sampleRecords(NOW));
  for (const owner of ['sample-owner','other-owner']) container.put({ id:`ai-usage-${owner}-2026-10-24`, userId:owner, type:'aiUsage', day:'2026-10-24', requests:owner==='sample-owner'?3:9, surprise:'PRIVATE EXTRA' });
  container.put({ id:'ai-budget-2026-10-24', userId:PARTITION, type:'aiBudget', day:'2026-10-24', requests:20, reservedMicros:123456 });
  return container;
}
test('AI usage export is partition scoped, bounded and contains counters only',async()=>{
  const container=setup(), queries=[], original=container.items.query;
  container.items.query=(spec,options)=>{queries.push({spec,options});return original(spec,options);};
  const data=await exportAiUsage(container,'sample-owner');
  assert.deepEqual(data,{dailyRequestLimit:10,recordLimit:366,records:[{day:'2026-10-24',requests:3}]});
  assert.equal(queries[0].options.partitionKey,'sample-owner');assert.match(queries[0].spec.query,/TOP 366/);assert.equal(queries[0].options.maxItemCount,100);
  assert.ok(!JSON.stringify(data).includes('PRIVATE'));assert.ok(!JSON.stringify(data).includes('reservedMicros'));
  await assert.rejects(exportAiUsage(container,'../other-owner'),error=>error.status===400);
});
test('routine state omits AI usage; explicit export includes only owner counters',async()=>{
  const container=setup(), handler=createStateHandler({getContainer:()=>container,now:()=>NOW});
  async function run(query={}){const context={};await handler(context,{...request(),query});return context.res;}
  const routine=await run();assert.equal(routine.status,200);assert.equal(routine.body.aiUsage,undefined);
  const exported=await run({export:'1'});assert.equal(exported.status,200,JSON.stringify(exported.body));assert.equal(exported.body.aiUsage.records[0].requests,3);
});
test('farm data deletion retains only AI quota metadata and does not change another owner',async()=>{
  const container=setup(), handler=createStateHandler({getContainer:()=>container,now:()=>NOW}), context={};
  await handler(context,request('DELETE'));assert.equal(context.res.status,204,JSON.stringify(context.res.body));
  assert.equal(container.get('state-sample-owner','sample-owner'),undefined);
  assert.equal(container.get('ai-usage-sample-owner-2026-10-24','sample-owner').requests,3);
  assert.equal(container.get('ai-usage-other-owner-2026-10-24','other-owner').requests,9);
  const routine={};await handler(routine,request());assert.equal(routine.res.status,204);
  const exported={};await handler(exported,{...request(),query:{export:'1'}});assert.equal(exported.res.status,200);
  assert.deepEqual(exported.res.body,{aiUsage:{dailyRequestLimit:10,recordLimit:366,records:[{day:'2026-10-24',requests:3}]}});
});
test('empty and malformed usage exports never invent or leak a counter',async()=>{
  const container=memoryContainer();assert.equal(await exportAiUsage(container,'sample-owner'),null);
  container.put({id:'bad-counter',userId:'sample-owner',type:'aiUsage',day:'2026-02-30',requests:2,prompt:'PRIVATE'});
  container.put({id:'bad-count',userId:'sample-owner',type:'aiUsage',day:'2026-10-24',requests:11,prompt:'PRIVATE'});
  assert.equal(await exportAiUsage(container,'sample-owner'),null);
});
