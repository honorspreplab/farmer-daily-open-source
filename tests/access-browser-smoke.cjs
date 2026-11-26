// Optional browser integration check: node tests/access-browser-smoke.cjs
require('./helpers/admin-environment.cjs');
// Loads the real application in an isolated Chrome profile with local API fixtures.
// No user credentials, existing browser profile, or external services are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {createStateHandler} = require('../api/state');
const {createAdminHandler} = require('../api/management');
const managementBinding = require('../api/management/function.json').bindings.find(binding=>binding.type==='httpTrigger');
const managementEndpoint = `/api/${managementBinding.route}`;
assert.equal(managementEndpoint,'/api/management','Browser smoke follows the actual deployable management route');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const date = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const baseProfile = {firstName:'Fixture',farmName:'Fixture Farm',locationId:'kirkland',location:'Kirkland, WA',region:'puget',role:'owner',crops:['Apples'],priorityField:'Orchard',acres:'10',wind:'15',market:'5',briefTime:'06:30',language:'English',phone:'',address:''};
const stamp = new Date().toISOString();
const account = (id,email,plan='free',isAdmin=false) => ({user:{id,email,joinedAt:stamp,lastSeenAt:stamp},isAdmin,plan,request:null,date});
const freeAccount = account('free-fixture','actual-farmer@example.com');
const otherAccount = account('other-fixture','other-farmer@example.com');
const adminAccount = account('admin-fixture','admin3@example.invalid','premium',true);
const premiumAccount = account('premium-fixture','premium-fixture@example.com','premium');
const newFreeAccount = account('new-free-fixture','new-free@example.com');
const newAdminAccount = account('new-admin-fixture','admin1@example.invalid','premium',true);
let activeAccount = freeAccount;
const farmStates = new Map([
  [freeAccount.user.id,{profile:{...baseProfile,firstName:'Actual',farmName:'Actual Farm'},theme:'field'}],
  [otherAccount.user.id,{profile:{...baseProfile,firstName:'Other',farmName:'Other Farm'},theme:'field'}],
  [adminAccount.user.id,{profile:{...baseProfile,firstName:'Admin',farmName:'Admin Farm'},theme:'field',tasks:[],observations:[],jobs:[],jobEvents:[]}],
  [premiumAccount.user.id,{profile:{...baseProfile,firstName:'Premium',farmName:'Premium Farm'},theme:'field',tasks:[],observations:[],jobs:[],jobEvents:[]}]
]);
const savedBriefs = new Map(), writes = [], decisions = [];
const stateVersions=new Map(Array.from(farmStates.keys(),userId=>[userId,1]));
let briefPosts=0, weatherRequests=0, fieldDataRequests=0, adminReads=0, premiumRequests=0;
let legacyAdminRequests=0;
let cloudOffline=false;
let logoutRequests=0;
const stateResponses = [];
const managementResponses = [];
let stateDeletes=0;
const accountDocuments=new Map([freeAccount,otherAccount,adminAccount,premiumAccount,newFreeAccount,newAdminAccount,
  {...account('second-request','second-farmer@example.com'),request:{id:'request-two',status:'pending',reason:'Help me plan our farm tasks.',requestedAt:stamp}}
].map(item=>[item.user.id,{
  id:`account-${item.user.id}`,userId:item.user.id,type:'account',schemaVersion:1,
  email:item.user.email,identityProvider:'aad',joinedAt:stamp,lastSeenAt:stamp,plan:item.plan,
  request:item.request,requestHistory:[],_etag:'fixture-1',
  // Defense-in-depth: API account projections must not expose unexpected private fields.
  profile:{address:'PRIVATE-FARM-ADDRESS',phone:'PRIVATE-FARM-PHONE'},state:{notes:'PRIVATE-FARM-NOTES'}
}]));
let accountRevision=1;
const accountContainer={
  item(id,userId){
    assert.equal(id,`account-${userId}`,'Admin handler only reads account documents, never farm state');
    return {
      async read(){
        const document=accountDocuments.get(userId);
        if(!document)throw Object.assign(new Error('No fixture account'),{code:404});
        return {resource:structuredClone(document)};
      },
      async replace(document,options){
        const previous=accountDocuments.get(userId);
        if(!previous||options?.accessCondition?.type!=='IfMatch'||options.accessCondition.condition!==previous._etag){
          throw Object.assign(new Error('Fixture account changed'),{code:412});
        }
        const saved={...structuredClone(document),_etag:`fixture-${++accountRevision}`};
        accountDocuments.set(userId,saved);
        return {resource:structuredClone(saved)};
      }
    };
  },
  items:{
    query(spec,options){
      assert.equal(spec.parameters.find(parameter=>parameter.name==='@type')?.value,'account');
      assert.match(spec.query,/WHERE c\.type = @type/);
      assert.doesNotMatch(spec.query,/SELECT\s+\*|c\.(?:profile|state|address|phone)\b/i,'Directory query does not request private farm fields');
      assert.equal(options.maxItemCount,50);
      return {async fetchNext(){return {resources:Array.from(accountDocuments.values(),document=>structuredClone(document)),continuationToken:null};}};
    }
  }
};
const managementHandler=createAdminHandler({getContainer:()=>accountContainer});

