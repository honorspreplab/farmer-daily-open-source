const test = require('node:test');
const assert = require('node:assert/strict');
const {buildFieldBrief, selectRelevantFields, windMph} = require('../api/shared/advisory-engine');
const now = Date.parse('2026-10-03T16:30:00Z');
const iso = value => new Date(value).toISOString();
const field = {id:'orchard',name:'Block 12',crop:'Apple',location:{latitude:47.67,longitude:-122.2},dataConsent:true};
function data(overrides = {}) {
  return {fieldId:field.id,locationKey:'47.6700,-122.2000',weatherStatus:'live',
    elevation:{status:'loaded',feet:980,meters:298.7,fetchedAt:iso(now),source:{name:'USGS 3DEP',url:'https://www.usgs.gov/3d-elevation-program'}},
    weather:{source:{id:'nws',name:'NOAA / National Weather Service',publicUrl:'https://forecast.weather.gov/MapClick.php?lat=47.67&lon=-122.2'},fetchedAt:iso(now),stale:false,
      hourly:Array.from({length:24},(_,i)=>({startTime:iso(now-30*60000+i*3600000),endTime:iso(now+30*60000+i*3600000),temperature:55,temperatureUnit:'F',windSpeed:'5 mph',probabilityOfPrecipitation:{value:10},relativeHumidity:{value:75}}))},
    alerts:{status:'live',items:[],fetchedAt:iso(now)},...overrides};
}
function build(options={}) {return buildFieldBrief({profile:{firstName:'Sam',farmName:'Sunrise',wind:'15'},fields:[field],tasks:[],fieldData:[data()],timestamp:now,...options});}
function task(overrides={}) {return {id:'task-1',name:'Scout orchard',fieldId:field.id,date:'2026-10-03',done:false,...overrides};}

test('three priorities rank active official alert, freezing, then threshold wind above lower task/rain priorities',()=>{
  const sample=data();sample.weather.hourly[12].temperature=32;sample.weather.hourly[3].windSpeed='12 to 20 mph';sample.weather.hourly[4].probabilityOfPrecipitation.value=70;
  sample.alerts.items=[{id:'alert-1',event:'High Wind Warning',severity:'Severe',headline:'Active high wind warning',effective:iso(now-3600000),expires:iso(now+7200000),url:'https://api.weather.gov/alerts/alert-1'}];
  const brief=build({fieldData:[sample],tasks:[task()]});
  assert.deepEqual(brief.advisories.map(item=>item.kind),['alert-0','freeze','wind']);
  assert.equal(brief.advisories.length,3);assert.equal(brief.engine,'phase1-rules');
  for(const item of brief.advisories) for(const key of ['whatChanged','whyItMatters','suggestedAction','confidence','validUntil','sources','followUp']) assert.ok(item[key],key);
  assert.match(brief.advisories[1].whatChanged,/First recorded forecast/);
  assert.match(brief.advisories[1].whyItMatters,/damage cannot be inferred/);
  assert.match(brief.advisories[2].whyItMatters,/saved 15 mph/);
});

test('changes compare only identical forecast hours and matching field location/provider',()=>{
  const original=data();original.weather.hourly[12].temperature=36;
  const previous=build({fieldData:[original]});
  const current=data();current.weather.hourly[12].temperature=32;
  let brief=build({fieldData:[current],previousBrief:previous});
  assert.match(brief.advisories.find(item=>item.kind==='freeze').whatChanged,/changed from 36°F to 32°F.*same hour/);
  const moved=structuredClone(previous);moved.fieldSummaries[0].locationKey='48,-121';
  assert.match(build({fieldData:[current],previousBrief:moved}).advisories[0].whatChanged,/First recorded forecast/);
  const wrongHour=structuredClone(previous);wrongHour.fieldSummaries[0].forecastSamples=wrongHour.fieldSummaries[0].forecastSamples.filter(item=>item.startTime!==current.weather.hourly[12].startTime);
  assert.match(build({fieldData:[current],previousBrief:wrongHour}).advisories[0].whatChanged,/First recorded forecast/);
  const otherProvider=structuredClone(previous);otherProvider.fieldSummaries[0].sourceId='open-meteo';
  assert.match(build({fieldData:[current],previousBrief:otherProvider}).advisories[0].whatChanged,/First recorded forecast/);
});

