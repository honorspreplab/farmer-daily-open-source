const test = require('node:test');
const assert = require('node:assert/strict');
const {buildBrief} = require('../api/brief');
const {createWeatherHandler} = require('../api/weather');

const now=Date.parse('2026-10-03T16:40:00Z');
const profile={firstName:'Test',priorityField:'Orchard',crops:['Apples']};
function weather() {
  return {source:{id:'nws',name:'NOAA / National Weather Service'},fetchedAt:new Date(now).toISOString(),
    hourly:[{startTime:'2026-10-03T16:00:00Z',endTime:'2026-10-03T17:00:00Z',temperature:57,temperatureUnit:'F',shortForecast:'Cloudy'}],
    daily:[{startTime:'2026-10-03T13:00:00Z',endTime:'2026-10-04T01:00:00Z',isDaytime:true,temperature:70,temperatureUnit:'F'},
      {startTime:'2026-10-04T13:00:00Z',endTime:'2026-10-05T01:00:00Z',isDaytime:true,temperature:72,temperatureUnit:'F'}],
    current:{kind:'observation',temperature:59,temperatureUnit:'F',observedAt:'2026-10-03T16:30:00Z',
      station:{id:'SEAW1',name:'Seattle station',latitude:47.68,longitude:-122.25,distanceKm:3.5},
      source:{id:'nws',name:'NOAA / National Weather Service',url:'https://api.weather.gov/stations/SEAW1/observations/latest'}}};
}
function build(data) {return buildBrief(profile,'kirkland',{name:'Kirkland, WA'},data,now);}

test('new saved briefs distinguish station readings, hourly estimates and dated highs',()=>{
  const brief=build(weather()),copy=brief.items.join(' ');
  assert.match(copy,/Nearby NOAA\/NWS observation: 59°F.*SEAW1.*9:30 AM PDT/);
  assert.match(copy,/Hourly forecast estimate.*57°F/);
  assert.match(copy,/Today \(2026-10-03, Pacific\): forecast daytime high 70°F/);
  assert.match(copy,/Tomorrow \(2026-10-04, Pacific\): forecast high 72°F/);
  assert.equal(brief.createdAt,new Date(now).toISOString());
  assert.equal(brief.weather.current,undefined,'Free brief remains a saved summary, not a raw live feed');
});

test('saved brief never promotes missing or stale station values to current readings',()=>{
  for(const current of [null,{...weather().current,temperature:null},{...weather().current,observedAt:'2026-10-03T14:00:00Z'}]){
    const data=weather();data.current=current;
    const copy=build(data).items.join(' ');
    assert.doesNotMatch(copy,/Nearby NOAA\/NWS observation/);
    assert.match(copy,/Hourly forecast estimate.*57°F/);
  }
});

test('saved brief does not borrow a missing today high from tomorrow',()=>{
  const data=weather();data.daily.shift();
  const copy=build(data).items.join(' ');
  assert.doesNotMatch(copy,/Today \(/);
  assert.match(copy,/Tomorrow.*72°F/);
});

test('field weather normalizes valid NWS humidity and never converts unknown humidity to zero',async()=>{
  const hourly=weather().hourly[0],tomorrow=weather().daily[1];
  for(const [input,expected] of [[0,0],[82,82],[100,100],[null,null],[undefined,null],[-1,null],[101,null],['82',null]]) {
    const handler=createWeatherHandler({now:()=>now,fetchImpl:async url=>({ok:true,json:async()=>url.includes('/points/')?{properties:{forecast:'https://api.weather.gov/gridpoints/SEW/10,20/forecast',forecastHourly:'https://api.weather.gov/gridpoints/SEW/10,20/forecast/hourly'}}:
      {properties:{periods:url.endsWith('/hourly')?[{...hourly,relativeHumidity:{value:input}}]:[tomorrow]}}})});
    const context={};await handler(context,{query:{lat:'47.67',lon:'-122.2'}});
    assert.equal(context.res.status,200);assert.equal(context.res.body.hourly[0].relativeHumidity.value,expected);
  }
});

test('backup weather requests relative humidity and keeps unavailable readings null',async()=>{
  const timestamp=Math.floor((now-30*60000)/1000),day=Math.floor(Date.parse('2026-10-03T07:00:00Z')/1000);
  const handler=createWeatherHandler({now:()=>now,fetchImpl:async url=>{
    if(url.startsWith('https://api.weather.gov/'))return {ok:false,status:503};
    assert.ok(new URL(url).searchParams.get('hourly').includes('relative_humidity_2m'));
    return {ok:true,json:async()=>({timezone:'America/Los_Angeles',hourly_units:{temperature_2m:'°F',wind_speed_10m:'mp/h'},daily_units:{temperature_2m_max:'°F',temperature_2m_min:'°F',wind_speed_10m_max:'mp/h'},
      hourly:{time:[timestamp,timestamp+3600],temperature_2m:[57,58],relative_humidity_2m:[68,null],weather_code:[1,1],wind_speed_10m:[5,6],wind_direction_10m:[90,90],precipitation_probability:[10,10],is_day:[1,1]},
      daily:{time:[day,day+86400],temperature_2m_max:[70,72],temperature_2m_min:[45,46],weather_code:[1,1],wind_speed_10m_max:[6,7],wind_direction_10m_dominant:[90,90],precipitation_probability_max:[10,10]}})};
  }});
  const context={};await handler(context,{query:{lat:'47.67',lon:'-122.2'}});
  assert.equal(context.res.status,200);assert.deepEqual(context.res.body.hourly.map(period=>period.relativeHumidity.value),[68,null]);
});