function weatherFixture() {
  const now=Date.now(),start=Math.floor(now/3600000)*3600000;
  const tomorrow=new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString();
  return {fetchedAt:new Date(now).toISOString(),updated:null,source:{id:'open-meteo'},fallback:true,office:null,
    hourly:Array.from({length:72},(_,i)=>({startTime:new Date(start+i*3600000).toISOString(),endTime:new Date(start+(i+1)*3600000).toISOString(),temperature:60+(i%10),temperatureUnit:'F',shortForecast:'Partly cloudy',windSpeed:'5 mph',windDirection:'W',probabilityOfPrecipitation:{value:20}})),
    daily:[{startTime:tomorrow,endTime:new Date(Date.parse(tomorrow)+86400000).toISOString(),isDaytime:true,temperature:66,temperatureUnit:'F',shortForecast:'Mostly sunny',detailedForecast:'Mostly sunny with a high of 66°F.',probabilityOfPrecipitation:{value:20}}]};
}
async function body(req) {let text='';for await(const chunk of req)text+=chunk;return text?JSON.parse(text):{};}
function json(res,status,value) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
// Exercise the real state GET/PUT/DELETE contracts. A fabricated {} response used to
// hide the first-sign-in bug because the API actually returned a missing state.
const stateHandler=createStateHandler({getContainer:()=>({
  item(id,userId){
    assert.equal(userId,activeAccount.user.id);
    return {
      async read(){
        if(id===`account-${userId}`)return {resource:{id,userId,type:'account',email:activeAccount.user.email,identityProvider:'aad',plan:activeAccount.plan,request:activeAccount.plan==='premium'?{status:'approved'}:null}};
        if(id===`operations-${userId}`||id===`calendar-${userId}`||id===`messaging-${userId}`)throw Object.assign(new Error('No fixture connected-farm or messaging record'),{code:404});
        assert.equal(id,`state-${userId}`);
        if(!farmStates.has(userId))throw Object.assign(new Error('No fixture state'),{code:404});
        return {resource:{id,userId,type:'state',state:structuredClone(farmStates.get(userId)),_etag:String(stateVersions.get(userId))}};
      },
      async replace(document,options){
        assert.equal(id,`state-${userId}`);
        if(!farmStates.has(userId)||options?.accessCondition?.type!=='IfMatch'||options.accessCondition.condition!==String(stateVersions.get(userId))){
          throw Object.assign(new Error('Fixture state changed'),{code:412});
        }
        stateVersions.set(userId,stateVersions.get(userId)+1);
        farmStates.set(userId,structuredClone(document.state));
        return {resource:{...structuredClone(document),_etag:String(stateVersions.get(userId))}};
      },
      async delete(){assert.equal(id,`state-${userId}`);farmStates.delete(userId);stateVersions.delete(userId);stateDeletes++;}
    };
  },
  items:{
    async create(document){
      assert.equal(document.id,`state-${document.userId}`);
      if(farmStates.has(document.userId))throw Object.assign(new Error('Fixture state exists'),{code:409});
      farmStates.set(document.userId,structuredClone(document.state));stateVersions.set(document.userId,1);
      return {resource:{...structuredClone(document),_etag:'1'}};
    },
    query(){return {async fetchAll(){return {resources:[]};}};}
  }
})});
async function serveState(req,res,url){
  const context={log:{error(){},warn(){}}};
  const principal={userId:activeAccount.user.id,userDetails:activeAccount.user.email,identityProvider:'aad',userRoles:['anonymous','authenticated']};
  const input=req.method==='PUT'?await body(req):undefined;
  await stateHandler(context,{method:req.method,body:input,headers:{...req.headers,'x-ms-client-principal':Buffer.from(JSON.stringify(principal)).toString('base64')},query:Object.fromEntries(url.searchParams)});
  const response=context.res;
  if(req.method==='PUT'&&response.status===200)writes.push({userId:activeAccount.user.id,data:structuredClone(input)});
  stateResponses.push({userId:activeAccount.user.id,method:req.method,status:response.status});
  res.writeHead(response.status,response.headers);
  res.end(response.status===204?undefined:JSON.stringify(response.body));
}
async function serveManagement(req,res,url){
  const input=req.method==='POST'?await body(req):undefined;
  if(input)decisions.push(input);else adminReads++;
  const context={log:{error(){},warn(){}}};
  const principal={userId:activeAccount.user.id,userDetails:activeAccount.user.email,identityProvider:'aad',userRoles:['anonymous','authenticated']};
  await managementHandler(context,{
    method:req.method,body:input,query:Object.fromEntries(url.searchParams),
    headers:{...req.headers,'x-ms-client-principal':Buffer.from(JSON.stringify(principal)).toString('base64')}
  });
  managementResponses.push({method:req.method,status:context.res.status,body:structuredClone(context.res.body)});
  res.writeHead(context.res.status,context.res.headers);
  res.end(JSON.stringify(context.res.body));
}
const mime={'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/.auth/logout'){logoutRequests++;res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><html><body><main id="fixtureSignedOut">Fixture signed out</main></body></html>');return;}
    if(cloudOffline&&['/api/state','/api/brief'].includes(url.pathname)){json(res,503,{error:'Fixture cloud connection unavailable'});return;}
    if(url.pathname==='/api/account'){
      if(req.method==='POST'){
        const input=await body(req);assert.equal(input.action,'request-premium');premiumRequests++;
        activeAccount.request={id:'request-one',status:'pending',reason:input.reason,requestedAt:stamp};
        accountDocuments.get(activeAccount.user.id).request={...activeAccount.request};
      }
      json(res,200,activeAccount);return;
    }
    if(url.pathname==='/api/state'){await serveState(req,res,url);return;}
    if(url.pathname==='/api/brief'){
      let saved=savedBriefs.get(activeAccount.user.id)||null;
      let reused=true;
      if(req.method==='POST'){
        await body(req);briefPosts++;
        if(!saved){saved={date,createdAt:stamp,summary:'Your daily brief for Actual Farm.',items:['Your saved priority is Orchard.','Tomorrow’s high is 66°F.'],weather:{source:{id:'open-meteo',name:'Open-Meteo'},fetchedAt:stamp},locationId:'kirkland',location:'Kirkland, WA'};savedBriefs.set(activeAccount.user.id,saved);reused=false;}
      }
      json(res,200,{brief:saved,date,reused});return;
    }
    if(url.pathname==='/api/weather'){weatherRequests++;json(res,200,weatherFixture());return;}
    if(url.pathname==='/api/field-data'){fieldDataRequests++;json(res,409,{error:'Fixture fields have not consented to external field data'});return;}
    if(url.pathname===managementEndpoint){await serveManagement(req,res,url);return;}
    if(url.pathname==='/api/admin'){legacyAdminRequests++;json(res,404,{error:'Reserved route is not an application endpoint'});return;}
    if(url.pathname==='/.auth/me'){json(res,200,{clientPrincipal:{userId:activeAccount.user.id,userDetails:activeAccount.user.email,identityProvider:'aad',userRoles:['anonymous','authenticated']}});return;}
    const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    try{const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end();}
  }catch(error){json(res,500,{error:error.message});}
});