test('expired, future-effective and malformed alerts never become priorities',()=>{
  const sample=data();sample.alerts.items=[
    {event:'Expired',expires:iso(now-1),url:'https://api.weather.gov/alerts/a'},
    {event:'Future',effective:iso(now+60000),expires:iso(now+3600000),url:'https://api.weather.gov/alerts/b'},
    {event:'Missing expiry',url:'https://api.weather.gov/alerts/c'},
    {event:'Missing effective',expires:iso(now+3600000),url:'https://api.weather.gov/alerts/d'},
    {event:'Future sent',effective:iso(now-60000),sent:iso(now+3600000),expires:iso(now+7200000),url:'https://api.weather.gov/alerts/e'},
    {event:'Malformed sent',effective:iso(now-60000),sent:'bad',expires:iso(now+7200000),url:'https://api.weather.gov/alerts/f'},
    {event:'Unsafe link',effective:iso(now-60000),expires:iso(now+3600000),url:'https://malicious.test/alert'}];
  assert.ok(build({fieldData:[sample]}).advisories.every(item=>!item.kind.startsWith('alert-')));
});

test('saved official alert validity is bounded to its two-minute check, not a distant warning expiration',()=>{
  const sample=data();sample.alerts.items=[{id:'warning',event:'High Wind Warning',severity:'Severe',headline:'Official warning',effective:iso(now-3600000),expires:iso(now+24*3600000),url:'https://api.weather.gov/alerts/warning'}];
  assert.equal(build({fieldData:[sample]}).advisories[0].validUntil,iso(now+120000));
  sample.alerts.fetchedAt=iso(now-90000);sample.alerts.status='cached';
  let brief=build({fieldData:[sample]});assert.equal(brief.advisories[0].validUntil,iso(now+30000));assert.equal(brief.advisories[0].confidence,'low');
  sample.alerts.items[0].expires=iso(now+10000);assert.equal(build({fieldData:[sample]}).advisories[0].validUntil,iso(now+10000));
  sample.alerts.fetchedAt=iso(now-120000);brief=build({fieldData:[sample]});
  assert.ok(brief.advisories.every(item=>!item.kind.startsWith('alert-')));assert.equal(brief.fieldSummaries[0].alertsStatus,'unavailable');
  assert.match(brief.coverage.notices.join(' '),/not an all-clear/);
});

test('unknown and stale data do not become favorable weather or high-confidence weather advice',()=>{
  const absent=data({weather:null,weatherStatus:'unavailable',alerts:{status:'unavailable',items:[],fetchedAt:null}});
  const brief=build({fieldData:[absent]});
  assert.equal(brief.advisories[0].kind,'unavailable');assert.equal(brief.coverage.partial,true);
  assert.match(brief.coverage.notices.join(' '),/not an all-clear/);
  const old=data();old.weather.fetchedAt=iso(now-7*3600000);
  assert.equal(build({fieldData:[old]}).advisories[0].kind,'unavailable');
  const cached=data();cached.weather.stale=true;cached.weather.hourly[0].temperature=31;
  assert.equal(build({fieldData:[cached]}).advisories.find(item=>item.kind==='freeze').confidence,'low');
  const backup=data();backup.weather.source={id:'open-meteo',name:'Open-Meteo',url:'https://open-meteo.com/en/docs'};backup.weather.hourly[0].temperature=31;
  const backupBrief=build({fieldData:[backup]});assert.equal(backupBrief.advisories[0].confidence,'low');
  assert.equal(backupBrief.advisories[0].sources[0].licenseUrl,'https://creativecommons.org/licenses/by/4.0/');
  assert.match(backupBrief.advisories[0].sources[0].attribution,/Open-Meteo, CC BY 4.0/);
});

test('null meteorological values remain unknown and are disclosed',()=>{
  const sample=data();for(const hour of sample.weather.hourly) {hour.windSpeed='Unavailable';hour.probabilityOfPrecipitation.value=null;hour.relativeHumidity.value=null;}
  const brief=build({fieldData:[sample],tasks:[task()]});
  assert.ok(brief.fieldSummaries[0].forecastSamples.every(hour=>hour.windMph===null && hour.rainProbability===null && hour.relativeHumidity===null));
  assert.ok(brief.advisories.every(item=>!['rain','wind'].includes(item.kind)));
  assert.match(brief.coverage.notices.join(' '),/values are unknown/);
});

test('field coverage is bounded and prioritizes selected field plus due tasks without pretending farmwide coverage',()=>{
  const fields=Array.from({length:8},(_,i)=>({...field,id:`field-${i}`,name:`Field ${i}`}));
  const tasks=[task({fieldId:'field-6'})],profile={priorityField:'Field 7'};
  const selected=selectRelevantFields(fields,tasks,profile,'2026-10-03');
  assert.equal(selected.length,5);assert.equal(selected[0].id,'field-7');assert.equal(selected[1].id,'field-6');
  const brief=build({fields,tasks,profile,fieldData:selected.map(item=>data({fieldId:item.id}))});
  assert.equal(brief.coverage.reviewedFields,5);assert.equal(brief.coverage.totalFields,8);
  assert.equal(brief.coverage.unreviewedFieldIds.length,3);assert.equal(brief.coverage.partial,true);
  assert.match(brief.coverage.notices.join(' '),/Partial coverage: 5 of 8/);
});

