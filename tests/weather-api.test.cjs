const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherHandler, validCurrentObservation } = require('../api/weather');

const NOW = Date.parse('2026-09-27T17:30:00Z');
const POINT = 'https://api.weather.gov/points/47.6769,-122.2060';
const DAILY = 'https://api.weather.gov/gridpoints/SEW/129,70/forecast';
const HOURLY = `${DAILY}/hourly`;
const STATIONS = 'https://api.weather.gov/gridpoints/SEW/129,70/stations';
const observationUrl = id => `https://api.weather.gov/stations/${id}/observations/latest`;
const query = { lat: '47.6769', lon: '-122.206' };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });

function nwsFixtures() {
  const daily = [27, 28, 29].map((day, index) => ({
    startTime: `2026-09-${day}T13:00:00Z`, endTime: `2026-09-${day + 1}T01:00:00Z`,
    name: ['Today', 'Monday', 'Tuesday'][index], isDaytime: true,
    temperature: [64, 66, 65][index], temperatureUnit: 'F',
    probabilityOfPrecipitation: { value: null },
    windSpeed: '4 mph', windDirection: 'NW', shortForecast: 'Partly cloudy', detailedForecast: 'Partly cloudy.'
  }));
  const hourly = Array.from({ length: 48 }, (_, index) => ({
    ...daily[0], name: '', temperature: 61,
    startTime: new Date(Math.floor(NOW / 3600000) * 3600000 + index * 3600000).toISOString(),
    endTime: new Date(Math.floor(NOW / 3600000) * 3600000 + (index + 1) * 3600000).toISOString()
  }));
  return new Map([
    [POINT, { properties: { forecast: DAILY, forecastHourly: HOURLY, gridId: 'SEW' } }],
    [DAILY, { properties: { generatedAt: '2026-09-27T16:00:00Z', periods: daily } }],
    [HOURLY, { properties: { periods: hourly } }]
  ]);
}

function station(id = 'NEAR', latitude = 47.68, longitude = -122.21) {
  return {
    type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: { stationIdentifier: id, name: `${id} weather station` }
  };
}

function observation(id = 'NEAR', value = 15, unitCode = 'wmoUnit:degC') {
  return { properties: {
    station: `https://api.weather.gov/stations/${id}`, timestamp: new Date(NOW - 10 * 60 * 1000).toISOString(),
    temperature: { value, unitCode, qualityControl: 'V' }
  } };
}

function observationFixtures(stations = [station()]) {
  const fixtures = nwsFixtures();
  fixtures.get(POINT).properties.observationStations = STATIONS;
  fixtures.get(HOURLY).properties.periods[0].temperature = 57;
  fixtures.set(STATIONS, { type: 'FeatureCollection', features: stations });
  for (const entry of stations) {
    const id = entry.properties.stationIdentifier;
    fixtures.set(observationUrl(id), observation(id));
  }
  return fixtures;
}

function openMeteoFixture() {
  const midnight = Date.parse('2026-09-27T07:00:00Z') / 1000;
  return {
    timezone: 'America/Los_Angeles', utc_offset_seconds: -25200,
    hourly_units: { temperature_2m: '°F', wind_speed_10m: 'mp/h' },
    daily_units: { temperature_2m_max: '°F', temperature_2m_min: '°F', wind_speed_10m_max: 'mp/h' },
    hourly: {
      time: Array.from({ length: 72 }, (_, index) => midnight + index * 3600),
      temperature_2m: Array(72).fill(61.5),
      precipitation_probability: Array(72).fill(null), weather_code: Array(72).fill(3),
      wind_speed_10m: Array(72).fill(4.2), wind_direction_10m: Array(72).fill(315), is_day: Array(72).fill(1)
    },
    daily: {
      time: [midnight, midnight + 86400, midnight + 172800],
      temperature_2m_max: [64.4, 66.2, 65], temperature_2m_min: [51, 52, 50],
      precipitation_probability_max: [null, 40, 10], weather_code: [3, 61, 2],
      wind_speed_10m_max: [6, 9, 7], wind_direction_10m_dominant: [315, 180, 270]
    }
  };
}

async function invoke(handler, coordinates = query) {
  const warnings = [];
  const context = { log: { warn: message => warnings.push(message) } };
  await handler(context, { query: coordinates });
  return { ...context.res, warnings };
}

