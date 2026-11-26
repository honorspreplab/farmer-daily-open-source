const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {buildPlan} = require('../work-plan');

const NOW = Date.parse('2026-10-01T14:30:00Z'); // 07:30 Pacific.
const HOUR = 3600000;
function fixture(overrides = {}) {
  return {
    now: NOW, id: 'fixture-plan', date: '2026-10-01',
    fields: [{id:'west',name:'West orchard',crop:'Apples',stage:'Harvest'}, {id:'north',name:'North berries',crop:'Blueberries'}, {id:'south',name:'South field',crop:'Corn'}, {id:'fourth',name:'Fourth field'}],
    observations: [], profile: {locationId:'kirkland',priorityField:'West orchard',wind:'15'},
    forecast: {_locationId:'kirkland',fetchedAt:new Date(NOW).toISOString(),source:{id:'nws',publicUrl:'https://forecast.weather.gov/MapClick.php?lat=47.67&lon=-122.20'},
      hourly: Array.from({length:24}, (_, index) => ({startTime:new Date(NOW - HOUR / 2 + index * HOUR).toISOString(),endTime:new Date(NOW + HOUR / 2 + index * HOUR).toISOString(),probabilityOfPrecipitation:{value:10},windSpeed:'5 mph'}))},
    ...overrides
  };
}

