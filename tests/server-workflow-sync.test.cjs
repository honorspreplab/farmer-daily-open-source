const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync(require('node:path').join(__dirname,'..','app.js'),'utf8');
const start=app.indexOf('function sameWorkflowValue('),end=app.indexOf('async function runServerWorkflowRequest(',start);
assert.ok(start>=0&&end>start);
function fixture(){
  const local={profile:{farmName:'My farm',firstName:'Farmer'},fields:[{id:'field-a',name:'My orchard',crop:'Apples'}],theme:'field',readingPreferences:{enabled:false,textSize:'comfortable'},observations:[],jobs:[],jobEvents:[]};
  const oldTasks=[{id:'old',name:'Original task'}],storage=new Map([['farmerDailyCloudOwner','owner'],['farmerDailyTasks',JSON.stringify(oldTasks)],['farmerDailyWorkflowRevision','1'],['farmerDailyRemoteUpdatedAt','old-stamp']]);
  const renders=[],collect=()=>({...structuredClone(local),tasks:JSON.parse(storage.get('farmerDailyTasks'))});
  const context=vm.createContext({cloudEnabled:true,cloudWorkflowRevision:1,lastCloudPayload:'old-payload',tasks:oldTasks,membership:{user:{id:'owner'}},collectCloudState:collect,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},renderTasks:()=>renders.push('tasks'),window:{FarmerWorkspace:{render:()=>renders.push('farm')}},setSyncStatus:()=>renders.push('status')});
  vm.runInContext(app.slice(start,end),context);
  return {context,storage,renders,local,remote:()=>({...collect(),tasks:[...oldTasks,{id:'server-task',name:'Approved task'}],workflowRevision:2,updatedAt:'new-stamp'}),apply:context.applyServerWorkflowState};
}
test('a current-owner workflow result adopts tasks and the server revision before marking synchronization complete',()=>{
  const f=fixture();f.apply(f.remote(),'owner');
  assert.equal(f.context.tasks.length,2);assert.equal(f.context.cloudWorkflowRevision,2);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'),'new-stamp');assert.equal(f.storage.get('farmerDailyWorkflowRevision'),'2');
  assert.equal(JSON.parse(f.context.lastCloudPayload).tasks.length,2);assert.equal(f.context.cloudEnabled,true);
  assert.deepEqual(f.renders,['tasks','farm','status']);
});
test('newer non-task server edits pause synchronization without stamping stale local records as current',()=>{
  for(const key of ['profile','fields','theme','readingPreferences','observations','jobs','jobEvents']){
    const f=fixture(),remote=f.remote();remote[key]=key==='profile'?{...remote.profile,farmName:'Newer server farm'}:key==='theme'?'slate':key==='readingPreferences'?{enabled:true,textSize:'large'}:[{id:'newer-server-record'}];
    assert.throws(()=>f.apply(remote,'owner'),/Newer farm edits/);
    assert.equal(f.context.cloudEnabled,false,key);assert.equal(f.context.tasks.length,1,key);
    assert.equal(f.context.cloudWorkflowRevision,1);assert.equal(f.storage.get('farmerDailyWorkflowRevision'),'1');
    assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'),'old-stamp');assert.equal(f.context.lastCloudPayload,'old-payload');
    assert.equal(JSON.parse(f.storage.get('farmerDailyDeviceBackup:owner')).profile.farmName,'My farm');assert.deepEqual(f.renders,[]);
  }
});
test('equivalent nested records with different property order do not cause false sync conflicts',()=>{
  const f=fixture(),remote=f.remote();remote.profile={firstName:'Farmer',farmName:'My farm'};remote.fields=[{crop:'Apples',name:'My orchard',id:'field-a'}];
  f.apply(remote,'owner');assert.equal(f.context.cloudEnabled,true);assert.equal(f.context.cloudWorkflowRevision,2);
});
test('changed account and malformed or older task revisions cannot overwrite device records',()=>{
  const f=fixture();assert.throws(()=>f.apply(f.remote(),'other'),/Account changed/);
  for(const revision of [undefined,0,-1,1.5,'2'])assert.throws(()=>f.apply({...f.remote(),workflowRevision:revision},'owner'),/invalid task revision/);
  assert.equal(f.storage.get('farmerDailyRemoteUpdatedAt'),'old-stamp');assert.equal(f.context.tasks.length,1);
});