test('NWS forecast is primary, retains genuine null precipitation, and coalesces concurrent requests', async () => {
  const fixtures = nwsFixtures();
  const requests = [];
  const handler = createWeatherHandler({ now: () => NOW, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /FarmerDaily/);
    assert.ok(fixtures.has(url));
    return response(fixtures.get(url));
  } });
  const [first, second] = await Promise.all([invoke(handler), invoke(handler)]);
  assert.equal(first.status, 200);
  assert.equal(first.body.source.id, 'nws');
  assert.equal(first.body.daily[1].temperature, 66);
  assert.equal(first.body.hourly[0].probabilityOfPrecipitation.value, null);
  assert.equal(first.body.office, 'SEW');
  assert.equal(first.body.fallback, false);
  assert.equal(first.body.stale, false);
  assert.deepEqual(first.body, second.body);
  await invoke(handler);
  assert.equal(requests.length, 3);
});

test('NWS 503 switches to attributed Open-Meteo with Fahrenheit/mph and tomorrow by Pacific date', async () => {
  const fixture = openMeteoFixture();
  // Already Monday UTC, but still Sunday evening in Washington.
  const now = Date.parse('2026-09-28T06:30:00Z');
  const handler = createWeatherHandler({ now: () => now, fetchImpl: async url => {
    if (url.startsWith('https://api.weather.gov/')) return response({}, 503);
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    assert.equal(parsed.searchParams.get('temperature_unit'), 'fahrenheit');
    assert.equal(parsed.searchParams.get('wind_speed_unit'), 'mph');
    assert.equal(parsed.searchParams.get('timezone'), 'America/Los_Angeles');
    assert.equal(parsed.searchParams.get('timeformat'), 'unixtime');
    return response(fixture);
  } });
  const result = await invoke(handler);
  assert.equal(result.status, 200);
  assert.equal(result.body.source.id, 'open-meteo');
  assert.equal(result.body.updated, null);
  assert.equal(result.body.fetchedAt, '2026-09-28T06:30:00.000Z');
  assert.equal(result.body.office, null);
  assert.equal(result.body.fallback, true);
  assert.equal(result.body.source.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.body.daily[1].name, 'Monday');
  assert.equal(result.body.daily[1].startTime, '2026-09-28T07:00:00.000Z');
  assert.equal(result.body.daily[1].temperature, 66.2);
  assert.equal(result.body.daily[1].temperatureLow, 52);
  assert.equal(result.body.daily[1].shortForecast, 'Slight rain');
  assert.equal(result.body.hourly[0].windSpeed, '4 mph');
  assert.equal(result.body.hourly[0].windDirection, 'NW');
  assert.equal(result.body.hourly[0].probabilityOfPrecipitation.value, null);
  assert.ok(Date.parse(result.body.hourly[0].startTime) <= now);
  assert.ok(Date.parse(result.body.hourly[0].endTime) > now);
});

test('a hanging NWS request is aborted within budget and backup still completes', async () => {
  let primarySignal;
  const handler = createWeatherHandler({ now: () => NOW, nwsTimeoutMs: 20, backupTimeoutMs: 200, fetchImpl: async (url, options) => {
    if (url.startsWith('https://api.weather.gov/')) {
      primarySignal = options.signal;
      return new Promise(() => {}); // Even a transport that ignores AbortSignal must not block fallback.
    }
    return response(openMeteoFixture());
  } });
  const start = Date.now();
  const result = await invoke(handler);
  assert.equal(result.status, 200);
  assert.equal(result.body.source.id, 'open-meteo');
  assert.equal(primarySignal.aborted, true);
  assert.ok(Date.now() - start < 1000);
});

test('null NWS temperature triggers backup; null backup temperature never becomes zero', async () => {
  const fixtures = nwsFixtures();
  fixtures.get(HOURLY).properties.periods[0].temperature = null;
  const backup = openMeteoFixture();
  const fetchImpl = async url => fixtures.has(url) ? response(fixtures.get(url)) : response(backup);
  const first = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl }));
  assert.equal(first.body.source.id, 'open-meteo');
  backup.hourly.temperature_2m[10] = null;
  const second = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl }));
  assert.equal(second.status, 503);
  assert.equal(second.body.hourly, undefined);
});

test('cached verified weather is returned stale only for the same location and for at most six hours', async () => {
  const fixtures = nwsFixtures();
  let now = NOW;
  let fail = false;
  const handler = createWeatherHandler({ now: () => now, fetchImpl: async url => {
    if (fail) return response({}, 503);
    return response(fixtures.get(url));
  } });
  const initial = await invoke(handler);
  assert.equal(initial.status, 200);
  fail = true;
  now += 11 * 60 * 1000;
  const cached = await invoke(handler);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.stale, true);
  assert.equal(cached.body.fetchedAt, initial.body.fetchedAt);
  assert.equal(cached.headers['Cache-Control'], 'no-store');
  assert.equal((await invoke(handler, { lat: '47.6', lon: '-122.3' })).status, 503);
  now = NOW + 6 * 60 * 60 * 1000 + 1;
  assert.equal((await invoke(handler)).status, 503);
});

