// Forecasts and optional station observations have distinct timestamps and labels.
let liveForecast = null;
let forecastRequest = null;
let lastForecastAttempt = 0;
const WEATHER_CACHE_KEY = 'farmerDailyForecastCacheV2';
const WEATHER_MAX_AGE = 6 * 60 * 60 * 1000;
const weatherIcon = text => /thunder/i.test(text) ? '⛈' : /snow/i.test(text) ? '❄' : /rain|shower|drizzle/i.test(text) ? '🌧' : /cloud|overcast|fog/i.test(text) ? '☁' : '☀';

function pacificDate(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function tomorrowPeriod(data, now = Date.now()) {
  const [year, month, day] = pacificDate(now).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return data?.daily?.find(period => period.isDaytime && Number.isFinite(Date.parse(period.startTime)) && pacificDate(period.startTime) === target);
}

function todayPeriod(data, now = Date.now()) {
  return data?.daily?.find(period => period.isDaytime && Number.isFinite(Date.parse(period.startTime)) &&
    pacificDate(period.startTime) === pacificDate(now) && typeof period.temperature === 'number' &&
    Number.isFinite(period.temperature) && period.temperatureUnit === 'F');
}

function weatherDateLabel(tomorrow = false, now = Date.now()) {
  const day = new Date(`${pacificDate(now)}T12:00:00Z`);
  if (tomorrow) day.setUTCDate(day.getUTCDate() + 1);
  return `${tomorrow ? 'Tomorrow' : 'Today'} · ${day.toLocaleDateString('en-US', {timeZone:'UTC',month:'short',day:'numeric'})}`;
}

function weatherTime(value) {
  return new Date(value).toLocaleString('en-US', {timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
}

function currentObservation(data, now = Date.now()) {
  const current = data?.current, station = current?.station, stamp = Date.parse(current?.observedAt);
  // Recheck cached observations at display time; a six-hour forecast is not a six-hour "now" reading.
  return current?.kind === 'observation' && current.source?.id === 'nws' && data.source?.id === 'nws' &&
    current.temperatureUnit === 'F' && typeof current.temperature === 'number' && Number.isFinite(current.temperature) &&
    current.temperature >= -130 && current.temperature <= 140 && Number.isFinite(stamp) &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(current.observedAt) && stamp <= now + 60000 && now - stamp <= 90 * 60000 &&
    /^[A-Z0-9_-]{1,32}$/i.test(station?.id || '') && typeof station?.name === 'string' && station.name.trim() && station.name.length <= 200 &&
    current.source.url === `https://api.weather.gov/stations/${station.id}/observations/latest` &&
    typeof station.distanceKm === 'number' && Number.isFinite(station.distanceKm) && station.distanceKm >= 0 && station.distanceKm <= 25 &&
    typeof station.latitude === 'number' && Number.isFinite(station.latitude) && Math.abs(station.latitude) <= 90 &&
    typeof station.longitude === 'number' && Number.isFinite(station.longitude) && Math.abs(station.longitude) <= 180 ? current : null;
}

function observationDescription(data, observed = currentObservation(data)) {
  if (!observed) return '';
  const station = observed.station, saved = data._cached || data.stale ? 'Saved observation' : 'Observed nearby';
  return `${saved}: ${Math.round(observed.temperature)}°F at ${station.name} (${station.id}), ${(station.distanceKm / 1.609344).toFixed(1)} mi from ${profile.location}. ${weatherTime(observed.observedAt)}. NOAA/NWS station reading, not a farm sensor.`;
}

function forecastHours(data, now = Date.now()) {
  return (data?.hourly || []).filter(period => typeof period.temperature === 'number' && Number.isFinite(period.temperature) && period.temperatureUnit === 'F' && Date.parse(period.endTime) > now)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

function validForecast(data, now = Date.now()) {
  const first = forecastHours(data, now)[0];
  const tomorrow = tomorrowPeriod(data, now);
  const fetched = Date.parse(data?.fetchedAt);
  return ['nws', 'open-meteo'].includes(data?.source?.id) && Number.isFinite(fetched) && fetched <= now + 60000 && now - fetched < WEATHER_MAX_AGE &&
    !!first && Date.parse(first.startTime) <= now && !!tomorrow && typeof tomorrow.temperature === 'number' && Number.isFinite(tomorrow.temperature) && tomorrow.temperatureUnit === 'F';
}

function activeForecast() {
  return liveForecast?._locationId === profile?.locationId && validForecast(liveForecast) ? liveForecast : null;
}

function forecastTimestamp(data) {
  const issued = data.updated && Number.isFinite(Date.parse(data.updated));
  const time = new Date(issued ? data.updated : data.fetchedAt).toLocaleString('en-US', {timeZone:'America/Los_Angeles', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short'});
  return `${issued ? 'Issued' : 'Retrieved'} ${time}`;
}

function forecastSourceName(data) {
  return data.source.id === 'open-meteo' ? 'Open-Meteo' : `NOAA / National Weather Service${data.office ? ` (${data.office})` : ''}`;
}

function forecastState(data) {
  return data._cached || data.stale ? 'Saved forecast' : data.fallback ? 'Backup forecast' : 'Forecast';
}

function rainText(period) {
  const value = period?.probabilityOfPrecipitation?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value}%` : null;
}

function showWeatherSources(data, place) {
  const backup = data?.source.id === 'open-meteo';
  $('#weatherSourceName').textContent = data ? forecastSourceName(data) : 'NOAA/NWS + Open-Meteo';
  $('#nwsSourceLink').href = backup ? 'https://open-meteo.com/' : `https://forecast.weather.gov/MapClick.php?lat=${place[1]}&lon=${place[2]}`;
  $('#nwsSourceLink').textContent = backup ? 'Open-Meteo ↗' : 'weather.gov ↗';
  $('#weatherLicenseLink').hidden = !backup;
  $('#tomorrowLicenseLink').hidden = !backup;
  $('#miniWeatherSource').href = $('#nwsSourceLink').href;
  $('#miniWeatherSource').textContent = backup ? 'Open-Meteo' : 'NOAA/NWS';
  $('#miniWeatherLicense').hidden = !backup;
  $('#miniWeatherSource').title = backup ? 'Weather data by Open-Meteo; units and layout adapted' : 'NOAA/National Weather Service';
  $('#tomorrowSource').textContent = data ? `${forecastState(data)} · ${forecastSourceName(data)} · ${forecastTimestamp(data)}` : 'NOAA/NWS with Open-Meteo backup';
  $('#tomorrowSourceLink').href = $('#nwsSourceLink').href;
  $('#tomorrowSourceLink').textContent = backup ? 'Weather data by Open-Meteo ↗' : 'View on weather.gov ↗';
}

function renderForecast(data, place, cached = false) {
  const hours = forecastHours(data).slice(0, 4), current = hours[0], tomorrow = tomorrowPeriod(data);
  liveForecast = {...data, _cached:cached || data.stale, _locationId:profile.locationId};
  const observed = currentObservation(liveForecast), today = todayPeriod(data);
  const state = forecastState(liveForecast), source = forecastSourceName(data), timestamp = forecastTimestamp(data);
  $('#weatherHours').innerHTML = hours.map(hour => `<span><b>${new Date(hour.startTime).toLocaleTimeString('en-US', {timeZone:'America/Los_Angeles', hour:'numeric'})}</b>${Math.round(hour.temperature)}°F</span>`).join('');
  $('.weather-mini .sun').textContent = weatherIcon(current.shortForecast);
  $('.weather-mini strong').textContent = `${Math.round(observed ? observed.temperature : current.temperature)}°F`;
  $('.weather-mini small').textContent = observed ? (liveForecast._cached ? 'Saved observation' : 'Observed nearby') : `${liveForecast._cached ? 'Saved ' : ''}Hourly estimate`;
  $('.weather-mini .sun').title = 'Hourly forecast conditions';
  $('.weather-mini .wind strong').textContent = [current.windDirection, current.windSpeed].filter(Boolean).join(' ') || '—';
  $('.weather-mini .wind strong').title = 'Hourly forecast wind, not a station measurement';
  $('#currentTemperatureNote').textContent = observed ? observationDescription(liveForecast, observed) : `Hourly estimate: ${Math.round(current.temperature)}°F near ${place[0]}. No recent nearby station reading is available. This is a forecast, not a measured temperature.`;
  $('#currentObservationLink').hidden = !observed;
  $('#currentObservationLink').href = observed ? `https://api.weather.gov/stations/${observed.station.id}/observations/latest` : 'https://www.weather.gov/';
  $('#weatherTitle').textContent = `Forecast: ${current.shortForecast} near ${place[0].replace(', WA', '')}`;
  $('#weatherCopy').textContent = `${current.detailedForecast || current.shortForecast}.${liveForecast._cached ? ' Showing saved weather while the connection recovers.' : data.fallback ? ' Your backup weather provider is supplying this forecast.' : ''}`.replace(/\.\./g, '.');
  $('#todayForecastDate').textContent = weatherDateLabel();
  $('#todayHigh').textContent = today ? `${Math.round(today.temperature)}°F` : '—';
  $('#todayHighNote').textContent = today ? 'Forecast daytime high, not a measured maximum.' : 'Today’s daytime high is unavailable; tomorrow’s high is shown separately.';
  $('#tomorrowDate').textContent = weatherDateLabel(true);
  $('#tomorrowIcon').textContent = weatherIcon(tomorrow.shortForecast);
  $('#tomorrowTitle').textContent = tomorrow.shortForecast;
  $('#tomorrowCopy').textContent = tomorrow.detailedForecast || tomorrow.shortForecast;
  $('#tomorrowHigh').textContent = `${Math.round(tomorrow.temperature)}°F`;
  $('#tomorrowRain').textContent = rainText(tomorrow) || '—';
  $('#sourceSummary').textContent = `${source} for ${place[0]} · ${state} · ${timestamp}`;
  $('#weatherSourceStatus').textContent = `${state} · ${timestamp}${data.source.id === 'open-meteo' ? ' · Units and layout adapted' : ''}`;
  $('#retryWeatherBtn').hidden = false;
  $('#retryWeatherBtn').textContent = liveForecast._cached ? 'Retry live weather ↻' : 'Refresh weather ↻';
  showWeatherSources(liveForecast, place);
}

function clearForecast(place, loading = false, signIn = false) {
  liveForecast = null;
  $('.weather-mini .sun').textContent = '◌';
  $('.weather-mini strong').textContent = '—';
  $('.weather-mini small').textContent = loading ? 'Checking weather providers' : 'Weather connection paused';
  $('.weather-mini .wind strong').textContent = '—';
  $('#currentTemperatureNote').textContent = loading ? 'Checking for a recent nearby station temperature…' : 'No recent temperature is available. Please reconnect.';
  $('#currentObservationLink').hidden = true;
  $('#todayForecastDate').textContent = weatherDateLabel();
  $('#todayHigh').textContent = '—';
  $('#todayHighNote').textContent = 'Forecast daytime high unavailable.';
  $('#tomorrowDate').textContent = weatherDateLabel(true);
  $('#weatherTitle').textContent = loading ? `Loading weather for ${place[0]}…` : 'Weather connection paused';
  $('#weatherCopy').textContent = loading ? 'Checking NOAA/NWS, with Open-Meteo available as a backup.' : signIn ? 'Sign in again to reconnect your weather. Your saved farm data stays on this device.' : 'Both weather providers could not be reached, and there is no recent saved forecast. We will retry automatically when you reconnect.';
  $('#weatherHours').innerHTML = '<span><b>NOW</b>—</span><span><b>+1 HR</b>—</span><span><b>+2 HR</b>—</span><span><b>+3 HR</b>—</span>';
  $('#tomorrowIcon').textContent = '◌';
  $('#tomorrowTitle').textContent = loading ? 'Loading tomorrow…' : 'Tomorrow’s weather is reconnecting';
  $('#tomorrowCopy').textContent = loading ? 'Fetching the forecast for your selected community.' : 'Retry or open your local weather.gov forecast below.';
  $('#tomorrowHigh').textContent = '—';
  $('#tomorrowRain').textContent = '—';
  $('#sourceSummary').textContent = `${place[0]} · NOAA/NWS with Open-Meteo backup`;
  $('#weatherSourceStatus').textContent = loading ? 'Connecting…' : 'No recent forecast available';
  $('#retryWeatherBtn').hidden = loading;
  $('#retryWeatherBtn').textContent = 'Retry weather ↻';
  showWeatherSources(null, place);
}

function readForecastCache(locationId) {
  try {
    const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || 'null');
    return cached?.locationId === locationId && validForecast(cached.data) ? cached.data : null;
  } catch { return null; }
}

async function fetchForecast(url, controller) {
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {cache:'no-store', redirect:'manual', headers:{Accept:'application/json'}, signal:controller.signal});
    if (response.type === 'opaqueredirect' || response.redirected || response.status === 401 || response.status === 403) {
      const error = new Error('Weather sign-in expired');
      error.signIn = true;
      throw error;
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Weather request unavailable');
    const data = await response.json();
    if (!validForecast(data)) throw new Error('Incomplete or expired weather response');
    return data;
  } finally { clearTimeout(timer); }
}

async function loadForecast(refresh = false) {
  if (typeof membershipAllowsCore === 'function' && !membershipAllowsCore()) return;
  const locationId = profile?.locationId, place = waLocations[locationId];
  if (!place || forecastRequest?.locationId === locationId) return;
  forecastRequest?.controller.abort();
  const request = {locationId, controller:new AbortController()};
  forecastRequest = request;
  lastForecastAttempt = Date.now();
  const cached = activeForecast() || readForecastCache(locationId);
  $('#weatherSignInLink').hidden = true;
  if (cached) renderForecast(cached, place, true);
  else clearForecast(place, true);
  $('#weatherSourceStatus').textContent += ' · Refreshing…';
  try {
    const data = await fetchForecast(`/api/weather?lat=${place[1]}&lon=${place[2]}${refresh === true ? '&refresh=1' : ''}`, request.controller);
    if (forecastRequest !== request || profile?.locationId !== locationId) return;
    renderForecast(data, place, data.stale);
    try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({locationId, data})); } catch { /* A full device cache must not hide successfully loaded weather. */ }
  } catch (error) {
    if (forecastRequest !== request || profile?.locationId !== locationId) return;
    if (cached && validForecast(cached)) renderForecast(cached, place, true);
    else clearForecast(place, false, error.signIn);
    $('#weatherSignInLink').hidden = !error.signIn;
  } finally {
    if (forecastRequest === request) forecastRequest = null;
  }
}

function weatherAnswer(tomorrow = false) {
  const data = activeForecast();
  if (!data) return `I’m reconnecting to NOAA/NWS and Open-Meteo for ${profile?.location || 'your community'}. Use Refresh weather or the local weather.gov link while the connection recovers.`;
  const period = tomorrow ? tomorrowPeriod(data) : forecastHours(data)[0];
  const temperature = `${Math.round(period.temperature)} degrees Fahrenheit`;
  const rain = rainText(period);
  const wind = period.windSpeed && period.windSpeed !== 'Unavailable' ? ` Forecast wind: ${period.windDirection || ''} ${period.windSpeed}.` : '';
  const observed = !tomorrow && currentObservation(data), today = !tomorrow && todayPeriod(data);
  const todayHigh = today ? ` ${weatherDateLabel()}: forecast daytime high ${Math.round(today.temperature)} degrees Fahrenheit.` : '';
  return `${observed ? `${observationDescription(data, observed)} ` : ''}${tomorrow ? `${weatherDateLabel(true)} near` : 'Hourly forecast estimate near'} ${profile.location}: ${period.shortForecast}, ${tomorrow ? 'with a high of ' : ''}${temperature}.${wind}${todayHigh} ${rain ? `Precipitation chance: ${rain}. ` : ''}${period.detailedForecast || ''} ${forecastState(data)} from ${forecastSourceName(data)}. ${forecastTimestamp(data)}.${data.source.id === 'open-meteo' ? ' Weather data by Open-Meteo (CC BY 4.0); units and wording adapted.' : ''}`;
}

function weatherSourcesAnswer() {
  const data = activeForecast();
  return `${data ? `This forecast comes from ${forecastSourceName(data)}. ${forecastState(data)}; ${forecastTimestamp(data)}. ${observationDescription(data)} ` : ''}For the current temperature, we try recent NOAA/NWS observations from up to three nearby stations within 25 km of your selected community; readings older than 90 minutes are excluded. Without a usable reading, we show an hourly forecast estimate. Station conditions can differ from your farm. NOAA/NWS is the primary forecast provider; Open-Meteo automatically supplies a backup when needed. Only your selected community coordinates are sent. Source and licence links appear beside the weather cards. Farmer Daily is not affiliated with or endorsed by either provider.`;
}

function spokenForecastSummary() {
  const data = activeForecast();
  if (!data) return weatherAnswer();
  const current = forecastHours(data)[0], tomorrow = tomorrowPeriod(data), today = todayPeriod(data);
  return `${forecastState(data)} from ${forecastSourceName(data)} for ${profile.location}. ${observationDescription(data)} The hourly forecast estimate is ${Math.round(current.temperature)} degrees Fahrenheit and ${current.shortForecast}.${today ? ` Today’s forecast daytime high is ${Math.round(today.temperature)} degrees Fahrenheit.` : ''} Tomorrow’s high is ${Math.round(tomorrow.temperature)} degrees Fahrenheit with ${tomorrow.shortForecast}. ${weatherDateLabel(true)}. ${forecastTimestamp(data)}.`;
}

window.addEventListener('online', () => loadForecast());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastForecastAttempt > 60000) loadForecast();
});
setInterval(() => {
  if (document.hidden || !profile?.locationId) return;
  if (liveForecast) {
    if (!activeForecast()) clearForecast(waLocations[profile.locationId]);
    else renderForecast(liveForecast, waLocations[profile.locationId], liveForecast._cached);
  }
  if (Date.now() - lastForecastAttempt >= 5 * 60 * 1000) loadForecast();
}, 60000);
