const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../weather-ui.js'), 'utf8');
const NOW = Date.parse('2026-09-27T17:30:00Z');

function fixture(id = 'nws', temperature = 60) {
  return {
    fetchedAt:new Date(NOW).toISOString(), updated:id === 'nws' ? new Date(NOW - 3600000).toISOString() : null,
    source:{id}, office:id === 'nws' ? 'SEW' : null, fallback:id !== 'nws',
    hourly:[{startTime:'2026-09-27T17:00:00Z',endTime:'2026-09-27T18:00:00Z',temperature,temperatureUnit:'F',shortForecast:'Cloudy',windSpeed:'5 mph',windDirection:'W'}],
    daily:[{startTime:'2026-09-28T07:00:00Z',endTime:'2026-09-29T07:00:00Z',isDaytime:true,temperature:66,temperatureUnit:'F',shortForecast:'Mostly sunny',detailedForecast:'Mostly sunny with a high of 66°F.',probabilityOfPrecipitation:{value:null}}]
  };
}

function setup(fetchImpl) {
  const elements = new Map(), storage = new Map();
  let now = NOW, tick;
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console, Date:FakeDate, Intl, AbortController, setTimeout, clearTimeout, setInterval:callback=>{tick=callback;},
    window:{addEventListener(){}}, document:{hidden:false,addEventListener(){}},
    profile:{locationId:'kirkland',location:'Kirkland, WA'},
    waLocations:{kirkland:['Kirkland, WA',47.6769,-122.206],yakima:['Yakima, WA',46.6021,-120.5059]},
    fetch:fetchImpl || (async()=>response(fixture())),
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    $:selector=>{if(!elements.has(selector))elements.set(selector,{textContent:'',innerHTML:'',hidden:false});return elements.get(selector);}
  });
  vm.runInContext(source, context);
  return {context,elements,storage,setTime:value=>{now=value;},tick:()=>tick()};
}

function response(data) { return {ok:true,status:200,redirected:false,headers:{get:()=> 'application/json'},json:async()=>data}; }

test('tomorrow follows Pacific calendar across DST and browser timezone differences', () => {
  const {context} = setup();
  const data = {daily:[
    {isDaytime:true,startTime:'2026-03-08T08:00:00Z',temperature:65},
    {isDaytime:true,startTime:'2026-03-09T07:00:00Z',temperature:70}
  ]};
  assert.equal(context.tomorrowPeriod(data,Date.parse('2026-03-08T07:30:00Z')).temperature,65);
  assert.equal(context.tomorrowPeriod({daily:[]}),undefined);
});

test('null temperature is rejected and missing rain is never shown as zero percent', async () => {
  const {context,elements} = setup();
  const missing=fixture();missing.hourly[0].temperature=null;
  assert.equal(context.validForecast(missing),false);
  await context.loadForecast();
  assert.equal(elements.get('#tomorrowRain').textContent,'—');
  assert.doesNotMatch(context.weatherAnswer(true), /0%/);
});

test('backup provider attribution and retrieval time reach cards, chat and speech', async () => {
  const {context,elements} = setup(async()=>response(fixture('open-meteo')));
  await context.loadForecast();
  assert.equal(elements.get('#weatherSourceName').textContent,'Open-Meteo');
  assert.equal(elements.get('#weatherLicenseLink').hidden,false);
  assert.match(elements.get('#weatherSourceStatus').textContent,/Backup forecast.*Retrieved/);
  assert.match(context.weatherAnswer(true),/Open-Meteo/);
  assert.match(context.spokenForecastSummary(),/Open-Meteo/);
  assert.doesNotMatch(context.spokenForecastSummary(),/National Weather Service/);
});

