const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const OBSERVATION_MAX_AGE_MS = 90 * 60 * 1000;
const OBSERVATION_FUTURE_TOLERANCE_MS = 60 * 1000;
const MAX_STATION_DISTANCE_KM = 25;
const STATION_ID = /^[A-Z0-9_-]{1,32}$/i;
const MAX_CACHE_ENTRIES = 128;
const TIME_ZONE = 'America/Los_Angeles';
const NWS_HEADERS = {
  'User-Agent': '(FarmerDaily/0.8, https://calm-desert-02e51f41e.1.azurestaticapps.net)',
  Accept: 'application/geo+json'
};
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' });

function dateKey(value) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function tomorrowKey(now) {
  return new Date(Date.parse(`${dateKey(now)}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function probability(value) {
  return number(value) && value >= 0 && value <= 100 ? value : null;
}

function validPeriod(period) {
  return period && number(period.temperature) && period.temperatureUnit === 'F' &&
    Number.isFinite(Date.parse(period.startTime)) && Number.isFinite(Date.parse(period.endTime)) &&
    Date.parse(period.endTime) > Date.parse(period.startTime);
}

// A recent fetch alone does not make an old forecast usable: it must cover now and tomorrow.
function validForecast(payload, now) {
  return Array.isArray(payload?.daily) && payload.daily.length > 0 && payload.daily.every(validPeriod) &&
    Array.isArray(payload?.hourly) && payload.hourly.length > 0 && payload.hourly.every(validPeriod) &&
    payload.hourly.some(period => Date.parse(period.startTime) <= now && Date.parse(period.endTime) > now) &&
    payload.daily.some(period => period.isDaytime && dateKey(period.startTime) === tomorrowKey(now));
}

function currentCoverage(payload, now) {
  const filtered = {
    ...payload,
    current: validCurrentObservation(payload.current, now) ? payload.current : null,
    hourly: payload.hourly.filter(period => Date.parse(period.endTime) > now)
  };
  if (!validForecast(filtered, now)) throw new Error('Forecast coverage incomplete');
  return filtered;
}

function nwsForecastUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'api.weather.gov' || url.port || url.username || url.password ||
      !/^\/gridpoints\/[A-Z]{3}\/-?\d+,-?\d+\/forecast(?:\/hourly)?$/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('Unexpected NWS forecast URL');
  }
  return url.href;
}

function nwsStationsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'api.weather.gov' || url.port || url.username || url.password ||
      !/^\/gridpoints\/[A-Z]{3}\/-?\d+,-?\d+\/stations$/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('Unexpected NWS stations URL');
  }
  return url.href;
}

function observationUrl(id) {
  if (typeof id !== 'string' || !STATION_ID.test(id)) throw new Error('Invalid station identifier');
  return `https://api.weather.gov/stations/${id}/observations/latest`;
}

function coordinates(latitude, longitude) {
  return number(latitude) && number(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function distanceKm(latitude, longitude, stationLatitude, stationLongitude) {
  const radians = degrees => degrees * Math.PI / 180;
  const a = Math.sin(radians(stationLatitude - latitude) / 2) ** 2 +
    Math.cos(radians(latitude)) * Math.cos(radians(stationLatitude)) * Math.sin(radians(stationLongitude - longitude) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function recentObservationTime(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= -OBSERVATION_FUTURE_TOLERANCE_MS && age <= OBSERVATION_MAX_AGE_MS;
}

// Shared with the daily brief so a cached observation never silently becomes "now".
function validCurrentObservation(current, now) {
  const station = current?.station;
  return current?.kind === 'observation' && current.temperatureUnit === 'F' && number(current.temperature) &&
    current.temperature >= -130 && current.temperature <= 140 && recentObservationTime(current.observedAt, now) &&
    typeof station?.id === 'string' && STATION_ID.test(station.id) &&
    typeof station.name === 'string' && station.name.length > 0 && station.name.length <= 200 &&
    coordinates(station.latitude, station.longitude) && number(station.distanceKm) &&
    station.distanceKm >= 0 && station.distanceKm <= MAX_STATION_DISTANCE_KM &&
    current.source?.id === 'nws' && current.source.url === observationUrl(station.id);
}

function observationStations(data, latitude, longitude) {
  if (!Array.isArray(data?.features)) return [];
  const candidates = data.features.map(feature => {
    const id = feature?.properties?.stationIdentifier;
    const point = feature?.geometry;
    if (typeof id !== 'string' || !STATION_ID.test(id) || point?.type !== 'Point' || !Array.isArray(point.coordinates)) return null;
    const [stationLongitude, stationLatitude] = point.coordinates;
    if (!coordinates(stationLatitude, stationLongitude)) return null;
    const distance = distanceKm(latitude, longitude, stationLatitude, stationLongitude);
    if (distance > MAX_STATION_DISTANCE_KM) return null;
    const name = typeof feature.properties.name === 'string' ? feature.properties.name.trim().slice(0, 200) : '';
    return { id, name: name || id, latitude: stationLatitude, longitude: stationLongitude, distanceKm: distance };
  }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates.filter((station, index) => candidates.findIndex(candidate => candidate.id === station.id) === index).slice(0, 3);
}

function normalizeObservation(data, station, now) {
  const properties = data?.properties;
  const measurement = properties?.temperature;
  if (!number(measurement?.value) || !['wmoUnit:degC', 'wmoUnit:degF'].includes(measurement.unitCode)) return null;
  // MADIS: X = rejected, Q = questioned, B = subjective bad. Unknown codes are not accepted.
  if (measurement.qualityControl != null && !['Z', 'C', 'S', 'V', 'G', 'T'].includes(measurement.qualityControl)) return null;
  if (properties.station != null && properties.station !== `https://api.weather.gov/stations/${station.id}`) return null;
  if (!recentObservationTime(properties.timestamp, now)) return null;
  const current = {
    kind: 'observation',
    temperature: measurement.unitCode === 'wmoUnit:degC' ? measurement.value * 9 / 5 + 32 : measurement.value,
    temperatureUnit: 'F', observedAt: new Date(properties.timestamp).toISOString(), station,
    source: { id: 'nws', name: 'NOAA / National Weather Service', url: observationUrl(station.id) }
  };
  return validCurrentObservation(current, now) ? current : null;
}

async function nwsObservation(fetchImpl, stationListUrl, latitude, longitude, parentSignal, now, timeoutMs) {
  if (!stationListUrl || timeoutMs <= 0 || parentSignal.aborted) return null;
  const results = [];
  try {
    const url = nwsStationsUrl(stationListUrl);
    await withDeadline(async timeoutSignal => {
      const signal = AbortSignal.any([timeoutSignal, parentSignal]);
      const data = await getJson(fetchImpl, url, signal, NWS_HEADERS);
      const stations = observationStations(data, latitude, longitude);
      await Promise.all(stations.map(async (station, index) => {
        try {
          const observation = await getJson(fetchImpl, observationUrl(station.id), signal, NWS_HEADERS);
          if (!signal.aborted) results[index] = normalizeObservation(observation, station, now());
        } catch { /* A failed station does not suppress another nearby observation or the forecast. */ }
      }));
    }, timeoutMs);
  } catch { /* Observations are optional, including when station discovery or its deadline fails. */ }
  return results.find(current => validCurrentObservation(current, now())) || null;
}

async function withDeadline(operation, milliseconds) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Weather provider timed out'));
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    // Also cancel a sibling request if Promise.all failed before both finished.
    controller.abort();
  }
}

async function getJson(fetchImpl, url, signal, headers, attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw new Error('Weather request aborted');
    try {
      const response = await fetchImpl(url, { headers, signal, redirect: 'error' });
      if (!response.ok) {
        const error = new Error('Weather provider request failed');
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (signal.aborted || error.retryable === false || attempt === attempts - 1) throw error;
    }
  }
}

function normalizeNwsPeriod(period) {
  return {
    ...period,
    probabilityOfPrecipitation: { value: probability(period?.probabilityOfPrecipitation?.value) },
    relativeHumidity: { value: probability(period?.relativeHumidity?.value) },
    windSpeed: typeof period?.windSpeed === 'string' && period.windSpeed ? period.windSpeed : 'Unavailable',
    windDirection: typeof period?.windDirection === 'string' && period.windDirection ? period.windDirection : 'Unavailable'
  };
}

async function nwsForecast(fetchImpl, latitude, longitude, signal, now, observationTimeoutMs, deadlineAt) {
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const point = await getJson(fetchImpl, `https://api.weather.gov/points/${key}`, signal, NWS_HEADERS, 2);
  const forecastUrl = nwsForecastUrl(point?.properties?.forecast);
  const hourlyUrl = nwsForecastUrl(point?.properties?.forecastHourly);
  // Start optional observations alongside both forecasts. Finish the observation budget before
  // the outer NWS deadline so an otherwise healthy forecast cannot be discarded by a slow station.
  const observation = nwsObservation(fetchImpl, point.properties.observationStations, latitude, longitude, signal, now,
    Math.max(0, Math.min(observationTimeoutMs, deadlineAt - Date.now() - 50)));
  const [daily, hourly] = await Promise.all([
    getJson(fetchImpl, forecastUrl, signal, NWS_HEADERS, 2),
    getJson(fetchImpl, hourlyUrl, signal, NWS_HEADERS, 2)
  ]);
  // generatedAt is response generation, not the forecast's actual issuance/update time.
  const issueTime = daily?.properties?.updateTime;
  const payload = {
    current: await observation,
    updated: Number.isFinite(Date.parse(issueTime)) ? new Date(issueTime).toISOString() : null,
    fetchedAt: new Date(now()).toISOString(),
    office: typeof point.properties.gridId === 'string' ? point.properties.gridId : null,
    daily: Array.isArray(daily?.properties?.periods) ? daily.properties.periods.map(normalizeNwsPeriod) : [],
    hourly: Array.isArray(hourly?.properties?.periods) ? hourly.properties.periods.map(normalizeNwsPeriod) : [],
    source: {
      id: 'nws',
      name: 'NOAA / National Weather Service',
      url: forecastUrl,
      publicUrl: `https://forecast.weather.gov/MapClick.php?lat=${latitude}&lon=${longitude}`,
      licenseUrl: null,
      attribution: 'Official U.S. government forecast data. Farmer Daily is not affiliated with or endorsed by NOAA or the National Weather Service.'
    },
    fallback: false,
    stale: false
  };
  const result = currentCoverage(payload, now());
  return { ...result, hourly: result.hourly.slice(0, 48) };
}

const WMO_CONDITIONS = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
};

function conditions(code) {
  return number(code) ? WMO_CONDITIONS[code] || 'Conditions unavailable' : 'Conditions unavailable';
}

function windDirection(degrees) {
  if (!number(degrees) || degrees < 0 || degrees > 360) return 'Unavailable';
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(degrees / 22.5) % points.length];
}

function windSpeed(speed) {
  return number(speed) && speed >= 0 ? `${Math.round(speed)} mph` : 'Unavailable';
}

function openMeteoUrl(latitude, longitude) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: latitude.toFixed(4), longitude: longitude.toFixed(4),
    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
    timezone: TIME_ZONE, timeformat: 'unixtime', forecast_days: '3'
  }).toString();
  return url.href;
}