test('forecasts missing current-hour or tomorrow coverage are not accepted', async () => {
  for (const missing of ['current', 'tomorrow']) {
    const fixtures = nwsFixtures();
    if (missing === 'current') fixtures.get(HOURLY).properties.periods.shift();
    else fixtures.get(DAILY).properties.periods.splice(1, 1);
    const handler = createWeatherHandler({ now: () => NOW, fetchImpl: async url => {
      return fixtures.has(url) ? response(fixtures.get(url)) : response({}, 503);
    } });
    assert.equal((await invoke(handler)).status, 503);
  }
});

test('unexpected NWS point URLs cannot cause requests to another host', async () => {
  const seen = [];
  const handler = createWeatherHandler({ now: () => NOW, fetchImpl: async url => {
    seen.push(url);
    if (url === POINT) return response({ properties: { forecast: 'http://localhost/private', forecastHourly: HOURLY } });
    assert.equal(new URL(url).hostname, 'api.open-meteo.com');
    return response(openMeteoFixture());
  } });
  assert.equal((await invoke(handler)).body.source.id, 'open-meteo');
  assert.equal(seen.length, 2);
});

test('invalid or missing coordinates never call providers', async () => {
  const handler = createWeatherHandler({ fetchImpl: async () => assert.fail('Invalid coordinates must not call a provider') });
  for (const coordinates of [{}, { lat: '', lon: '' }, { lat: 'null', lon: '-122.2' }, { lat: '0', lon: '0' }, { lat: '50', lon: '-122.2' }]) {
    assert.equal((await invoke(handler, coordinates)).status, 400);
  }
});

test('recent nearby observed Celsius temperature is distinct from the hourly forecast and rounds only in the UI', async () => {
  const fixtures = observationFixtures();
  const requests = [];
  const handler = createWeatherHandler({ now: () => NOW, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).hostname, 'api.weather.gov');
    assert.ok(fixtures.has(url));
    return response(fixtures.get(url));
  } });
  const result = await invoke(handler);
  assert.equal(result.status, 200);
  assert.equal(result.body.hourly[0].temperature, 57);
  assert.equal(result.body.current.temperature, 59);
  assert.equal(result.body.current.temperatureUnit, 'F');
  assert.equal(result.body.current.kind, 'observation');
  assert.equal(result.body.current.station.id, 'NEAR');
  assert.equal(result.body.current.station.name, 'NEAR weather station');
  assert.ok(result.body.current.station.distanceKm > 0 && result.body.current.station.distanceKm < 1);
  assert.equal(result.body.current.source.url, observationUrl('NEAR'));
  assert.equal(result.body.current.observedAt, '2026-09-27T17:20:00.000Z');
  assert.equal(validCurrentObservation(result.body.current, NOW), true);
  assert.equal(requests.length, 5);
  fixtures.get(observationUrl('NEAR')).properties.temperature.value = 14.44;
  const fractional = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => response(fixtures.get(url)) }));
  assert.equal(fractional.body.current.temperature, 14.44 * 9 / 5 + 32);
});

test('stations are sorted by actual distance, deduplicated, bounded to three within25km, and invalid observations fall through', async () => {
  const stations = [
    station('THIRD', 47.70), station('FAR', 48), station('SECOND', 47.69), station('NEAR'),
    station('FOURTH', 47.71), station('NEAR'), station('BADCOORD', null), station('../private')
  ];
  const fixtures = observationFixtures(stations);
  fixtures.get(observationUrl('NEAR')).properties.temperature.value = null;
  fixtures.get(observationUrl('SECOND')).properties.temperature.value = 16;
  const requests = [];
  const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => {
    requests.push(url);
    return response(fixtures.get(url));
  } }));
  assert.equal(result.body.current.station.id, 'SECOND');
  assert.equal(result.body.current.temperature, 60.8);
  assert.deepEqual(requests.filter(url => url.includes('/observations/latest')),
    ['NEAR', 'SECOND', 'THIRD'].map(observationUrl));
});