test('changing location cancels obsolete requests and cannot cache them under new location', async () => {
  const pending=[];
  const {context,elements,storage} = setup((url,options)=>new Promise(resolve=>pending.push({url,options,resolve})));
  const first=context.loadForecast();
  context.profile={locationId:'yakima',location:'Yakima, WA'};
  const second=context.loadForecast();
  assert.equal(pending[0].options.signal.aborted,true);
  pending[1].resolve(response(fixture('open-meteo',75)));
  await second;
  pending[0].resolve(response(fixture('nws',50)));
  await first;
  assert.equal(elements.get('.weather-mini strong').textContent,'75°F');
  const saved=JSON.parse(storage.get('farmerDailyForecastCacheV2'));
  assert.equal(saved.locationId,'yakima');
  assert.equal(saved.data.hourly[0].temperature,75);
});

test('network failure retains valid saved forecast with cached attribution', async () => {
  const {context,elements,storage}=setup(async()=>{throw new Error('offline');});
  storage.set('farmerDailyForecastCacheV2',JSON.stringify({locationId:'kirkland',data:fixture('open-meteo')}));
  await context.loadForecast();
  assert.equal(elements.get('.weather-mini strong').textContent,'60°F');
  assert.match(elements.get('#weatherSourceStatus').textContent,/Saved forecast/);
  assert.match(context.spokenForecastSummary(),/Saved forecast/);
});

test('expired data and a different location are never reused', async () => {
  const {context,elements,storage}=setup(async()=>{throw new Error('offline');});
  const old=fixture();old.fetchedAt=new Date(NOW-7*3600000).toISOString();
  storage.set('farmerDailyForecastCacheV2',JSON.stringify({locationId:'kirkland',data:old}));
  assert.equal(context.readForecastCache('kirkland'),null);
  storage.set('farmerDailyForecastCacheV2',JSON.stringify({locationId:'yakima',data:fixture()}));
  await context.loadForecast();
  assert.equal(elements.get('.weather-mini strong').textContent,'—');
  assert.match(context.weatherAnswer(true),/reconnecting/);
});

test('device storage failure does not hide a successful forecast', async () => {
  const {context,elements}=setup();
  context.localStorage.setItem=()=>{throw new Error('quota exceeded');};
  await context.loadForecast();
  assert.equal(elements.get('.weather-mini strong').textContent,'60°F');
});

test('expired authentication offers reconnect while retaining recent saved forecast', async () => {
  const {context,elements,storage}=setup(async(url,options)=>{
    assert.equal(options.redirect,'manual');
    return {...response({}),type:'opaqueredirect',status:0,ok:false};
  });
  storage.set('farmerDailyForecastCacheV2',JSON.stringify({locationId:'kirkland',data:fixture()}));
  await context.loadForecast();
  assert.equal(elements.get('#weatherSignInLink').hidden,false);
  assert.equal(elements.get('.weather-mini strong').textContent,'60°F');
});

function observedFixture() {
  const data = fixture('nws',57);
  data.current = {kind:'observation',temperature:59,temperatureUnit:'F',observedAt:new Date(NOW-10*60000).toISOString(),
    station:{id:'SEAW1',name:'Seattle weather station',latitude:47.68528,longitude:-122.25111,distanceKm:3.5},
    source:{id:'nws',name:'NOAA / National Weather Service',url:'https://api.weather.gov/stations/SEAW1/observations/latest'}};
  data.daily.unshift({startTime:'2026-09-27T13:00:00Z',endTime:'2026-09-28T01:00:00Z',isDaytime:true,temperature:70,temperatureUnit:'F',shortForecast:'Sunny'});
  data.daily[1].temperature=72;
  return data;
}