async function main(){
  const profileDir=await fs.mkdtemp(path.join(os.tmpdir(),'farmer-access-smoke-'));
  let screenshotDirectory;const screenshots={};
  let browser,ws;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/`;
    browser=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','about:blank'],{windowsHide:true,stdio:'ignore'});
    let spawnError,port;
    browser.on('error',error=>{spawnError=error;});
    for(let i=0;i<100;i++){if(spawnError)throw spawnError;try{port=(await fs.readFile(path.join(profileDir,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}await pause(100);}
    assert.ok(port,'Browser debugging port became available');
    const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let sequence=0,allowUndoConfirmation=false,allowSignoutConfirmation=false;const pending=new Map(),errors=[],dialogResponses=[],dialogMessages=[];
    ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const entry=pending.get(data.id);if(entry){pending.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);}}else if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);else if(data.method==='Page.javascriptDialogOpening'){const accepted=data.params.type==='confirm'&&((allowUndoConfirmation&&/undo|pending|remove/i.test(data.params.message))||(allowSignoutConfirmation&&/sign out/i.test(data.params.message)));allowUndoConfirmation=false;allowSignoutConfirmation=false;dialogResponses.push({type:data.params.type,accepted});dialogMessages.push(data.params.message);cdp('Page.handleJavaScriptDialog',{accept:accepted}).catch(error=>errors.push(error.message));}});
    function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${method}`));},12000)});ws.send(JSON.stringify({id,method,params}));});}
    async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
    async function until(expression,label){for(let i=0;i<140;i++){try{if(await evaluate(expression))return;}catch{}await pause(100);}throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate("({body:document.body.innerText.slice(0,1600),ready:document.readyState})"))}`);}
    async function navigate(destination){const previousOrigin=await evaluate('performance.timeOrigin');await cdp('Page.navigate',{url:destination});await until(`document.readyState === "complete" && performance.timeOrigin !== ${previousOrigin}`,'document load');}
    async function mobileFits(label){await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(50);const size=await evaluate('({viewport:innerWidth,width:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)})');assert.ok(size.width<=size.viewport+1,`${label} fits mobile viewport: ${JSON.stringify(size)}`);return size;}
    async function screenshot(name){
      screenshotDirectory||=await fs.mkdtemp(path.join(os.tmpdir(),'farmer-ui-artifacts-'));
      const metrics=await cdp('Page.getLayoutMetrics'),size=metrics.cssContentSize;
      const captured=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:Math.ceil(size.width),height:Math.ceil(size.height),scale:1}});
      const file=path.join(screenshotDirectory,`${name}.png`);await fs.writeFile(file,Buffer.from(captured.data,'base64'));screenshots[name]=file;
    }
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*','http://fonts.*']});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    async function assertEmptyBoot(expectedAccount,label){
      await until(`document.querySelector('#accountGate').hidden && !document.querySelector('#onboarding').classList.contains('hidden')`,label);
      const view=await evaluate(`({profile,taskCount:tasks.length,jobCount:agentJobs.length,fieldCount:JSON.parse(localStorage.getItem('farmerDailyFields')||'[]').length,observationCount:JSON.parse(localStorage.getItem('farmerDailyObservations')||'[]').length,owner:localStorage.getItem('farmerDailyCloudOwner'),storedProfile:localStorage.getItem('farmerDailyProfile'),storedTasks:localStorage.getItem('farmerDailyTasks'),shellInert:document.querySelector('.shell').inert,firstName:document.querySelector('#profileForm').elements.firstName.value,plan:document.body.dataset.membership,adminHidden:document.querySelector('#adminNavLink').hidden})`);
      assert.equal(view.profile,null,`${label}: no former profile survives`);
      assert.equal(view.taskCount,0,`${label}: no former tasks survive`);
      assert.equal(view.jobCount,0,`${label}: no former jobs survive`);
      assert.equal(view.fieldCount,0,`${label}: no former fields survive`);
      assert.equal(view.observationCount,0,`${label}: no former observations or photos survive`);
      assert.equal(view.owner,expectedAccount.user.id);
      assert.equal(view.storedProfile,null);
      assert.equal(view.storedTasks,null);
      assert.equal(view.shellInert,false);
      assert.equal(view.firstName,'');
      assert.equal(view.plan,expectedAccount.plan);
      assert.equal(view.adminHidden,!expectedAccount.isAdmin);
      assert.ok(stateResponses.some(response=>response.userId===expectedAccount.user.id&&response.method==='GET'&&response.status===204),`${label}: the real API declared no saved state`);
      const writeStart=writes.length;
      assert.equal(await evaluate('saveCloudState()'),true,`${label}: sync is available after boot`);
      const ownWrites=writes.slice(writeStart).filter(write=>write.userId===expectedAccount.user.id);
      assert.ok(ownWrites.length>0,`${label}: clean state can be saved`);
      assert.ok(ownWrites.every(write=>write.data.profile===null&&(!write.data.tasks||write.data.tasks.length===0)&&(!write.data.jobs||write.data.jobs.length===0)&&(!write.data.fields||write.data.fields.length===0)&&(!write.data.observations||write.data.observations.length===0)),`${label}: old private records are never uploaded`);
      await evaluate(`document.querySelector('#profileForm').elements.firstName.value='New';document.querySelector('#profileForm').elements.farmName.value='New Farm';document.querySelector('#locationSelect').value='kirkland';document.querySelector('#profileNext').click()`);
      assert.equal(await evaluate('profileStep'),2,`${label}: onboarding is usable`);
    }
    for(const newAccount of [newFreeAccount,newAdminAccount]){
      activeAccount=newAccount;
      const newSeed=await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('farmerDailyCloudOwner','former-account');localStorage.setItem('farmerDailyProfile',${JSON.stringify(JSON.stringify({...baseProfile,firstName:'Former',farmName:'Former Private Farm'}))});localStorage.setItem('farmerDailyTasks','[{"name":"Former private task"}]');localStorage.setItem('farmerDailyJobs','[{"title":"Former private job"}]');`});
      await navigate(url);
      if(newAccount.isAdmin){
        await until(`location.pathname === '/admin.html' && !document.querySelector('#adminContent').hidden`,'first sign-in Admin default portal');
        assert.equal(await evaluate(`document.querySelector('#adminEmail').textContent`),newAccount.user.email);
        assert.equal(stateResponses.filter(response=>response.userId===newAccount.user.id).length,0,'Admin default landing does not read or require a farm profile');
        assert.equal(writes.filter(write=>write.userId===newAccount.user.id).length,0,'Admin default landing does not upload local farm records');
        await navigate(`${url}index.html`);
        await until(`location.pathname === '/admin.html' && !document.querySelector('#adminContent').hidden`,'Admin index.html default portal');
        assert.equal(stateResponses.filter(response=>response.userId===newAccount.user.id).length,0,'Admin index.html landing also bypasses farm onboarding and state API');
      }
      await cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:newSeed.identifier});
      if(newAccount.isAdmin){
        const link=await evaluate(`Array.from(document.querySelectorAll('nav a')).find(link=>link.textContent.trim()==='Back to app').getAttribute('href')`);
        assert.equal(link,'/?view=farmer','Admin can explicitly choose the farmer app');
        await evaluate(`Array.from(document.querySelectorAll('nav a')).find(link=>link.textContent.trim()==='Back to app').click()`);
      }
      await assertEmptyBoot(newAccount,`First sign-in ${newAccount.isAdmin?'Admin farmer-view opt-in':'Free'}`);
      if(newAccount.isAdmin){
        const readsBeforeFarmerReload=adminReads;
        await navigate(`${url}?view=farmer`);
        await until(`document.querySelector('#accountGate').hidden && !document.querySelector('#onboarding').classList.contains('hidden')`,'Admin farmer-view reload');
        assert.equal(await evaluate(`location.pathname + location.search`),'/?view=farmer','Explicit farmer view survives reload without a redirect loop');
        assert.equal(adminReads,readsBeforeFarmerReload,'Farmer view never reopens the admin directory automatically');
      }
    }
    assert.equal(weatherRequests,0,'Accounts without a farm profile do not request location weather');
    activeAccount=freeAccount;
    const seed=await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('farmerDailyCloudOwner','former-account');localStorage.setItem('farmerDailyProfile',${JSON.stringify(JSON.stringify({...baseProfile,firstName:'Wrong',farmName:'Former Private Farm',email:'admin1@example.invalid'}))});localStorage.setItem('farmerDailyTasks','[{"name":"Former private task"}]');`});
    await navigate(url);
    await until('document.querySelector("#accountGate").hidden && document.body.dataset.membership === "free" && document.querySelector("#dailyBriefStatus").textContent.includes("ready")','Free account boot');
    await cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:seed.identifier});
    const freeView=await evaluate(`({email:document.querySelector('#accountEmail').textContent,briefVisible:document.querySelector('#dailyBriefPanel').getBoundingClientRect().height>0,planVisible:document.querySelector('#planPanel').getBoundingClientRect().height>0,weatherVisible:document.querySelector('#weatherSignal').getBoundingClientRect().height>0,chatVisible:document.querySelector('#askFab').getBoundingClientRect().height>0,adminHidden:document.querySelector('#adminNavLink').hidden,profile:profile,owner:localStorage.getItem('farmerDailyCloudOwner')})`);
    assert.equal(await evaluate('location.pathname'),'/','An admin email in local farm records never redirects a server-confirmed nonadmin');
    assert.equal(freeView.email,freeAccount.user.email);assert.equal(freeView.profile.farmName,'Actual Farm');assert.equal(freeView.owner,freeAccount.user.id);assert.equal(freeView.briefVisible,true);assert.equal(freeView.planVisible,false,'Plan management lives in Settings, beneath the short morning brief');assert.equal(freeView.chatVisible,true);assert.equal(freeView.adminHidden,true);
    await until(`document.querySelector('#weatherSourceName').textContent==='Open-Meteo'`,'Free community weather');
    assert.ok(weatherRequests>0,'Free accounts can retrieve core weather');
    await evaluate(`document.querySelector('[data-page="tasks"]').click();document.querySelector('#askFab').click();`);
    assert.equal(await evaluate(`document.querySelector('#tasksPage').classList.contains('active') && document.querySelector('#chatDrawer').classList.contains('open')`),true,'Free accounts can open tasks and Q&A');
    await evaluate(`document.querySelector('#chatDrawer').classList.remove('open');document.querySelector('[data-page="fields"]').click();document.querySelector('#addFieldBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#fieldDialog').dataset.step`),'1','New fields start with name and crop');
    await evaluate(`document.querySelector('#fieldName').value='Free orchard';document.querySelector('#fieldCrop').value='Apples';for(const id of ['fieldName','fieldCrop'])document.getElementById(id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#fieldFlowNext').click()`);
    await until(`document.querySelector('#fieldDialog').dataset.step==='2'`,'Free field advances to location');
    await evaluate(`document.querySelector('#fieldLatitude').value='47.6769';document.querySelector('#fieldLongitude').value='-122.206';for(const id of ['fieldLatitude','fieldLongitude'])document.getElementById(id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#fieldFlowNext').click()`);
    await until(`document.querySelector('#fieldDialog').dataset.step==='3'`,'Free field advances to review');
    assert.equal(await evaluate('FarmerWorkspace.getFields().length'),0,'Review does not save a field');
    await evaluate(`document.querySelector('#fieldDataConsent').checked=false;document.querySelector('#fieldFlowNext').click()`);
    await until(`FarmerWorkspace.getFields().length===1`,'Free creates a located field');
    await until(`!document.querySelector('#fieldDialog').open`,'Free field save completes');
    const freeFieldId=await evaluate(`FarmerWorkspace.getFields()[0].id`);
    await evaluate(`document.querySelector('[data-page="tasks"]').click();document.querySelector('.add-task-copy').click();document.querySelector('#newTaskName').value='Inspect free orchard';document.querySelector('#newTaskDate').value=${JSON.stringify(date)};document.querySelector('#newTaskField').value=${JSON.stringify(freeFieldId)};document.querySelector('#taskForm').requestSubmit()`);
    assert.equal(await evaluate(`tasks.length===1&&tasks[0].fieldId===${JSON.stringify(freeFieldId)}`),true,'Free creates a real field-linked task');
    assert.equal(await evaluate('saveCloudState()'),true,'Free fields and tasks pass the actual state handler');
    assert.equal(farmStates.get(freeAccount.user.id).fields.length,1);
    assert.equal(farmStates.get(freeAccount.user.id).tasks[0].fieldId,freeFieldId);
    await evaluate(`document.querySelector('#addObservationBtn').click();document.querySelector('#createJobBtn').click()`);
    assert.equal(await evaluate(`['#observationBackdrop','#jobBackdrop'].every(selector=>!document.querySelector(selector).classList.contains('open'))`),true,'Free observations and agent work remain approval-gated even with programmatic clicks');
    for(const key of ['observations','jobs','jobEvents'])assert.equal(await evaluate(`memberFetch('/api/state',{method:'PUT',body:JSON.stringify({[${JSON.stringify(key)}]:[]})}).then(()=>200,error=>error.status)`),403,`Real state handler blocks unapproved ${key} independently of UI`);
    await evaluate(`document.querySelector('[data-page="today"]').click()`);
    const freeMobile=await mobileFits('Free plan');
    await evaluate(`document.querySelector('#dailyBriefBtn').click()`);
    await until(`document.querySelector('#dailyBriefSummary').textContent === 'Your daily brief for Actual Farm.' && document.querySelector('#dailyBriefBtn').hidden`,'saved Free brief');
    assert.equal(briefPosts,1);assert.ok(weatherRequests>0);
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && document.querySelector('#dailyBriefSummary').textContent === 'Your daily brief for Actual Farm.'`,'reopened saved brief');
    assert.equal(briefPosts,1,'Reload reopens the saved brief without generating another');
    assert.equal(await evaluate(`FarmerWorkspace.getFields().length===1&&tasks.length===1&&tasks[0].fieldId===${JSON.stringify(freeFieldId)}`),true,'Free fields and tasks persist through reload');
    await evaluate(`document.querySelector('[data-page="settings"]').click();document.querySelector('#premiumReason').value='I would like approved agent workflows.';document.querySelector('#premiumRequestForm').requestSubmit()`);
    await until(`document.querySelector('#premiumRequestForm').hidden && document.querySelector('#premiumRequestStatus').textContent.includes('Request sent')`,'pending Premium request');
    assert.equal(premiumRequests,1);
    assert.ok(writes.filter(write=>write.userId===freeAccount.user.id).every(write=>write.data.profile.farmName==='Actual Farm' && !('observations' in write.data) && !('jobs' in write.data) && !('jobEvents' in write.data)),'Free sync uses its own profile/fields/tasks and excludes Frontier records');
    const readsBefore=adminReads;
    await navigate(`${url}admin.html`);
    await until(`document.querySelector('#accessTitle').textContent === 'Administrator access only'`,'nonadmin denial');
    assert.equal(adminReads,readsBefore,'Nonadmins never request the account directory');
    assert.equal(await evaluate(`document.querySelector('#adminContent').hidden`),true);
    assert.equal(await evaluate(`fetch(${JSON.stringify(managementEndpoint)},{credentials:'same-origin'}).then(response=>response.status)`),403,'The real management handler rejects direct nonadmin requests independently of the UI');

    activeAccount=otherAccount;
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && document.querySelector('#accountEmail').textContent === 'other-farmer@example.com'`,'account switch');
    await until(`document.querySelector('#syncLabel').textContent === 'Protected in Azure'`,'new account sync');
    assert.equal(await evaluate('profile.farmName'),'Other Farm');
    assert.ok(writes.some(write=>write.userId===otherAccount.user.id),'New account saves its own profile');
    assert.ok(writes.filter(write=>write.userId===otherAccount.user.id).every(write=>write.data.profile.farmName==='Other Farm'),'Previous farmer records are never uploaded into another account');

    activeAccount=adminAccount;
    const adminStateReadsBefore=stateResponses.filter(response=>response.userId===adminAccount.user.id).length;
    await navigate(url);
    await until(`!document.querySelector('#adminContent').hidden && document.querySelector('#pendingCount').textContent === '2'`,'admin directory');
    assert.equal(await evaluate('location.pathname'),'/admin.html','Returning admins also land in the portal');
    assert.equal(stateResponses.filter(response=>response.userId===adminAccount.user.id).length,adminStateReadsBefore,'Returning admin default landing does not load farm state');
    assert.equal(await evaluate(`document.querySelector('#adminEmail').textContent`),adminAccount.user.email);
    const adminMobile=await mobileFits('Admin directory');
    await evaluate(`Array.from(document.querySelectorAll('.request-row')).find(row=>row.textContent.includes('actual-farmer@example.com')).querySelector('button').click()`);
    await until(`document.querySelector('#pendingCount').textContent === '1' && document.querySelector('#adminMessage').textContent.includes('approved')`,'request approval');
    await evaluate(`Array.from(document.querySelectorAll('.request-row')).find(row=>row.textContent.includes('second-farmer@example.com')).querySelectorAll('button')[1].click()`);
    await until(`document.querySelector('#pendingCount').textContent === '0' && document.querySelector('#adminMessage').textContent.includes('declined')`,'request decline');
    assert.deepEqual(decisions.map(decision=>decision.action),['approve','decline']);
    assert.equal(await evaluate(`document.querySelector('#userRows').textContent.includes('Approved') && document.querySelector('#userRows').textContent.includes('Declined') && document.querySelector('#userRows').textContent.includes(${JSON.stringify(adminAccount.user.email)})`),true);
    assert.ok(adminReads>=3,'Decisions refresh server directory');
    for(const [userId,expectedStatus,expectedPlan] of [[freeAccount.user.id,'approved','premium'],['second-request','declined','free']]){
      const saved=accountDocuments.get(userId);
      assert.equal(saved.plan,expectedPlan,'The real handler persists the plan decision');
      assert.equal(saved.request.status,expectedStatus);
      assert.equal(saved.requestHistory.length,1,'The real handler persists one decision audit event');
      assert.equal(saved.requestHistory[0].decidedByUserId,adminAccount.user.id);
      assert.equal(saved.requestHistory[0].decidedBy,adminAccount.user.email);
    }
    assert.deepEqual(managementResponses.filter(response=>response.method==='POST').map(response=>response.status),[200,200]);
    assert.doesNotMatch(JSON.stringify(managementResponses),/PRIVATE-FARM-|"profile":|"state":|"address":|"phone":|"requestHistory":/,'Management API never returns private farm fields or internal audit history');

    activeAccount=premiumAccount;
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && document.body.dataset.membership === 'premium' && document.querySelector('#weatherSourceName').textContent === 'Open-Meteo'`,'Premium weather');
    assert.equal(await evaluate('location.pathname'),'/','Premium approval without server admin status does not redirect to the portal');
    assert.ok(weatherRequests>0);assert.equal(await evaluate(`document.querySelector('#tomorrowHigh').textContent`),'66°F');
    assert.equal(await evaluate(`document.querySelector('#askFab').getBoundingClientRect().height>0`),true);
    await evaluate(`document.querySelector('[data-page="tasks"]').click()`);
    assert.equal(await evaluate(`document.querySelector('#tasksPage').classList.contains('active')`),true);
    await evaluate(`document.querySelector('[data-page="today"]').click()`);
    const premiumMobile=await mobileFits('Premium dashboard');
    await evaluate(`document.querySelector('[data-page="fields"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#fieldGrid .real-field').length`),0,'A new farm has no fabricated field cards');
    assert.equal(await evaluate(`FarmerWorkspace.getFields().length`),0);
    const fieldName='North <img src=x onerror=window.__notebookXss=1>';
    const observationNote='Standing water near gate <img src=x onerror=window.__notebookXss=1>';
    for(const [name,crop,acres] of [[fieldName,'Apples','4.5'],['South meadow','Hay','8']]){
      await evaluate(`document.querySelector('#addFieldBtn').click();document.querySelector('#fieldName').value=${JSON.stringify(name)};document.querySelector('#fieldCrop').value=${JSON.stringify(crop)};for(const id of ['fieldName','fieldCrop'])document.getElementById(id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#fieldFlowNext').click()`);
      await until(`document.querySelector('#fieldDialog').dataset.step==='2'`,'Notebook field location step');
      await evaluate(`document.querySelector('#fieldLatitude').value='47.6769';document.querySelector('#fieldLongitude').value='-122.206';for(const id of ['fieldLatitude','fieldLongitude'])document.getElementById(id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#fieldFlowNext').click()`);
      await until(`document.querySelector('#fieldDialog').dataset.step==='3'`,'Notebook field review step');
      await evaluate(`document.querySelector('#fieldStage').value='Vegetative';document.querySelector('#fieldAcres').value=${JSON.stringify(acres)};document.querySelector('#fieldDataConsent').checked=false;document.querySelector('#fieldFlowNext').click()`);
      await until(`!document.querySelector('#fieldDialog').open`,'Notebook field save completes');
      await until(`FarmerWorkspace.getFields().some(field=>field.name===${JSON.stringify(name)})`,'saved real field');
    }
    assert.equal(await evaluate(`FarmerWorkspace.getFields().length`),2);
    assert.equal(await evaluate(`document.querySelectorAll('#fieldGrid .real-field').length`),2);
    assert.equal(await evaluate(`document.querySelector('#fieldGrid').textContent.includes(${JSON.stringify(fieldName)}) && !document.querySelector('#fieldGrid img') && !window.__notebookXss`),true,'Field names are displayed as text, never executed as HTML');
    const fieldId=await evaluate(`FarmerWorkspace.getFields()[0].id`);
    await evaluate(`document.querySelector('#addObservationBtn').click();document.querySelector('#observationField').value=${JSON.stringify(fieldId)};document.querySelector('#observationText').value=${JSON.stringify(observationNote)}`);
    await evaluate(`new Promise(resolve=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=30;const context=canvas.getContext('2d');context.fillStyle='#517b31';context.fillRect(0,0,40,30);canvas.toBlob(blob=>{const files=new DataTransfer();files.items.add(new File([blob],'field-photo.jpg',{type:'image/jpeg'}));const input=document.querySelector('#observationPhoto');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));resolve(true)},'image/jpeg',0.9)})`);
    await evaluate(`document.querySelector('#observationForm').requestSubmit()`);
    await until(`FarmerWorkspace.getObservations().length===1 && (FarmerWorkspace.getObservations()[0].photo||'').startsWith('data:image/jpeg;base64,') && document.querySelector('#observationList .observation-card img')`,'saved observation with a retained JPEG and image element');
    // Notebook photos deliberately use loading=lazy. The field map and cards can
    // place them beyond Chrome's preload distance on a narrow viewport. Exercise
    // the normal user path instead of requiring an off-screen image to decode.
    await evaluate(`document.querySelector('#observationList .observation-card img').scrollIntoView({block:'center',behavior:'instant'})`);
    await until(`document.querySelector('#observationList .observation-card img')?.naturalWidth>0`,'saved JPEG decodes when scrolled into view');
    const savedPhoto=await evaluate(`FarmerWorkspace.getObservations()[0].photo`);
    assert.match(savedPhoto,/^data:image\/jpeg;base64,/);
    assert.ok(Buffer.byteLength(savedPhoto)<=80*1024,'Private photo respects the API size limit');
    assert.equal(await evaluate(`document.querySelector('#observationList').textContent.includes(${JSON.stringify(observationNote)}) && document.querySelectorAll('#observationList img').length===1 && !window.__notebookXss`),true,'Observation text remains text beside the real photo');
    await evaluate(`document.querySelector('#addObservationBtn').click();document.querySelector('#observationField').value=${JSON.stringify(fieldId)};document.querySelector('#observationText').value='Cancelled photo must never be saved';window.smokeNativeDecode=Image.prototype.decode;Image.prototype.decode=function(){return window.smokeNativeDecode.call(this).then(()=>new Promise(resolve=>{window.smokeReleasePhoto=resolve}))};{const files=new DataTransfer();files.items.add(new File([Uint8Array.from(atob(${JSON.stringify(savedPhoto)}.split(',')[1]),character=>character.charCodeAt(0))],'cancelled-photo.jpg',{type:'image/jpeg'}));document.querySelector('#observationPhoto').files=files.files;}document.querySelector('#observationForm').requestSubmit()`);
    await until(`typeof window.smokeReleasePhoto==='function'`,'photo processing is delayed');
    await evaluate(`document.querySelector('#cancelObservation').click();Image.prototype.decode=window.smokeNativeDecode;window.smokeReleasePhoto()`);
    await until(`!document.querySelector('#saveObservationBtn').disabled`,'cancelled photo processing settles');
    assert.equal(await evaluate(`FarmerWorkspace.getObservations().length`),1,'Cancelling a photo before decoding completes never saves its observation');
    assert.equal(await evaluate(`document.querySelector('#observationBackdrop').classList.contains('open')`),false,'Cancelled photo editor stays closed');
    assert.ok(!writes.some(write=>JSON.stringify(write.data).includes('Cancelled photo must never be saved')),'Cancelled private photo work is never uploaded');
    const notebookMobile=await mobileFits('Field notebook with photo and long user text');
    await screenshot('notebook-mobile-390');
    const tasksBeforeFollowup=await evaluate('tasks.length');
    await evaluate(`window.smokeFollowup=document.querySelector('.observation-followup');window.smokeFollowup.click();window.smokeFollowup.click()`);
    assert.equal(await evaluate('tasks.length'),tasksBeforeFollowup+1,'Repeated observation follow-up creates only one task');
    const followupBeforeEdit=await evaluate(`tasks.find(task=>task.observationId)`);
    assert.equal(followupBeforeEdit.time,'','Observation follow-up initially has no invented schedule');
    await evaluate(`document.querySelector('[data-page="tasks"]').click();Array.from(document.querySelectorAll('#allTaskList .task-row')).find(row=>row.dataset.id===${JSON.stringify(String(followupBeforeEdit.id))}).querySelector('.task-edit').click();document.querySelector('#newTaskDate').value=${JSON.stringify(date)};document.querySelector('#newTaskTime').value='09:30';document.querySelector('#taskForm').requestSubmit()`);
    const followupAfterEdit=await evaluate(`tasks.find(task=>task.id===${JSON.stringify(followupBeforeEdit.id)})`);
    assert.equal(followupAfterEdit.time,'09:30','Farmer can explicitly schedule an unscheduled follow-up');
    assert.equal(followupAfterEdit.date,date);
    for(const property of ['id','observationId','fieldId','createdAt','done','completedAt'])assert.deepEqual(followupAfterEdit[property],followupBeforeEdit[property],`Task edit preserves ${property} provenance`);
    assert.equal(await evaluate('tasks.length'),tasksBeforeFollowup+1,'Editing changes the existing task rather than creating a duplicate');
    assert.equal(await evaluate('saveCloudState()'),true,'Fields and photo pass the real state PUT validation');
    assert.equal(farmStates.get(premiumAccount.user.id).fields.length,2);
    assert.equal(farmStates.get(premiumAccount.user.id).observations[0].photo,savedPhoto);
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && FarmerWorkspace.getFields().length===2 && FarmerWorkspace.getObservations().length===1`,'field and photo reload persistence');
    await evaluate(`document.querySelector('[data-page="fields"]').click()`);
    await until(`document.querySelector('#observationList .observation-card img')`,'saved image element after reload');
    await evaluate(`document.querySelector('#focusedObservations > summary').click()`);
    assert.equal(await evaluate(`document.querySelector('#focusedObservations').open`),true,'Saved observations open on the first click after reload');
    await evaluate(`document.querySelector('#observationList .observation-card img').scrollIntoView({block:'center',behavior:'instant'})`);
    await until(`document.querySelector('#observationList .observation-card img')?.naturalWidth>0`,'photo rendered after reload');
    assert.equal(await evaluate(`FarmerWorkspace.getObservations()[0].photo`),savedPhoto);
    assert.equal(await evaluate(`window.__notebookXss || null`),null);

    await until(`document.querySelector('#weatherSourceName').textContent==='Open-Meteo'`,'current forecast ready for work planning');
    const jobsBeforeCancel=await evaluate('agentJobs.length');
    await evaluate(`document.querySelector('[data-page="jobs"]').click();document.querySelector('#createJobBtn').click();window.smokeNativeDigest=crypto.subtle.digest;crypto.subtle.digest=function(...args){return window.smokeNativeDigest.apply(this,args).then(value=>new Promise(resolve=>{window.smokeReleaseDigest=()=>resolve(value)}))};document.querySelector('#jobForm').requestSubmit()`);
    await until(`typeof window.smokeReleaseDigest==='function'`,'preview preparation is delayed');
    await evaluate(`document.querySelector('#cancelJobModal').click();crypto.subtle.digest=window.smokeNativeDigest;window.smokeReleaseDigest()`);
    await until(`!document.querySelector('#prepareJobBtn').disabled`,'cancelled preview settles');
    assert.equal(await evaluate('agentJobs.length'),jobsBeforeCancel,'Cancelling asynchronous preparation never saves a preview');
    await evaluate(`document.querySelector('[data-page="jobs"]').click();document.querySelector('#createJobBtn').click();document.querySelector('#jobType').value='plan';document.querySelector('#jobDate').value=${JSON.stringify(new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10))};document.querySelector('#jobField').value='';document.querySelector('#jobInstructions').value='Review both real fields and the saved gate observation.'`);
    const taskIdsBeforePlan=await evaluate('tasks.map(task=>task.id)');
    await evaluate(`document.querySelector('#jobForm').requestSubmit()`);
    await until(`document.querySelector('#jobList .job-approve')`,'weather-aware work-plan preview');
    assert.deepEqual(await evaluate('tasks.map(task=>task.id)'),taskIdsBeforePlan,'Preparing a plan has no task side effects before approval');
    assert.equal(await evaluate(`document.querySelector('#jobList').textContent.includes('Open-Meteo') && document.querySelector('#jobList').textContent.includes('South meadow') && !window.__notebookXss`),true,'Plan preview cites the forecast and real fields safely');
    const planMobile=await mobileFits('Work-plan preview');
    await screenshot('work-plan-mobile-390');
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await pause(50);
    await screenshot('work-plan-desktop-1280');
    assert.match(await evaluate('agentJobs[0].contextKey'),/^[a-f0-9]{64}$/,'Saved preview holds a context fingerprint rather than another copy of private notes');
    await evaluate(`window.smokeForecast=structuredClone(liveForecast);{const target=liveForecast.hourly.find(hour=>pacificDate(hour.startTime)===agentJobs[0].plan.forDate);target.probabilityOfPrecipitation={value:95};}FarmerWorkspace.approveJob(agentJobs[0].id)`);
    assert.deepEqual(await evaluate('tasks.map(task=>task.id)'),taskIdsBeforePlan,'A changed forecast cannot create tasks from an outdated preview');
    assert.match(await evaluate(`document.querySelector('#plannerMessage').textContent`),/forecast changed/i);
    assert.equal(await evaluate('agentJobs[0].status'),'prepared','Rejected approval leaves the preview unapproved');
    await evaluate(`liveForecast=window.smokeForecast`);
    await evaluate(`window.smokeApprove=document.querySelector('#jobList .job-approve');window.smokeApprove.click();window.smokeApprove.click()`);
    await until(`agentJobs[0].status==='applied'`,'asynchronous approval commits once');
    const approvedTasks=await evaluate(`tasks.filter(task=>!${JSON.stringify(taskIdsBeforePlan)}.includes(task.id))`);
    assert.equal(approvedTasks.length,2,'Approving the two-field plan twice creates exactly two reviewed tasks');
    assert.equal(new Set(approvedTasks.map(task=>task.id)).size,2);
    assert.ok(approvedTasks.every(task=>/^\d{2}:\d{2}$/.test(task.time)&&Number(task.time.slice(0,2))>=8&&Number(task.time.slice(0,2))<17),'Plan schedules only daytime Pacific slots from the forecast fixture');
    const approvedWorkSnapshot=await evaluate('({jobs:agentJobs,tasks})');
    await evaluate(`document.querySelector('#createJobBtn').click();document.querySelector('#jobType').value='plan';document.querySelector('#jobField').value='';document.querySelector('#jobDate').value=${JSON.stringify(approvedTasks[0].date)};document.querySelector('#jobForm').requestSubmit()`);
    await until(`/inspections already exist/i.test(document.querySelector('#jobError').textContent) && !document.querySelector('#prepareJobBtn').disabled`,'duplicate inspection plan is rejected');
    assert.deepEqual(await evaluate('({jobs:agentJobs,tasks})'),approvedWorkSnapshot,'Preparing the same fields and date again creates no extra job or inspection task');
    await evaluate(`document.querySelector('#cancelJobModal').click()`);
    await evaluate(`document.querySelector('[data-page="tasks"]').click();Array.from(document.querySelectorAll('#allTaskList .task-row')).find(row=>row.dataset.id===${JSON.stringify(String(approvedTasks[0].id))}).querySelector('input[type="checkbox"]').click()`);
    const completedTask=await evaluate(`tasks.find(task=>task.id===${JSON.stringify(approvedTasks[0].id)})`);
    assert.equal(completedTask.done,true);
    assert.ok(Number.isFinite(Date.parse(completedTask.completedAt)),'Task completion records a real timestamp');
    await evaluate(`Array.from(document.querySelectorAll('#allTaskList .task-row')).find(row=>row.dataset.id===${JSON.stringify(String(completedTask.id))}).querySelector('.task-edit').click();document.querySelector('#newTaskName').value=${JSON.stringify(completedTask.name+' (reviewed)')};document.querySelector('#taskForm').requestSubmit()`);
    const completedAfterEdit=await evaluate(`tasks.find(task=>task.id===${JSON.stringify(completedTask.id)})`);
    for(const property of ['id','jobId','planItemId','createdAt','done','completedAt'])assert.deepEqual(completedAfterEdit[property],completedTask[property],`Editing completed work preserves ${property}`);
    await evaluate(`document.querySelector('[data-page="jobs"]').click()`);
    assert.match(await evaluate(`document.querySelector('#jobList .job-progress').textContent`),/1 of 2 completed/,'Job summary reflects actual completed tasks');
    allowUndoConfirmation=true;
    await evaluate(`document.querySelector('#jobList .job-undo').click()`);
    assert.deepEqual(dialogResponses,[{type:'confirm',accepted:true}],'Undo asks for confirmation before removing pending tasks');
    assert.equal(await evaluate(`tasks.some(task=>task.id===${JSON.stringify(approvedTasks[0].id)}&&task.done)`),true,'Undo preserves completed work');
    assert.equal(await evaluate(`tasks.some(task=>task.id===${JSON.stringify(approvedTasks[1].id)})`),false,'Undo removes only pending tasks created by that plan');
    assert.ok((await evaluate('tasks.map(task=>task.id)')).includes(taskIdsBeforePlan[0]),'Undo preserves unrelated observation follow-up');
    await evaluate(`document.querySelector('[data-page="insights"]').click()`);
    assert.match(await evaluate(`document.querySelector('#recordInsights').textContent`),/1 tasks? marked complete by you/i,'Insights shows the actual completed count from saved records');
    assert.equal(await evaluate('saveCloudState()'),true);

    const ownRecoveryKey=`farmerDailyDeviceBackup:${premiumAccount.user.id}`,otherRecoveryKey=`farmerDailyDeviceBackup:${otherAccount.user.id}`;
    const ownRecovery={note:'Own recovery copy marker'},otherRecovery={note:'OTHER-ACCOUNT-RECOVERY-MUST-STAY-PRIVATE'};
    await evaluate(`localStorage.setItem(${JSON.stringify(ownRecoveryKey)},${JSON.stringify(JSON.stringify(ownRecovery))});localStorage.setItem(${JSON.stringify(otherRecoveryKey)},${JSON.stringify(JSON.stringify(otherRecovery))})`);
    cloudOffline=true;
    await evaluate(`window.smokeOriginalNotes=localStorage.getItem('farmerDailyObservations');document.querySelector('[data-page="fields"]').click();document.querySelector('#addObservationBtn').click();document.querySelector('#observationText').value='Unsynced local-only export note';document.querySelector('#observationForm').requestSubmit()`);
    await until(`FarmerWorkspace.getObservations().length===2`,'unsynced local observation');
    assert.equal(await evaluate('saveCloudState()'),false,'The fixture cloud outage leaves the new note unsynced');
    const dialogsBeforeCancelledSignout=dialogResponses.length;
    await evaluate(`document.querySelector('a[href="/.auth/logout"]').click()`);
    await until(`!signingOut`,'cancelled unsynced sign-out settles');
    assert.equal(dialogResponses.length,dialogsBeforeCancelledSignout+1,'Unsynced sign-out warns before clearing device records');
    assert.deepEqual(dialogResponses.at(-1),{type:'confirm',accepted:false});
    assert.match(dialogMessages.at(-1),/not be saved to Azure/i);
    assert.equal(logoutRequests,0,'Cancelling the warning does not navigate to logout');
    assert.equal(await evaluate(`FarmerWorkspace.getObservations().length`),2,'Cancelling unsynced sign-out retains local-only notes');
    assert.equal(await evaluate(`FarmerWorkspace.getObservations().find(note=>note.photo)?.photo`),savedPhoto,'Cancelling unsynced sign-out retains the private JPEG');
    assert.equal(await evaluate(`localStorage.getItem('farmerDailyCloudOwner')`),premiumAccount.user.id);
    assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(ownRecoveryKey)})`),JSON.stringify(ownRecovery),'Cancelled sign-out preserves its recovery copy');
    await evaluate(`window.smokeNativeObjectURL=URL.createObjectURL;window.smokeNativeAnchorClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(blob){if(blob.type==='application/json')window.smokeExportText=blob.text();return window.smokeNativeObjectURL.call(this,blob)};HTMLAnchorElement.prototype.click=function(){if(this.download==='farmer-daily-data.json'){window.smokeExportFilename=this.download;return;}return window.smokeNativeAnchorClick.call(this)};document.querySelector('#exportDataBtn').onclick()`);
    const offlineExport=JSON.parse(await evaluate('window.smokeExportText'));
    assert.equal(offlineExport.cloudAvailable,false);
    assert.equal(offlineExport.farmData,null);
    assert.equal(offlineExport.localFarmData.observations.length,2,'Offline export includes unsynchronized device records');
    assert.ok(offlineExport.localFarmData.observations.some(note=>note.note==='Unsynced local-only export note'));
    assert.ok(offlineExport.localFarmData.observations.some(note=>note.photo===savedPhoto),'Offline export preserves the private photo');
    assert.equal(offlineExport.account.user.id,premiumAccount.user.id);
    assert.deepEqual(offlineExport.deviceRecoveryCopy,ownRecovery,'Export includes this account\'s recovery copy');
    assert.ok(!JSON.stringify(offlineExport).includes(otherRecovery.note),'Export excludes another account\'s device recovery copy');
    assert.equal(await evaluate('window.smokeExportFilename'),'farmer-daily-data.json');
    assert.equal(farmStates.get(premiumAccount.user.id).observations.length,1,'Cloud snapshot remains older while offline');
    await evaluate(`URL.createObjectURL=window.smokeNativeObjectURL;HTMLAnchorElement.prototype.click=window.smokeNativeAnchorClick;localStorage.setItem('farmerDailyObservations',window.smokeOriginalNotes);FarmerWorkspace.render()`);
    cloudOffline=false;
    assert.equal(await evaluate('saveCloudState()'),true);

    activeAccount=otherAccount;
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && document.querySelector('#accountEmail').textContent===${JSON.stringify(otherAccount.user.email)}`,'switch away from private notebook');
    assert.equal(await evaluate(`FarmerWorkspace.getFields().length + FarmerWorkspace.getObservations().length`),0,'Another account cannot read the prior farmer notebook or photo');
    assert.equal(await evaluate('saveCloudState()'),true);
    assert.ok(!JSON.stringify(farmStates.get(otherAccount.user.id)).includes(savedPhoto),'Another account never receives the private photo in cloud state');
    activeAccount=premiumAccount;
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && FarmerWorkspace.getFields().length===2 && FarmerWorkspace.getObservations().length===1`,'restore private notebook from real state GET after account switch');
    assert.equal(await evaluate(`FarmerWorkspace.getObservations()[0].photo`),savedPhoto,'The owner recovers the same private JPEG from cloud state');
    assert.equal(await evaluate('saveCloudState()'),true);
    await evaluate(`localStorage.setItem(${JSON.stringify(ownRecoveryKey)},${JSON.stringify(JSON.stringify(ownRecovery))});localStorage.setItem(${JSON.stringify(otherRecoveryKey)},${JSON.stringify(JSON.stringify(otherRecovery))});localStorage.setItem('smokeUnrelatedPreference','keep-me')`);
    const clearedKeys=await evaluate(`Object.values(farmStorageKeys).concat(['farmerDailyForecastCacheV2','farmerDailyRemoteUpdatedAt','farmerDailyCloudOwner',${JSON.stringify(ownRecoveryKey)}])`);
    allowSignoutConfirmation=true;
    await evaluate(`document.querySelector('a[href="/.auth/logout"]').click();document.querySelector('a[href="/.auth/logout"]').click()`);
    await until(`location.pathname==='/.auth/logout' && document.querySelector('#fixtureSignedOut')`,'confirmed sign-out clears account before navigating');
    assert.equal(logoutRequests,1,'Double-clicking sign-out navigates only once');
    assert.deepEqual(dialogResponses.at(-1),{type:'confirm',accepted:true});
    assert.match(dialogMessages.at(-1),/older recovery copy/i,'Synced sign-out still asks before removing a recovery copy');
    assert.equal(await evaluate(`${JSON.stringify(clearedKeys)}.every(key=>localStorage.getItem(key)===null)`),true,'Confirmed sign-out clears own active records, JPEG, cached forecast, revision, owner, and recovery copy');
    assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(otherRecoveryKey)})`),JSON.stringify(otherRecovery),'Sign-out does not erase another account\'s recovery copy');
    assert.equal(await evaluate(`localStorage.getItem('smokeUnrelatedPreference')`),'keep-me','Sign-out does not clear unrelated device preferences');
    assert.equal(farmStates.get(premiumAccount.user.id).observations[0].photo,savedPhoto,'Sign-out retains saved cloud records');
    await navigate(url);
    await until(`document.querySelector('#accountGate').hidden && FarmerWorkspace.getFields().length===2 && FarmerWorkspace.getObservations().length===1`,'signed-in owner restores private records after device cleanup');
    // Keep this device's old profile/tasks while deleting the cloud state. This
    // models another device deleting farm data, then this device signing in.
    await evaluate(`localStorage.setItem('farmerDailyTasks','[{"name":"Deleted private task"}]');memberFetch('/api/state',{method:'DELETE'})`);
    assert.equal(stateDeletes,1);
    assert.equal(farmStates.has(premiumAccount.user.id),false);
    await navigate(url);
    await assertEmptyBoot(premiumAccount,'Post-deletion sign-in');
    assert.equal(legacyAdminRequests,0,'Browser never requests the Azure-reserved /api/admin route');
    assert.equal(fieldDataRequests,0,'Fields with coordinate sharing disabled never request external field intelligence');
    assert.deepEqual(errors,[],'No uncaught browser JavaScript errors');
    console.log(JSON.stringify({passed:true,checks:['first-sign-in Free onboarding','first-sign-in Admin root/index redirect','Admin portal without farm-state API','Admin farmer-view opt-in and reload','returning Admin auto redirect','real missing-state API response','real state GET/PUT/DELETE handlers','no stale private-data upload','post-deletion sign-in','Free daily brief and plan management in Settings','Free weather and Q&A access','Free located field and linked task create/sync/reload','unconsented fields never query field data','Frontier observations and jobs UI/API gates','server identity only for Admin routing','saved brief reuse','Frontier request','nonadmin directory denial','real management handler rejects nonadmins','account storage isolation','real management approve/decline and audit','management response excludes private farm data','deployed management route contract; no reserved admin requests','approved live weather','real fields without fabricated records','JPEG observation persistence and XSS safety','cancelled in-flight photo never saved','idempotent observation follow-up','task editing preserves ID and completion provenance','cancelled asynchronous preview never saved','forecast-derived preview without side effects','changed forecast blocks approval','idempotent asynchronous plan approval','repeat inspection plans do not duplicate jobs or tasks','completion timestamp and progress','undo preserves completed and unrelated tasks','offline export includes unsynced note, JPEG, and own recovery only','cancelled unsynced sign-out preserves records','confirmed sign-out clears only own device records','notebook/photo account isolation and deletion','mobile layouts'],managementEndpoint,legacyAdminRequests,logoutRequests,freeMobile,adminMobile,premiumMobile,notebookMobile,planMobile,briefPosts,premiumRequests,adminReads,weatherRequests,fieldDataRequests,stateDeletes,screenshots,errors},null,2));
    ws.close();ws=null;
  }finally{
    ws?.close();if(browser?.pid)browser.kill();await new Promise(resolve=>server.close(resolve));await pause(500);
    const resolved=path.resolve(profileDir),expectedParent=path.resolve(os.tmpdir());
    if(path.dirname(resolved)===expectedParent && path.basename(resolved).startsWith('farmer-access-smoke-'))await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