test('missing locations or permission produce setup guidance, never community weather disguised as a field',()=>{
  for(const fields of [[],[{...field,location:null}],[{...field,dataConsent:false}]]) {
    const brief=build({fields});assert.equal(brief.advisories[0].kind,'setup');assert.equal(brief.coverage.reviewedFields,0);
    assert.equal(brief.fieldSummaries.length,0);assert.match(brief.advisories[0].whyItMatters,/community forecast is not a substitute/);
  }
});

test('task priorities use Pacific calendar dates through DST and ignore invalid, future, and completed tasks',()=>{
  const timestamp=Date.parse('2026-11-01T08:30:00Z'); // first 1:30AM on the fall-back day
  const brief=build({timestamp,fieldData:[],tasks:[task({id:'old',date:'2026-10-31'}),task({id:'today',date:'2026-11-01'}),task({id:'future',date:'2026-11-02'}),task({id:'bad',date:'2026-02-31'}),task({id:'done',date:'2026-10-30',done:true})]});
  assert.equal(brief.date,'2026-11-01');
  assert.ok(brief.advisories.some(item=>item.taskIds?.includes('old')));
  assert.ok(brief.advisories.some(item=>item.taskIds?.includes('today')));
  assert.ok(brief.advisories.every(item=>!item.taskIds?.some(id=>['future','bad','done'].includes(id))));
  assert.equal(build({timestamp:Date.parse('2026-03-08T09:59:00Z')}).date,'2026-03-08');
  assert.equal(build({timestamp:Date.parse('2026-03-08T10:01:00Z')}).date,'2026-03-08');
});

test('rain advisory is tied to open field tasks and never equates rain probability to wet ground',()=>{
  const sample=data();sample.weather.hourly[2].probabilityOfPrecipitation.value=65;
  assert.ok(build({fieldData:[sample]}).advisories.every(item=>item.kind!=='rain'));
  const brief=build({fieldData:[sample],tasks:[task()]});
  assert.equal(brief.advisories[0].kind,'rain');assert.deepEqual(brief.advisories[0].taskIds,['task-1']);
  assert.match(brief.advisories[0].whyItMatters,/does not measure rainfall amount or soil trafficability/);
  const tomorrow=data();tomorrow.weather.hourly[20].probabilityOfPrecipitation.value=90;
  assert.ok(build({fieldData:[tomorrow],tasks:[task()]}).advisories.every(item=>item.kind!=='rain'),'tomorrow rain is not presented as affecting today tasks');
});

test('Spanish templates and sources are useful without silently translating official alert text',()=>{
  const sample=data();sample.weather.hourly[0].temperature=30;sample.weather.hourly[1].windSpeed='20 mph';
  const brief=build({profile:{firstName:'Ana',language:'Spanish'},fieldData:[sample],tasks:[task()]});
  assert.equal(brief.language,'es');assert.match(brief.summary,/prioridades para revisar/);
  assert.match(brief.advisories[0].title,/Pronóstico/);assert.match(brief.advisories[0].whatChanged,/Primer pronóstico/);
  assert.match(brief.advisories[1].whyItMatters,/predeterminado.*15 mph/);
  assert.match(brief.explanation,/no un diagnóstico de IA/);
});

test('weather-only brief describes its own coverage without denying connected Phase 2/3 features',()=>{
  const english=build(),spanish=build({profile:{language:'Spanish'}});
  assert.match(english.explanation,/This brief includes no soil, satellite or market data/);
  assert.match(english.explanation,/Open Data & Intelligence/);
  assert.doesNotMatch(english.explanation,/connected in this phase/);
  assert.match(spanish.explanation,/Este resumen no incluye/);
  assert.match(spanish.explanation,/Datos e inteligencia/);
  assert.doesNotMatch(spanish.explanation,/En esta fase no hay/);
});

test('elevation is retained as context and never silently adjusts forecast temperature',()=>{
  const brief=build();assert.equal(brief.fieldSummaries[0].elevation.feet,980);
  assert.equal(brief.fieldSummaries[0].forecastSamples[0].temperature,55);
  assert.match(brief.advisories[0].suggestedAction,/not been used to adjust temperatures/);
  assert.equal(windMph('5 to 18 mph'),18);assert.equal(windMph('0 mph'),0);assert.equal(windMph(''),null);assert.equal(windMph('15 km/h'),null);
});
