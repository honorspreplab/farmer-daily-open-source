// Optional browser integration check: node tests/weather-browser-smoke.cjs
// Uses an isolated temporary browser profile, fixture weather, and no user credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let weatherRequests = 0;
let weatherStatus = 200;
let weatherMode = 'observation';
const weatherQueries = [];
const fixtureProfile = {firstName:'Test',farmName:'Test Farm',locationId:'kirkland',location:'Kirkland, WA',region:'puget',role:'owner',crops:['Apples'],priorityField:'Test field',acres:'10',wind:'15',market:'5',briefTime:'06:30',language:'English',phone:'',address:''};
function pacificDay(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const part = type => parts.find(item => item.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
}
function fixture() {
  const now = Date.now(), start = Math.floor(now / 3600000) * 3600000;
  const today = pacificDay(now) + 'T19:00:00Z'; // Noon Pacific in summer, 11am in winter.
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString();
  const backup = weatherMode === 'backup';
  const current = {
    kind:'observation',temperature:59,temperatureUnit:'F',observedAt:new Date(now - 10 * 60000).toISOString(),
    station:{id:'KBFI',name:'Test airport',latitude:47.53,longitude:-122.3,distanceKm:18},
    source:{id:'nws',name:'NOAA / National Weather Service',url:'https://api.weather.gov/stations/KBFI/observations/latest'}
  };
  if (weatherMode === 'stale') current.observedAt = new Date(now - 2 * 3600000).toISOString();
  if (weatherMode === 'future') current.observedAt = new Date(now + 30 * 60000).toISOString();
  if (weatherMode === 'unknown') current.source.id = 'unverified';
  return {fetchedAt:new Date(now).toISOString(),updated:null,source:{id:backup ? 'open-meteo' : 'nws'},fallback:backup,office:backup ? null : 'SEW',
    current:backup || weatherMode === 'missing' ? null : current,
    hourly:Array.from({length:48}, (_, i) => ({startTime:new Date(start+i*3600000).toISOString(),endTime:new Date(start+(i+1)*3600000).toISOString(),temperature:57,temperatureUnit:'F',shortForecast:'Partly cloudy',windSpeed:'5 mph',windDirection:'W'})),
    daily:[
      {startTime:today,endTime:new Date(Date.parse(today)+12*3600000).toISOString(),isDaytime:true,temperature:70,temperatureUnit:'F',shortForecast:'Mostly sunny',detailedForecast:'Mostly sunny with a high of 70 degrees Fahrenheit.',probabilityOfPrecipitation:{value:10}},
      {startTime:tomorrow,endTime:new Date(Date.parse(tomorrow)+12*3600000).toISOString(),isDaytime:true,temperature:72,temperatureUnit:'F',shortForecast:'Mostly sunny',detailedForecast:'Mostly sunny with a high of 72 degrees Fahrenheit.',probabilityOfPrecipitation:{value:20}}
    ]};
}
const mime = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/account') {res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({user:{id:'weather-test-premium',email:'weather-test@example.com'},isAdmin:false,plan:'premium',request:null,date:pacificDay()}));return;}
  if (url.pathname === '/api/state') {res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(req.method==='GET'?{profile:fixtureProfile,theme:'field',fields:[],tasks:[],observations:[],jobs:[],jobEvents:[]}:{saved:true}));return;}
  if (url.pathname === '/api/brief') {res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({brief:null,date:pacificDay(),reused:true}));return;}
  if (url.pathname === '/api/weather') {weatherRequests++;weatherQueries.push(Object.fromEntries(url.searchParams));res.writeHead(weatherStatus, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(weatherStatus === 200 ? fixture() : {error:'Fixture outage'}));return;}
  if (url.pathname === '/.auth/me') {res.writeHead(200, {'Content-Type':'application/json'});res.end('{"clientPrincipal":null}');return;}
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);res.end();return;}
  try {const body = await fs.readFile(file);res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);} catch {res.writeHead(404);res.end();}
});