test('plans only actual saved fields, prioritizes a matching field and observations, and does not mutate input', () => {
  const input = fixture({observations:[{fieldId:'south',note:'Check the east corner again.',createdAt:'2026-09-30T19:00:00Z'}]});
  const before = JSON.stringify(input), plan = buildPlan(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(plan.items.map(item => item.fieldId), ['west','south','north']);
  assert.deepEqual(plan.items.map(item => item.time), ['08:00','09:00','10:00']);
  assert.match(plan.items[0].reason, /Crop: Apples\. Stage: Harvest\./);
  assert.match(plan.items[1].reason, /Check the east corner again/);
  assert.equal(plan.items[1].workType, 'inspection');
  assert.equal(plan.items[1].done, false);
  assert.ok(plan.items.every(item => item.date === input.date));
  assert.deepEqual(buildPlan(input), plan, 'Same input yields the same review plan, including IDs');
});

test('changing the forecast changes timing, with no rain-heavy, above-threshold, duplicate, or nighttime slots', () => {
  const input = fixture();
  for (const hour of input.forecast.hourly) hour.probabilityOfPrecipitation.value = 80;
  input.forecast.hourly[3].probabilityOfPrecipitation.value = 5; // 10 Pacific.
  input.forecast.hourly[4].probabilityOfPrecipitation.value = 15;
  input.forecast.hourly[5].probabilityOfPrecipitation.value = 25;
  input.forecast.hourly[5].windSpeed = '10 to 15 mph';
  input.forecast.hourly.push({...input.forecast.hourly[3]});
  const plan = buildPlan(input);
  assert.deepEqual(plan.items.map(item => item.time), ['10:00','11:00','']);
  assert.match(plan.notices.join(' '), /50% or higher/);
  assert.match(plan.notices.join(' '), /15 mph alert threshold/);
  assert.match(plan.items[2].reason, /Unscheduled/);
  assert.doesNotMatch(plan.items[0].reason, /safe/i);
});

test('unknown rain or wind never becomes zero or an assigned hour', () => {
  const input = fixture();
  input.forecast.hourly.forEach(hour => { hour.probabilityOfPrecipitation.value = null; });
  input.forecast.hourly[1].probabilityOfPrecipitation.value = 0;
  input.forecast.hourly[1].windSpeed = 'Unavailable';
  input.forecast.hourly[2].probabilityOfPrecipitation.value = 0;
  input.forecast.hourly[2].windSpeed = '4 km/h';
  input.forecast.hourly[3].probabilityOfPrecipitation.value = '0';
  const plan = buildPlan(input);
  assert.ok(plan.items.every(item => item.time === ''));
  assert.match(plan.notices.join(' '), /not treated as zero/);
  input.forecast.hourly[4].probabilityOfPrecipitation.value = 0;
  input.forecast.hourly[4].windSpeed = 'Calm';
  assert.equal(buildPlan(input).items[0].time, '11:00');
});

test('all past daytime hours leave tasks unscheduled without suggesting night work', () => {
  const now = Date.parse('2026-10-02T00:30:00Z'); // 17:30 October 1 Pacific.
  const input = fixture({now});
  input.forecast.fetchedAt = new Date(now).toISOString();
  const plan = buildPlan(input);
  assert.ok(plan.items.every(item => item.time === ''));
  assert.match(plan.notices.join(' '), /no nighttime work/);
});

test('current partial hour is not suggested as a past start time', () => {
  const now = Date.parse('2026-10-01T15:30:00Z');
  const input = fixture({now});
  input.forecast.fetchedAt = new Date(now).toISOString();
  assert.equal(buildPlan(input).items[0].time, '09:00');
});

test('requires saved fields, matching community, approved source, recent timestamp, and target-date hours', () => {
  assert.throws(() => buildPlan(fixture({fields:[]})), /Add at least one real field/);
  assert.throws(() => buildPlan(fixture({fields:[{name:'Invented from profile'}]})), /real field/);
  assert.throws(() => buildPlan(fixture({forecast:null})), /Refresh weather/);
  for (const changes of [{_locationId:'yakima'}, {source:{id:'unverified'}}, {source:{id:['nws']}}, {source:{id:'constructor'}}, {fetchedAt:new Date(NOW - 6 * HOUR).toISOString()}, {fetchedAt:new Date(NOW + 1).toISOString()}, {fetchedAt:'2026-10-01T07:30:00'}, {hourly:[]}]) {
    const input = fixture();
    Object.assign(input.forecast, changes);
    assert.throws(() => buildPlan(input), /Refresh weather|forecast|coverage/i);
  }
  assert.throws(() => buildPlan(fixture({date:'2026-10-03'})), /today or tomorrow/);
  assert.throws(() => buildPlan(fixture({date:'2026-09-30'})), /today or tomorrow/);
});

test('source credit uses approved provider name and public URL, with cache and license notices', () => {
  const input = fixture();
  input.forecast.source = {id:'open-meteo',name:'Untrusted name',publicUrl:'javascript:alert(1)'};
  input.forecast._cached = true;
  const plan = buildPlan(input);
  assert.deepEqual(plan.source, {id:'open-meteo',name:'Open-Meteo',url:'https://open-meteo.com/',fetchedAt:new Date(NOW).toISOString(),cached:true});
  assert.match(plan.notices.join(' '), /CC BY 4\.0/);
  assert.match(plan.notices.join(' '), /saved forecast less than six hours old/);
  assert.equal(buildPlan(fixture()).source.url, 'https://forecast.weather.gov/MapClick.php?lat=47.67&lon=-122.20');
});

test('tomorrow uses Pacific calendar dates rather than UTC or adding 24 hours across DST', () => {
  for (const scenario of [
    {now:'2026-03-08T07:30:00Z',today:'2026-03-07',tomorrow:'2026-03-08',start:'2026-03-08T15:00:00Z'}, // Before spring jump.
    {now:'2026-11-01T06:30:00Z',today:'2026-10-31',tomorrow:'2026-11-01',start:'2026-11-01T16:00:00Z'}, // Before fall repeat.
    {now:'2027-01-01T07:30:00Z',today:'2026-12-31',tomorrow:'2027-01-01',start:'2027-01-01T16:00:00Z'}
  ]) {
    const now = Date.parse(scenario.now), start = Date.parse(scenario.start);
    const input = fixture({now,date:scenario.tomorrow});
    input.forecast.fetchedAt = scenario.now;
    input.forecast.hourly = Array.from({length:3}, (_, index) => ({startTime:new Date(start + index * HOUR).toISOString(),endTime:new Date(start + (index + 1) * HOUR).toISOString(),probabilityOfPrecipitation:{value:0},windSpeed:'2 mph'}));
    assert.deepEqual(buildPlan(input).items.map(item => item.time), ['08:00','09:00','10:00']);
    assert.equal(buildPlan(input).forDate, scenario.tomorrow);
    assert.throws(() => buildPlan({...input,date:scenario.today}), /no hourly coverage/);
  }
});

test('absent wind threshold is disclosed, while wind itself must still be known', () => {
  const input = fixture();
  delete input.profile.wind;
  assert.equal(buildPlan(input).items[0].time, '08:00');
  assert.match(buildPlan(input).notices.join(' '), /No valid personal wind alert threshold/);
  input.forecast.hourly.forEach(hour => delete hour.windSpeed);
  assert.ok(buildPlan(input).items.every(item => !item.time));
});

test('duplicate and invalid fields are ignored; notes are bound to actual fields and text is bounded', () => {
  const input = fixture({fields:[{id:'one',name:'Only field'}, {id:'one',name:'Duplicate'}, {id:'',name:'No saved ID'}, null], observations:[
    {fieldId:'missing',note:'Not this farm field',createdAt:'2026-09-30T10:00:00Z'},
    {fieldId:'one',note:'Future observation',createdAt:'2030-10-01T10:00:00Z'},
    {field:'Only field',note:'x'.repeat(2000),createdAt:'2026-09-30T10:00:00Z'}
  ]});
  const plan = buildPlan(input);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].fieldId, 'one');
  assert.ok(plan.items[0].reason.length < 1000);
  assert.doesNotMatch(plan.items[0].reason, /Not this farm field|Future observation/);
});

test('invalid hourly dates, offset-free timestamps, and short periods cannot create timing suggestions', () => {
  const input = fixture();
  input.forecast.hourly = [
    {startTime:'not a date',endTime:'also not a date'},
    {startTime:'2026-10-01T08:00:00',endTime:'2026-10-01T09:00:00'},
    {startTime:'2026-10-01T15:00:00Z',endTime:'2026-10-01T15:15:00Z',probabilityOfPrecipitation:{value:0},windSpeed:'2 mph'}
  ];
  assert.ok(buildPlan(input).items.every(item => !item.time));
});

test('loads as a browser global without a module loader', () => {
  const context = vm.createContext({Intl,Date,URL});
  vm.runInContext(fs.readFileSync(require.resolve('../work-plan'), 'utf8'), context);
  assert.equal(typeof context.FarmerWorkPlan.buildPlan, 'function');
  assert.equal(context.FarmerWorkPlan.buildPlan(fixture()).items.length, 3);
});