function isoUnix(seconds) {
  if (!number(seconds)) throw new Error('Forecast timestamp missing');
  return new Date(seconds * 1000).toISOString();
}

async function openMeteoForecast(fetchImpl, latitude, longitude, signal, now) {
  const url = openMeteoUrl(latitude, longitude);
  const data = await getJson(fetchImpl, url, signal, { Accept: 'application/json' });
  if (data?.hourly_units?.temperature_2m !== '°F' || data?.daily_units?.temperature_2m_max !== '°F' ||
      data?.daily_units?.temperature_2m_min !== '°F' || data?.hourly_units?.wind_speed_10m !== 'mp/h' ||
      data?.daily_units?.wind_speed_10m_max !== 'mp/h' || data?.timezone !== TIME_ZONE ||
      !Array.isArray(data?.hourly?.time) || !Array.isArray(data?.daily?.time)) {
    throw new Error('Forecast units or structure invalid');
  }
  const hourly = data.hourly.time.map((seconds, index) => {
    const weather = conditions(data.hourly.weather_code?.[index]);
    return {
      startTime: isoUnix(seconds), endTime: isoUnix(seconds + 3600), name: '',
      isDaytime: data.hourly.is_day?.[index] === 1,
      temperature: data.hourly.temperature_2m?.[index], temperatureUnit: 'F',
      probabilityOfPrecipitation: { value: probability(data.hourly.precipitation_probability?.[index]) },
      relativeHumidity: { value: probability(data.hourly.relative_humidity_2m?.[index]) },
      shortForecast: weather, detailedForecast: weather,
      windSpeed: windSpeed(data.hourly.wind_speed_10m?.[index]),
      windDirection: windDirection(data.hourly.wind_direction_10m?.[index])
    };
  }).filter(period => Date.parse(period.endTime) > now());
  const daily = data.daily.time.map((seconds, index) => {
    const high = data.daily.temperature_2m_max?.[index];
    const low = data.daily.temperature_2m_min?.[index];
    const weather = conditions(data.daily.weather_code?.[index]);
    return {
      startTime: isoUnix(seconds), endTime: isoUnix(data.daily.time[index + 1] ?? seconds + 86400),
      name: weekdayFormatter.format(new Date(seconds * 1000)), isDaytime: true,
      temperature: high, temperatureUnit: 'F', temperatureLow: number(low) ? low : null,
      probabilityOfPrecipitation: { value: probability(data.daily.precipitation_probability_max?.[index]) },
      shortForecast: weather,
      detailedForecast: `${weather}. Daily high ${high}°F.${number(low) ? ` Daily low ${low}°F.` : ''}`,
      windSpeed: windSpeed(data.daily.wind_speed_10m_max?.[index]),
      windDirection: windDirection(data.daily.wind_direction_10m_dominant?.[index])
    };
  });
  const result = currentCoverage({
    current: null,
    updated: null, // This endpoint does not provide a forecast issuance timestamp.
    fetchedAt: new Date(now()).toISOString(), office: null, daily, hourly,
    source: {
      id: 'open-meteo', name: 'Open-Meteo', url,
      publicUrl: `https://open-meteo.com/en/docs#latitude=${latitude}&longitude=${longitude}`,
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Weather data by Open-Meteo, licensed under CC BY 4.0. Forecast values are reformatted for Farmer Daily.'
    },
    fallback: true, stale: false
  }, now());
  return { ...result, hourly: result.hourly.slice(0, 48) };
}