test('nearby observed temperature is separate from hourly estimate and dated daily highs', async () => {
  const {context,elements}=setup(async()=>response(observedFixture()));
  await context.loadForecast();
  assert.equal(elements.get('.weather-mini strong').textContent,'59°F');
  assert.match(elements.get('.weather-mini small').textContent,/Observed nearby/);
  assert.match(elements.get('#currentTemperatureNote').textContent,/59°F.*SEAW1.*2\.2 mi.*10:20 AM PDT/);
  assert.equal(elements.get('#currentObservationLink').hidden,false);
  assert.equal(elements.get('#currentObservationLink').href,'https://api.weather.gov/stations/SEAW1/observations/latest');
  assert.match(elements.get('#weatherHours').innerHTML,/57°F/);
  assert.equal(elements.get('#todayHigh').textContent,'70°F');
  assert.equal(elements.get('#tomorrowHigh').textContent,'72°F');
  assert.equal(elements.get('#todayForecastDate').textContent,'Today · Sep 27');
  assert.equal(elements.get('#tomorrowDate').textContent,'Tomorrow · Sep 28');
  assert.match(context.weatherAnswer(),/59°F.*Hourly forecast estimate.*57 degrees.*high 70/);
  assert.match(context.spokenForecastSummary(),/59°F.*57 degrees.*70 degrees.*72 degrees/);
});

test('stale, future, distant, invalid and non-NWS observations never replace the forecast estimate', async () => {
  for (const change of [
    current=>{current.observedAt=new Date(NOW-90*60000-1).toISOString();},
    current=>{current.observedAt=new Date(NOW+60001).toISOString();},
    current=>{current.observedAt='2026-09-27T10:30:00';},
    current=>{current.temperature=null;},current=>{current.temperature=200;},
    current=>{current.temperatureUnit='C';},current=>{current.station.distanceKm=25.1;},
    current=>{current.source.id='unknown';},current=>{current.station.id='../private';}
  ]) {
    const data=observedFixture();change(data.current);
    const {context,elements}=setup(async()=>response(data));await context.loadForecast();
    assert.equal(elements.get('.weather-mini strong').textContent,'57°F');
    assert.match(elements.get('.weather-mini small').textContent,/Hourly estimate/);
    assert.equal(elements.get('#currentObservationLink').hidden,true);
    assert.doesNotMatch(context.weatherAnswer(),/59°F/);
  }
});

test('a missing today high is never substituted with tomorrow even after the daytime period ends', async () => {
  const data=observedFixture();data.daily.shift();
  const {context,elements}=setup(async()=>response(data));await context.loadForecast();
  assert.equal(elements.get('#todayHigh').textContent,'—');
  assert.match(elements.get('#todayHighNote').textContent,/unavailable/);
  assert.equal(elements.get('#tomorrowHigh').textContent,'72°F');
  assert.equal(context.weatherDateLabel(true,Date.parse('2026-11-01T06:30:00Z')),'Tomorrow · Nov 1');
  assert.equal(context.weatherDateLabel(true,Date.parse('2026-11-01T09:30:00Z')),'Tomorrow · Nov 2');
});

test('cached station readings retain observation time and age out on the open page without a successful fetch', async () => {
  const data=observedFixture();data.current.observedAt=new Date(NOW-89*60000).toISOString();
  const {context,elements,storage,setTime,tick}=setup(async()=>{throw new Error('offline');});
  storage.set('farmerDailyForecastCacheV2',JSON.stringify({locationId:'kirkland',data}));
  await context.loadForecast();
  assert.equal(elements.get('.weather-mini strong').textContent,'59°F');
  assert.match(elements.get('#currentTemperatureNote').textContent,/Saved observation/);
  setTime(NOW+2*60000);tick();
  assert.equal(elements.get('.weather-mini strong').textContent,'57°F');
  assert.match(elements.get('.weather-mini small').textContent,/Saved Hourly estimate/);
  assert.equal(elements.get('#currentObservationLink').hidden,true);
});

test('only explicit refresh requests a provider recheck and observation names render as literal text', async () => {
  const seen=[],data=observedFixture();data.current.station.name='<img src=x onerror=alert(1)>';
  const {context,elements}=setup(async url=>{seen.push(url);return response(data);});
  await context.loadForecast();await context.loadForecast(true);await context.loadForecast({type:'click'});
  assert.ok(!seen[0].includes('refresh='));assert.ok(seen[1].endsWith('&refresh=1'));assert.ok(!seen[2].includes('refresh='));
  assert.match(elements.get('#currentTemperatureNote').textContent,/<img src=x/);
  assert.equal(elements.get('#currentTemperatureNote').innerHTML,'');
});