test('missing, null, nonnumeric, incorrect-unit, stale, future and rejected-QC observations never replace forecast', async () => {
  const invalid = [
    current => { current.temperature.value = null; },
    current => { delete current.temperature.value; },
    current => { current.temperature.value = '15'; },
    current => { current.temperature.value = Infinity; },
    current => { current.temperature.value = 200; },
    current => { delete current.temperature.unitCode; },
    current => { current.temperature.unitCode = 'wmoUnit:K'; },
    current => { current.timestamp = new Date(NOW - 90 * 60 * 1000 - 1).toISOString(); },
    current => { current.timestamp = new Date(NOW + 60 * 1000 + 1).toISOString(); },
    current => { current.timestamp = '2026-09-27T17:20:00'; },
    current => { delete current.timestamp; },
    current => { current.station = 'https://api.weather.gov/stations/OTHER'; },
    ...['X', 'Q', 'B', '?'].map(code => current => { current.temperature.qualityControl = code; })
  ];
  for (const change of invalid) {
    const fixtures = observationFixtures();
    change(fixtures.get(observationUrl('NEAR')).properties);
    const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => response(fixtures.get(url)) }));
    assert.equal(result.status, 200);
    assert.equal(result.body.source.id, 'nws');
    assert.equal(result.body.current, null);
    assert.equal(result.body.hourly[0].temperature, 57);
  }
});

test('valid zero Celsius and unrounded Fahrenheit observations are accepted with absent or known QC', async () => {
  for (const [value, unit, expected, qc] of [
    [0, 'wmoUnit:degC', 32, undefined], [0, 'wmoUnit:degF', 0, null], [59.45, 'wmoUnit:degF', 59.45, 'C'],
    [15, 'wmoUnit:degC', 59, 'S'], [15, 'wmoUnit:degC', 59, 'G'], [15, 'wmoUnit:degC', 59, 'T']
  ]) {
    const fixtures = observationFixtures();
    fixtures.set(observationUrl('NEAR'), observation('NEAR', value, unit));
    fixtures.get(observationUrl('NEAR')).properties.temperature.qualityControl = qc;
    const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => response(fixtures.get(url)) }));
    assert.equal(result.body.current.temperature, expected);
  }
});

test('station discovery and observation outages remain optional and never discard good NWS forecasts', async () => {
  for (const failed of [STATIONS, observationUrl('NEAR')]) {
    const fixtures = observationFixtures();
    const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => {
      assert.equal(new URL(url).hostname, 'api.weather.gov');
      return url === failed ? response({}, 503) : response(fixtures.get(url));
    } }));
    assert.equal(result.status, 200);
    assert.equal(result.body.source.id, 'nws');
    assert.equal(result.body.current, null);
  }
});

test('observation timeout aborts optional calls but preserves forecast and any other valid nearby reading', async () => {
  const fixtures = observationFixtures([station('SECOND', 47.69), station()]);
  let observationSignal;
  const started = Date.now();
  const result = await invoke(createWeatherHandler({ now: () => NOW, observationTimeoutMs: 20, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.weather.gov');
    if (url === observationUrl('NEAR')) {
      observationSignal = options.signal;
      return new Promise(() => {});
    }
    return response(fixtures.get(url));
  } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.source.id, 'nws');
  assert.equal(result.body.current.station.id, 'SECOND');
  assert.equal(observationSignal.aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test('optional station deadline fits inside the total NWS budget even after a slow point lookup', async () => {
  const fixtures = observationFixtures();
  let stationSignal;
  const result = await invoke(createWeatherHandler({ now: () => NOW, nwsTimeoutMs: 200, observationTimeoutMs: 2000, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.weather.gov');
    if (url === POINT) await new Promise(resolve => setTimeout(resolve, 60));
    if (url === STATIONS) {
      stationSignal = options.signal;
      return new Promise(() => {});
    }
    return response(fixtures.get(url));
  } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.source.id, 'nws');
  assert.equal(result.body.current, null);
  assert.equal(stationSignal.aborted, true);
});

test('untrusted station discovery URLs and station feature links never become outbound request targets', async () => {
  for (const url of [
    'http://localhost/private', 'https://api.weather.gov.evil.test/gridpoints/SEW/129,70/stations',
    'https://user:secret@api.weather.gov/gridpoints/SEW/129,70/stations',
    'https://api.weather.gov:444/gridpoints/SEW/129,70/stations',
    'https://api.weather.gov/gridpoints/SEW/129,70/stations?redirect=1',
    'https://api.weather.gov/gridpoints/SEW/129,70/stations#fragment',
    'https://api.weather.gov/private', '/gridpoints/SEW/129,70/stations'
  ]) {
    const fixtures = observationFixtures();
    fixtures.get(POINT).properties.observationStations = url;
    const requests = [];
    const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async target => {
      requests.push(target);
      return response(fixtures.get(target));
    } }));
    assert.equal(result.status, 200);
    assert.equal(result.body.current, null);
    assert.deepEqual(requests.sort(), [POINT, DAILY, HOURLY].sort());
  }
  const fixtures = observationFixtures();
  fixtures.get(STATIONS).features[0].id = 'http://localhost/private';
  fixtures.get(STATIONS).features[0].properties['@id'] = 'http://localhost/private';
  const result = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => {
    assert.ok(fixtures.has(url));
    return response(fixtures.get(url));
  } }));
  assert.equal(result.body.current.source.url, observationUrl('NEAR'));
});

