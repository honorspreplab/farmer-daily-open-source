// Native browser DOM/storage with the actual reading handlers extracted from app.js.
// Only save outcomes and account fixtures are injected; no production accounts or
// external providers are accessed, and the rest of the app is not duplicated here.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixture=`<!doctype html><html><head><meta charset="UTF-8"><title>Reading preference failure fixture</title></head><body><label><input id="readingHelperEnabled" type="checkbox">Reading helper</label><select id="readingTextSize"><option value="comfortable">Comfortable</option><option value="large">Large</option></select><p id="readingHelperStatus" role="status"></p><button id="readingListenBrief">Listen</button><script src="/fixture.js"></script><script src="/reading-handlers.js"></script></body></html>`;
const bootstrap=`window.$=selector=>document.querySelector(selector);window.membership={user:{id:'reading-fixture-owner'},plan:'free'};window.cloudEnabled=true;window.requireCore=()=>!!membership?.user?.id;window.saveCalls=0;window.saveBehavior=async()=>true;window.saveCloudState=async()=>{saveCalls++;return saveBehavior();};window.openPage=()=>{};window.unhandledErrors=[];window.addEventListener('unhandledrejection',event=>unhandledErrors.push(String(event.reason)));window.originalSetItem=Storage.prototype.setItem;localStorage.setItem('farmerDailyCloudOwner','reading-fixture-owner');localStorage.setItem('farmerDailyReadingPreferences',JSON.stringify({enabled:false,textSize:'comfortable'}));`;
let handlerSource,productionHeaders;
const server=http.createServer((req,res)=>{
  for(const [name,value]of Object.entries(productionHeaders))res.setHeader(name,value);
  const pathname=new URL(req.url,'http://localhost').pathname;
  const body=pathname==='/'?fixture:pathname==='/fixture.js'?bootstrap:pathname==='/reading-handlers.js'?handlerSource:null;
  res.writeHead(body===null?404:200,{'Content-Type':pathname==='/'?'text/html; charset=utf-8':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(body||'');
});

(async()=>{
  const source=await fs.readFile(path.join(root,'app.js'),'utf8'),start=source.indexOf('// A presentation preference, never a diagnosis'),end=source.indexOf('// Contact settings are appended',start);
  assert.ok(start>=0&&end>start,'Extract the actual reading preference handlers by their module boundaries');handlerSource=source.slice(start,end);
  productionHeaders=JSON.parse(await fs.readFile(path.join(root,'staticwebapp.config.json'),'utf8')).globalHeaders;
  const profileDir=await fs.mkdtemp(path.join(os.tmpdir(),'farmer-reading-failures-'));let browser,ws;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    browser=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','about:blank'],{windowsHide:true,stdio:'ignore'});
    let port,spawnError;browser.on('error',error=>{spawnError=error;});for(let i=0;i<100;i++){if(spawnError)throw spawnError;try{port=(await fs.readFile(path.join(profileDir,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}await pause(100);}assert.ok(port,'Chrome debugging port available');
    const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let sequence=0;const pending=new Map(),errors=[],checks=[];
    function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out ${method}`));},15000)});ws.send(JSON.stringify({id,method,params}));});}
    ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const entry=pending.get(data.id);if(entry){pending.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);}}else if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);});
    async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
    async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(50);}throw new Error(`Timed out ${expression}`);}
    async function reset(){await evaluate("Storage.prototype.setItem=originalSetItem;membership={user:{id:'reading-fixture-owner'},plan:'free'};cloudEnabled=true;saveCalls=0;saveBehavior=async()=>true;readingPreferenceRevision++;localStorage.setItem('farmerDailyCloudOwner',membership.user.id);localStorage.setItem('farmerDailyReadingPreferences',JSON.stringify({enabled:false,textSize:'comfortable'}));applyReadingPreferences()");}
    async function snapshot(){return evaluate("({stored:JSON.parse(localStorage.getItem('farmerDailyReadingPreferences')),enabled:document.querySelector('#readingHelperEnabled').checked,size:document.querySelector('#readingTextSize').value,disabled:document.querySelector('#readingTextSize').disabled,applied:document.body.dataset.readingHelper,status:document.querySelector('#readingHelperStatus').textContent,calls:saveCalls})");}
    const choose="document.querySelector('#readingHelperEnabled').checked=true;document.querySelector('#readingTextSize').value='large';";
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*']});await cdp('Page.navigate',{url:base+'/'});await until("typeof changeReadingPreferences==='function'&&document.readyState==='complete'");

    await reset();await evaluate(`cloudEnabled=false;${choose}changeReadingPreferences()`);let result=await snapshot();
    assert.deepEqual(result.stored,{enabled:false,textSize:'comfortable'});assert.equal(result.enabled,false);assert.equal(result.calls,0);assert.match(result.status,/Reconnect/);checks.push('cloud-disabled change does not write and restores controls');

    await reset();await evaluate(`localStorage.setItem('farmerDailyCloudOwner','different-owner');${choose}changeReadingPreferences()`);result=await snapshot();
    assert.deepEqual(result.stored,{enabled:false,textSize:'comfortable'});assert.equal(result.enabled,false);assert.equal(result.calls,0);assert.match(result.status,/Reconnect/);checks.push('stale owner is rejected before the local write');

    await reset();await evaluate(`Storage.prototype.setItem=function(key,value){if(key==='farmerDailyReadingPreferences')throw new DOMException('Fixture quota exceeded','QuotaExceededError');return originalSetItem.call(this,key,value);};${choose}changeReadingPreferences()`);result=await snapshot();
    assert.deepEqual(result.stored,{enabled:false,textSize:'comfortable'});assert.equal(result.enabled,false);assert.equal(result.size,'comfortable');assert.equal(result.disabled,true);assert.equal(result.applied,'false');assert.equal(result.calls,0);assert.match(result.status,/could not be saved.*browser storage/i);checks.push('quota failure retains original preference and reports not saved');

    for(const outcome of ['throw','false']){
      await reset();await evaluate(`saveBehavior=async()=>{${outcome==='throw'?'throw new Error("Fixture save failure")':'return false'}};${choose}changeReadingPreferences()`);result=await snapshot();
      assert.deepEqual(result.stored,{enabled:true,textSize:'large'});assert.equal(result.enabled,true);assert.equal(result.applied,'true');assert.equal(result.calls,1);assert.match(result.status,/Saved on this device only.*sync is paused/i);assert.doesNotMatch(result.status,/saved to your private account/i);checks.push(`${outcome} save outcome keeps device preference with honest feedback`);
    }

    await reset();await evaluate(`${choose}changeReadingPreferences()`);result=await snapshot();assert.deepEqual(result.stored,{enabled:true,textSize:'large'});assert.match(result.status,/saved to your private account/i);checks.push('successful save confirms private-account persistence');

    await reset();await evaluate(`saveBehavior=()=>new Promise(resolve=>window.resolveEarlier=resolve);${choose}window.earlier=changeReadingPreferences();undefined`);await until("typeof resolveEarlier==='function'");
    await evaluate("saveBehavior=async()=>true;document.querySelector('#readingHelperEnabled').checked=false;document.querySelector('#readingTextSize').value='comfortable';changeReadingPreferences()");await evaluate('resolveEarlier(false);earlier');result=await snapshot();
    assert.deepEqual(result.stored,{enabled:false,textSize:'comfortable'});assert.equal(result.enabled,false);assert.match(result.status,/saved to your private account/i);checks.push('an older failed save cannot overwrite the latest selection or feedback');

    for(const outcome of ['resolve','reject']){
      await reset();await evaluate(`saveBehavior=()=>new Promise((resolve,reject)=>{window.finishPending=${outcome==='resolve'?'()=>resolve(false)':'()=>reject(new Error("Late fixture failure"))'};});${choose}window.pendingPreference=changeReadingPreferences();undefined`);await until("typeof finishPending==='function'");
      await evaluate("localStorage.setItem('farmerDailyCloudOwner','different-owner');document.querySelector('#readingHelperStatus').textContent='New account owns this status';finishPending();pendingPreference");result=await snapshot();
      assert.equal(result.status,'New account owns this status',`Late ${outcome} must not update a different account's interface`);checks.push(`late ${outcome} is ignored after owner storage changes`);
    }
    await evaluate('Storage.prototype.setItem=originalSetItem');await pause(50);assert.deepEqual(await evaluate('unhandledErrors'),[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks,errors},null,2));
  }finally{ws?.close();if(browser?.pid)browser.kill();if(server.listening)await new Promise(resolve=>server.close(resolve));await pause(500);const target=path.resolve(profileDir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('farmer-reading-failures-'));await fs.rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})().catch(error=>{console.error(error);process.exitCode=1;});
