(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmerWorkPlan = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ZONE = 'America/Los_Angeles';
  const HOUR = 60 * 60 * 1000;
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const providers = {
    nws: { name: 'NOAA / National Weather Service', url: 'https://www.weather.gov/' },
    'open-meteo': { name: 'Open-Meteo', url: 'https://open-meteo.com/' }
  };

  function text(value, limit = 160) {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
      : '';
  }

  function localParts(timestamp) {
    const parts = dateFormatter.formatToParts(new Date(timestamp));
    const part = name => parts.find(item => item.type === name).value;
    return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}`, hour: Number(part('hour')), minute: Number(part('minute')) };
  }

  function nextDate(date) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  }

  function timestamp(value) {
    if (typeof value !== 'string' || !value.trim()) return NaN;
    // An explicit offset avoids interpreting provider timestamps in the device timezone.
    return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  }

  function windMph(value) {
    if (typeof value !== 'string') return null;
    if (/^calm$/i.test(value.trim())) return 0;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*(?:to|-)\s*(\d+(?:\.\d+)?))?\s*mph$/i);
    if (!match) return null;
    const low = Number(match[1]), high = Number(match[2] || match[1]);
    return high >= low && high <= 300 ? high : null;
  }

  function precipitation(period) {
    const chance = period?.probabilityOfPrecipitation?.value;
    return typeof chance === 'number' && Number.isFinite(chance) && chance >= 0 && chance <= 100 ? chance : null;
  }

  function sourceUrl(source, provider) {
    try {
      const url = new URL(source.publicUrl || provider.url);
      const hosts = source.id === 'nws' ? ['weather.gov', 'www.weather.gov', 'forecast.weather.gov'] : ['open-meteo.com', 'www.open-meteo.com'];
      if (url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname)) return url.href;
    } catch { /* Never turn unexpected source metadata into an arbitrary outgoing link. */ }
    return provider.url;
  }

  /**
   * Create a review-only inspection plan; this function never saves, executes, or approves work.
   * Fields must be saved records {id,name,crop?,stage?}. Observations use
   * {fieldId,note,createdAt}; legacy observations may identify their field by name.
   * The target must be today or tomorrow in Washington/Pacific time. Forecasts must
   * identify the selected location, be under six hours old, and have target-date periods.
   * Up to three priorities receive unique, future, one-hour slots within 08:00-17:00
   * Pacific when precipitation is known and below 50%, and known wind is below the
   * farmer's alert threshold if set. Otherwise their time is '' (review required).
   * This is not a determination that weather, field access, or any operation is safe.
   * Returns {id,createdAt,forDate,locationId,source,notices,items}; invalid required
   * input throws a user-readable Error. Stable inputs (including now) yield stable IDs.
   */
  function buildPlan({ fields, observations = [], profile, forecast, date, now = Date.now(), id } = {}) {
    const instant = now instanceof Date ? now.getTime() : now;
    if (typeof instant !== 'number' || !Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime())) throw new Error('The current time is unavailable. Check your device clock.');
    const today = localParts(instant).date;
    if (date !== today && date !== nextDate(today)) throw new Error('Choose today or tomorrow in Pacific time for the work plan.');
    const locationId = text(profile?.locationId, 100);
    if (!locationId || forecast?._locationId !== locationId) throw new Error('Refresh weather for your selected community before building a plan.');
    const sourceId = forecast?.source?.id;
    const provider = typeof sourceId === 'string' && Object.hasOwn(providers, sourceId) ? providers[sourceId] : null;
    if (!provider) throw new Error('A NOAA/NWS or Open-Meteo forecast is required. Refresh weather first.');
    const fetched = timestamp(forecast.fetchedAt);
    if (!Number.isFinite(fetched) || fetched > instant || instant - fetched >= 6 * HOUR) throw new Error('The forecast is missing, expired, or future-dated. Refresh weather before building a plan.');
    const fieldIds = new Set();
    const savedFields = (Array.isArray(fields) ? fields : []).flatMap((field, index) => {
      const fieldId = text(field?.id, 128), name = text(field?.name);
      if (!fieldId || !name || fieldIds.has(fieldId)) return [];
      fieldIds.add(fieldId);
      return [{ id: fieldId, name, crop: text(field.crop, 80), stage: text(field.stage, 80), index }];
    });
    if (!savedFields.length) throw new Error('Add at least one real field before building your work plan.');

    const periods = (Array.isArray(forecast.hourly) ? forecast.hourly : []).flatMap(period => {
      const start = timestamp(period?.startTime), end = timestamp(period?.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 2 * HOUR) return [];
      const local = localParts(start);
      return local.date === date ? [{ start, end, local, rain: precipitation(period), wind: windMph(period.windSpeed) }] : [];
    });
    if (!periods.length) throw new Error('The forecast has no hourly coverage for that day. Refresh weather or choose another day.');
    const rawThreshold = profile?.wind;
    const threshold = (typeof rawThreshold === 'number' || typeof rawThreshold === 'string') && String(rawThreshold).trim() !== '' ? Number(rawThreshold) : NaN;
    const windLimit = Number.isFinite(threshold) && threshold > 0 && threshold <= 200 ? threshold : null;
    const daytime = periods.filter(period => period.start >= instant && period.local.hour >= 8 && period.local.hour < 17 && period.local.minute === 0 && period.end >= period.start + HOUR);
    const seenHours = new Set();
    const hours = daytime.filter(period => {
      if (seenHours.has(period.local.time)) return false;
      seenHours.add(period.local.time);
      return period.rain !== null && period.rain < 50 && period.wind !== null && (windLimit === null || period.wind < windLimit);
    }).sort((a, b) => a.rain - b.rain || a.start - b.start);
    const notices = ['Review each suggestion and current field conditions before approving. Forecast-based timing is not a safety assessment or an instruction to operate equipment.'];
    if (forecast._cached || forecast.stale) notices.push('This plan uses a saved forecast less than six hours old. Refresh weather before approving if conditions have changed.');
    if (windLimit === null) notices.push('No valid personal wind alert threshold is set. Wind forecasts are shown for your review.');
    if (daytime.some(period => period.rain !== null && period.rain >= 50)) notices.push('Rain is forecast at 50% or higher during some daytime hours; those hours were not assigned.');
    if (daytime.some(period => period.rain === null || period.wind === null)) notices.push('Some daytime hours have unknown precipitation or wind. Missing values are not treated as zero, and those hours were not assigned.');
    if (windLimit !== null && daytime.some(period => period.wind !== null && period.wind >= windLimit)) notices.push(`Some daytime wind forecasts reach your ${windLimit} mph alert threshold; those hours were not assigned.`);
    if (forecast.source.id === 'open-meteo') notices.push('Weather data by Open-Meteo (CC BY 4.0); forecast values adapted into scheduling suggestions. License: https://creativecommons.org/licenses/by/4.0/.');

    const notes = (Array.isArray(observations) ? observations : []).flatMap(note => {
      const createdAt = timestamp(note?.createdAt), content = text(note?.note, 350);
      return content && Number.isFinite(createdAt) && createdAt <= instant ? [{ fieldId: text(note.fieldId, 128), field: text(note.field), note: content, createdAt }] : [];
    }).sort((a, b) => b.createdAt - a.createdAt);
    const priority = text(profile?.priorityField).toLocaleLowerCase('en-US');
    const ranked = savedFields.map(field => ({ ...field,
      priority: Boolean(priority && (field.id.toLocaleLowerCase('en-US') === priority || field.name.toLocaleLowerCase('en-US') === priority)),
      observation: notes.find(note => note.fieldId ? note.fieldId === field.id : note.field.toLocaleLowerCase('en-US') === field.name.toLocaleLowerCase('en-US'))
    })).sort((a, b) => Number(b.priority) - Number(a.priority) || (b.observation?.createdAt || 0) - (a.observation?.createdAt || 0) || a.index - b.index).slice(0, 3);
    const planId = text(id, 100).replace(/[^a-zA-Z0-9_-]/g, '') || `plan-${date}-${instant.toString(36)}`;
    if (hours.length < ranked.length) notices.push('One or more inspections remain unscheduled: there are not enough future 08:00-17:00 Pacific hours with known precipitation below 50% and wind below your threshold, if set. Review timing yourself; no nighttime work has been assigned.');
    const items = ranked.map((field, index) => {
      const hour = hours[index];
      const context = [field.crop && `Crop: ${field.crop}.`, field.stage && `Stage: ${field.stage}.`].filter(Boolean);
      if (field.priority) context.push('You marked this field as your priority.');
      if (field.observation) context.push(`Follow up on your ${localParts(field.observation.createdAt).date} observation: ${field.observation.note}`);
      const timing = hour
        ? `${provider.name} forecasts ${hour.rain}% precipitation and wind up to ${hour.wind} mph for ${hour.local.time} Pacific. This is one of the lowest-rain available daytime hours${windLimit === null ? '' : ` below your ${windLimit} mph wind alert threshold`}.`
        : 'Unscheduled: review timing and field conditions. No suitable known future daytime forecast slot remains.';
      return { id: `${planId}-item-${index + 1}`, fieldId: field.id, name: `${field.observation ? 'Follow up in' : 'Inspect'} ${field.name}`, place: [field.name, field.crop].filter(Boolean).join(' · '), date, time: hour?.local.time || '', reason: [...context, timing].join(' '), workType: 'inspection', done: false };
    });
    return { id: planId, createdAt: new Date(instant).toISOString(), forDate: date, locationId,
      source: { id: forecast.source.id, name: provider.name, url: sourceUrl(forecast.source, provider), fetchedAt: new Date(fetched).toISOString(), cached: Boolean(forecast._cached || forecast.stale) }, notices, items };
  }

  return Object.freeze({ buildPlan });
});