function createWeatherHandler({ fetchImpl = globalThis.fetch, now = Date.now, nwsTimeoutMs = 7000, backupTimeoutMs = 7000, observationTimeoutMs = 2000 } = {}) {
  const responseCache = new Map();
  const inFlight = new Map();

  async function refresh(key, latitude, longitude) {
    let payload;
    try {
      const deadlineAt = Date.now() + nwsTimeoutMs;
      payload = await withDeadline(signal => nwsForecast(fetchImpl, latitude, longitude, signal, now, observationTimeoutMs, deadlineAt), nwsTimeoutMs);
    } catch {
      try {
        payload = await withDeadline(signal => openMeteoForecast(fetchImpl, latitude, longitude, signal, now), backupTimeoutMs);
      } catch {
        const cached = responseCache.get(key);
        if (cached && now() - cached.savedAt <= STALE_TTL_MS && validForecast(cached.payload, now())) {
          return { ...currentCoverage(cached.payload, now()), stale: true };
        }
        throw new Error('Weather providers unavailable');
      }
    }
    responseCache.delete(key);
    responseCache.set(key, { savedAt: now(), payload });
    while (responseCache.size > MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value);
    return payload;
  }

  return async function weather(context, req) {
    const query = req?.query || {};
    const latitude = typeof query.lat === 'string' && query.lat.trim() ? Number(query.lat) : NaN;
    const longitude = typeof query.lon === 'string' && query.lon.trim() ? Number(query.lon) : NaN;
    if (!number(latitude) || !number(longitude) || latitude < 45.5 || latitude > 49.1 || longitude < -125 || longitude > -116.7) {
      context.res = { status: 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }, body: { error: 'Invalid Washington coordinates' } };
      return;
    }
    const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    try {
      const cached = responseCache.get(key);
      let payload;
      const refreshRequested = query.refresh === '1' && cached && now() - cached.savedAt >= MIN_REFRESH_INTERVAL_MS;
      if (cached && !refreshRequested && now() - cached.savedAt < CACHE_TTL_MS && validForecast(cached.payload, now())) {
        payload = currentCoverage(cached.payload, now());
      } else {
        if (!inFlight.has(key)) {
          const request = refresh(key, latitude, longitude).finally(() => inFlight.delete(key));
          inFlight.set(key, request);
        }
        payload = await inFlight.get(key);
      }
      context.res = {
        status: 200,
        headers: { 'Cache-Control': payload.stale ? 'no-store' : 'private, max-age=60', 'Content-Type': 'application/json' },
        body: payload
      };
    } catch {
      context.log?.warn?.('Weather providers unavailable. No farm or location information was logged.');
      context.res = {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        body: { error: 'Weather services temporarily unavailable. Please retry shortly.', retryable: true }
      };
    }
  };
}

function createProtectedWeatherHandler({ getContainer, now = Date.now, weatherHandler = createWeatherHandler({ now }) } = {}) {
  const { createAccess, HttpError, handleError } = require('../shared/access');
  const access = createAccess({ getContainer, now });
  return async function protectedWeather(context, req) {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      await access.requireAccess(req);
      await weatherHandler(context, req);
      if (context.res) context.res.headers = { ...context.res.headers, 'Cache-Control': 'no-store' };
    } catch (error) { handleError(context, error); }
  };
}

module.exports = createProtectedWeatherHandler();
module.exports.createWeatherHandler = createWeatherHandler;
module.exports.createProtectedWeatherHandler = createProtectedWeatherHandler;
module.exports.validCurrentObservation = validCurrentObservation;