async function main() {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'farmer-weather-smoke-'));
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'farmer-weather-artifacts-'));
  let browser, ws;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profileDir,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','about:blank'], {windowsHide:true,stdio:'ignore'});
    let spawnError;
    browser.on('error', error => {spawnError=error;});
    let port;
    for (let i=0;i<100;i++) {if(spawnError)throw spawnError;try {port=(await fs.readFile(path.join(profileDir,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}await pause(100);}
    assert.ok(port,'Browser debugging port became available');
    const pages = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    ws = new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let sequence=0;
    const pending=new Map(), errors=[];
    ws.addEventListener('message', event=>{const data=JSON.parse(event.data);if(data.id){const entry=pending.get(data.id);if(entry){pending.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);}}else if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);});
    function cdp(method,params={}) {return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},10000)});ws.send(JSON.stringify({id,method,params}));});}
    async function evaluate(expression) {const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
    async function waitFor(expression, description) {
      for (let i=0;i<100;i++) {if(await evaluate(expression))return;await pause(100);}
      assert.fail('Timed out waiting for '+description);
    }
    async function refresh() {
      const requestsBefore = weatherRequests;
      await evaluate("document.querySelector('#retryWeatherBtn').click()");
      for(let i=0;i<100&&weatherRequests===requestsBefore;i++)await pause(50);
      assert.ok(weatherRequests>requestsBefore,'Refresh button requests another forecast');
      assert.equal(weatherQueries.at(-1).refresh,'1','Explicit refresh requests a bounded provider refresh');
      await waitFor('forecastRequest === null', 'weather request to complete');
    }
    const weatherSnapshot = "({source:document.querySelector('#weatherSourceName').textContent,current:document.querySelector('.weather-mini strong').textContent,currentLabel:document.querySelector('.weather-mini small').textContent,currentNote:document.querySelector('#currentTemperatureNote').textContent,todayHigh:document.querySelector('#todayHigh').textContent,todayDate:document.querySelector('#todayForecastDate').textContent,tomorrowHigh:document.querySelector('#tomorrowHigh').textContent,tomorrowDate:document.querySelector('#tomorrowDate').textContent,licenseHidden:document.querySelector('#weatherLicenseLink').hidden,status:document.querySelector('#weatherSourceStatus').textContent,onboardingHidden:document.querySelector('#onboarding').classList.contains('hidden'),spoken:spokenForecastSummary(),chat:weatherAnswer(true)})";
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Network.enable');
    await cdp('Network.setBlockedURLs',{urls:['https://*','http://fonts.*']});
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('farmerDailyProfile',"+JSON.stringify(JSON.stringify(fixtureProfile))+");"});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url});
    await waitFor("typeof forecastRequest !== 'undefined' && forecastRequest === null && document.querySelector('.weather-mini strong')?.textContent === '59\\u00b0F'", 'nearby NWS observation');
    const desktop = await evaluate(weatherSnapshot);
    assert.match(desktop.source,/NOAA.*National Weather Service/);
    assert.equal(desktop.current,'59\u00b0F','Current temperature uses the observed value, not the 57F hourly estimate');
    assert.match(desktop.currentLabel,/Observed nearby/i);
    assert.match(desktop.currentNote,/Test airport/);
    assert.match(desktop.currentNote,/(18\s*km|11(?:\.\d+)?\s*(?:mi|miles))/i,'Nearby station distance is disclosed');
    assert.match(desktop.currentNote,/\d{1,2}:\d{2}|\d+\s*min/i,'Observed timestamp or age is disclosed');
    assert.equal(desktop.todayHigh,'70\u00b0F');
    assert.equal(desktop.tomorrowHigh,'72\u00b0F','The nearby observation must not alter tomorrow forecast high');
    assert.match(desktop.todayDate,/Today/i);
    assert.match(desktop.tomorrowDate,/Tomorrow/i);
    const todayLabel = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',month:'short',day:'numeric'}).format(new Date(pacificDay()+'T19:00:00Z'));
    const tomorrowLabel = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',month:'short',day:'numeric'}).format(new Date(Date.parse(pacificDay()+'T19:00:00Z')+86400000));
    assert.ok(desktop.todayDate.includes(todayLabel),'Today card labels the current Pacific date ('+todayLabel+')');
    assert.ok(desktop.tomorrowDate.includes(tomorrowLabel),'Tomorrow card labels the next Pacific date ('+tomorrowLabel+')');
    assert.equal(desktop.licenseHidden,true);
    assert.equal(desktop.onboardingHidden,true);
    assert.match(desktop.spoken,/Observed nearby.*59(?:\u00b0F| degrees Fahrenheit)/i);
    assert.match(desktop.spoken,/Tomorrow.*72 degrees Fahrenheit/i);
    assert.match(desktop.chat,/high of 72 degrees Fahrenheit/);

    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate("document.querySelector('#weatherSignal').scrollIntoView({block:'center'});");
    const mobile = await evaluate("({width:innerWidth,bodyWidth:document.body.scrollWidth,card:document.querySelector('#weatherSignal').getBoundingClientRect().toJSON(),today:document.querySelector('#todayHigh').textContent,current:document.querySelector('.weather-mini strong').textContent})");
    assert.equal(mobile.current,'59\u00b0F');
    assert.equal(mobile.today,'70\u00b0F');
    assert.ok(mobile.card.width<=390 && mobile.card.left>=0 && mobile.card.right<=391,'Weather card fits 390px viewport');
    assert.ok(mobile.bodyWidth<=391,'Weather additions do not overflow the mobile page');
    const screenshotPath = path.join(artifactDir,'weather-mobile-390.png');
    const screenshot = await cdp('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(screenshotPath,Buffer.from(screenshot.data,'base64'));

    const rejectedObservations = [];
    for (const mode of ['stale','future','unknown','missing']) {
      weatherMode = mode;
      await refresh();
      const state = await evaluate(weatherSnapshot);
      assert.equal(state.current,'57\u00b0F',mode+' observation falls back to the hourly estimate');
      assert.match(state.currentLabel,/Hourly estimate/i);
      assert.equal(state.todayHigh,'70\u00b0F');
      assert.equal(state.tomorrowHigh,'72\u00b0F');
      rejectedObservations.push({mode,current:state.current,label:state.currentLabel});
    }

    weatherMode = 'backup';
    await refresh();
    const backup = await evaluate(weatherSnapshot);
    assert.equal(backup.source,'Open-Meteo');
    assert.equal(backup.current,'57\u00b0F');
    assert.match(backup.currentLabel,/Hourly estimate/i);
    assert.equal(backup.licenseHidden,false);
    assert.match(backup.status,/Backup forecast.*Retrieved/);
    assert.match(backup.spoken,/Open-Meteo.*Tomorrow.*72 degrees Fahrenheit/);
    assert.match(backup.chat,/high of 72 degrees Fahrenheit/);

    weatherStatus = 503;
    await refresh();
    const cached = await evaluate(weatherSnapshot);
    assert.match(cached.status,/Saved forecast/);
    assert.equal(cached.tomorrowHigh,'72\u00b0F');
    assert.equal(cached.todayHigh,'70\u00b0F');

    weatherStatus = 401;
    await refresh();
    const authCached = await evaluate("({signInHidden:document.querySelector('#weatherSignInLink').hidden,status:document.querySelector('#weatherSourceStatus').textContent,current:document.querySelector('.weather-mini strong').textContent})");
    assert.equal(authCached.signInHidden,false,'Expired weather sign-in has a visible reconnect link');
    assert.match(authCached.status,/Saved forecast/);
    assert.equal(authCached.current,'57\u00b0F');
    await evaluate('liveForecast = null; localStorage.removeItem(WEATHER_CACHE_KEY);');
    await refresh();
    const authEmpty = await evaluate("({signInHidden:document.querySelector('#weatherSignInLink').hidden,current:document.querySelector('.weather-mini strong').textContent,today:document.querySelector('#todayHigh').textContent,tomorrow:document.querySelector('#tomorrowHigh').textContent,copy:document.querySelector('#weatherCopy').textContent})");
    assert.equal(authEmpty.signInHidden,false);
    assert.doesNotMatch(authEmpty.current,/\d/,'No invented temperature is shown without a usable forecast');
    assert.doesNotMatch(authEmpty.today,/\d/);
    assert.doesNotMatch(authEmpty.tomorrow,/\d/);
    assert.match(authEmpty.copy,/Sign in again/i);

    weatherStatus = 200;
    weatherMode = 'observation';
    await refresh();
    assert.equal(await evaluate("document.querySelector('.weather-mini strong').textContent"),'59\u00b0F','Retry recovers a nearby observation');
    assert.equal(await evaluate("document.querySelector('#weatherSignInLink').hidden"),true);
    assert.deepEqual(errors,[],'No browser JavaScript exceptions');
    console.log(JSON.stringify({passed:true,desktop,mobile,rejectedObservations,backup,cached,authCached,authEmpty,weatherRequests,screenshotPath,errors},null,2));
    ws.close();ws=null;
  } finally {
    ws?.close();
    if(browser?.pid)browser.kill();
    await new Promise(resolve=>server.close(resolve));
    await pause(500);
    const resolved=path.resolve(profileDir), expectedParent=path.resolve(os.tmpdir());
    if(path.dirname(resolved)===expectedParent && path.basename(resolved).startsWith('farmer-weather-smoke-'))await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