test('observation freshness is rechecked on both normal cached and six-hour stale forecast responses', async () => {
  const fixtures = observationFixtures();
  fixtures.get(observationUrl('NEAR')).properties.timestamp = new Date(NOW - 89 * 60 * 1000).toISOString();
  let now = NOW;
  let fail = false;
  let requests = 0;
  const handler = createWeatherHandler({ now: () => now, fetchImpl: async url => {
    requests += 1;
    return fail ? response({}, 503) : response(fixtures.get(url));
  } });
  assert.equal((await invoke(handler)).body.current.temperature, 59);
  now += 2 * 60 * 1000;
  const cached = await invoke(handler);
  assert.equal(cached.body.current, null);
  assert.equal(cached.body.stale, false);
  assert.equal(requests, 5);
  now += 4 * 60 * 1000;
  fail = true;
  const stale = await invoke(handler);
  assert.equal(stale.body.current, null);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.hourly[0].temperature, 57);
});

test('normal forecasts refresh after five minutes and manual refresh coalesces with a sixty-second minimum', async () => {
  const fixtures = observationFixtures();
  let now = NOW;
  const requests = [];
  const handler = createWeatherHandler({ now: () => now, fetchImpl: async url => {
    requests.push(url);
    return response(fixtures.get(url));
  } });
  await invoke(handler);
  now += 59 * 1000;
  await invoke(handler, { ...query, refresh: '1' });
  assert.equal(requests.length, 5);
  now += 1000;
  fixtures.get(observationUrl('NEAR')).properties.temperature.value = 16;
  const [first, second] = await Promise.all([invoke(handler, { ...query, refresh: '1' }), invoke(handler, { ...query, refresh: '1' })]);
  assert.equal(first.body.current.temperature, 60.8);
  assert.deepEqual(first.body, second.body);
  assert.equal(requests.length, 10);
  now += 5 * 60 * 1000 - 1;
  await invoke(handler);
  assert.equal(requests.length, 10);
  now += 1;
  await invoke(handler);
  assert.equal(requests.length, 15);
});

test('shared normalized observation validator rejects malformed or untrusted cached records', async () => {
  const fixtures = observationFixtures();
  const valid = (await invoke(createWeatherHandler({ now: () => NOW, fetchImpl: async url => response(fixtures.get(url)) }))).body.current;
  for (const change of [
    value => { value.kind = 'forecast'; }, value => { value.temperature = null; },
    value => { value.temperatureUnit = 'C'; }, value => { value.station.id = '../private'; },
    value => { value.station.name = ''; }, value => { value.station.latitude = null; },
    value => { value.station.distanceKm = 25.01; }, value => { value.station.distanceKm = -1; },
    value => { value.source.url = 'http://localhost/private'; }, value => { value.source.id = 'other'; }
  ]) {
    const invalid = structuredClone(valid);
    change(invalid);
    assert.equal(validCurrentObservation(invalid, NOW), false);
  }
  assert.equal(validCurrentObservation(null, NOW), false);
  assert.equal(validCurrentObservation(valid, NOW + 90 * 60 * 1000), false);
});

test('NWS updateTime is the forecast issue timestamp; generatedAt alone is not an issuance time', async () => {
  const fixtures = nwsFixtures();
  const fetchImpl = async url => response(fixtures.get(url));
  const generatedOnly = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl }));
  assert.equal(generatedOnly.body.updated, null);
  fixtures.get(DAILY).properties.updateTime = '2026-09-27T15:00:00Z';
  const issued = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl }));
  assert.equal(issued.body.updated, '2026-09-27T15:00:00.000Z');
  fixtures.get(DAILY).properties.updateTime = 'invalid';
  const invalid = await invoke(createWeatherHandler({ now: () => NOW, fetchImpl }));
  assert.equal(invalid.body.updated, null);
});
