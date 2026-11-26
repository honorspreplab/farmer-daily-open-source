const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped helper bodies, not a copied implementation. They have
// no DOM dependencies; explicit TZ scopes make checks independent of the host.
const source = fs.readFileSync(path.join(__dirname, '..', 'connected-farm.js'), 'utf8');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Cannot locate ${start}`);
  return source.slice(first, last);
}
const helpers = vm.runInNewContext(`${extract('  function localDateInput(', '  function readingMetricHelp(')}
${extract('  const metrics=', '  function parseCsv(')}
({ localDateInput, readingDateToIso, validateReading });`, {
  Date,
  fields: () => [{ id: 'owned-field' }]
});
const NOW = Date.parse('2027-01-01T12:00:00Z');
function inZone(zone, callback) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return callback(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
function reading(patch = {}) {
  return { fieldId: 'owned-field', sensorId: 'Actual instrument', metric: 'rainfall', unit: 'mm', value: 0, observedAt: '2020-10-01T16:30:00.000Z', source: 'manual', ...patch };
}

test('reading date converts Los Angeles winter and summer local times to accurate UTC', () => inZone('America/Los_Angeles', () => {
  assert.equal(helpers.readingDateToIso('2026-01-10T09:30', NOW), '2026-01-10T17:30:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-10-01T09:30', NOW), '2026-10-01T16:30:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-10-01T09:30:45', NOW), '2026-10-01T16:30:45.000Z');
}));

test('reading date uses device timezone, not a hardcoded Pacific offset', () => inZone('UTC', () => {
  assert.equal(helpers.readingDateToIso('2026-10-01T09:30', NOW), '2026-10-01T09:30:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-01-10T09:30:45', NOW), '2026-01-10T09:30:45.000Z');
}));

test('reading date rejects nonexistent daylight saving spring-forward times', () => inZone('America/Los_Angeles', () => {
  assert.throws(() => helpers.readingDateToIso('2026-03-08T02:30', NOW), /daylight saving/);
  assert.equal(helpers.readingDateToIso('2026-03-08T01:59', NOW), '2026-03-08T09:59:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-03-08T03:00', NOW), '2026-03-08T10:00:00.000Z');
}));

test('reading date rejects ambiguous Los Angeles fall-back times instead of guessing the offset', () => inZone('America/Los_Angeles', () => {
  assert.throws(() => helpers.readingDateToIso('2026-11-01T01:30', NOW), /occurs twice.*CSV/);
  assert.throws(() => helpers.readingDateToIso('2026-11-01T01:59:59', NOW), /occurs twice/);
  assert.equal(helpers.readingDateToIso('2026-11-01T00:59', NOW), '2026-11-01T07:59:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-11-01T02:00', NOW), '2026-11-01T10:00:00.000Z');
}));

test('reading date detects half-hour DST transitions, not only one-hour changes', () => inZone('Australia/Lord_Howe', () => {
  assert.throws(() => helpers.readingDateToIso('2026-04-05T01:45', NOW), /occurs twice.*CSV/);
  assert.equal(helpers.readingDateToIso('2026-04-05T01:29', NOW), '2026-04-04T14:29:00.000Z');
  assert.equal(helpers.readingDateToIso('2026-04-05T02:00', NOW), '2026-04-04T15:30:00.000Z');
  assert.throws(() => helpers.readingDateToIso('2026-10-04T02:15', NOW), /daylight saving/);
  assert.equal(helpers.readingDateToIso('2026-10-04T02:30', NOW), '2026-10-03T15:30:00.000Z');
}));

test('reading date rejects blank, human text and timezone-bearing values in the local picker', () => inZone('UTC', () => {
  for (const value of ['', null, undefined, 'October 1 at 9:30', '2026-10-01', '2026-10-01T9:30', '2026-10-01T09:30Z', '2026-10-01T09:30:00-07:00']) {
    assert.throws(() => helpers.readingDateToIso(value, NOW), /Choose the date and time/, String(value));
  }
}));

test('reading date rejects impossible calendar dates and invalid clock components', () => inZone('UTC', () => {
  for (const value of ['2026-02-29T09:30', '2026-04-31T09:30', '2026-00-10T09:30', '2026-13-10T09:30', '2026-10-00T09:30', '2026-10-01T24:00', '2026-10-01T09:60', '2026-10-01T09:30:60', '1969-12-31T23:59']) {
    assert.throws(() => helpers.readingDateToIso(value, NOW), /real date and time/, value);
  }
  assert.equal(helpers.readingDateToIso('2024-02-29T09:30', NOW), '2024-02-29T09:30:00.000Z');
}));

test('reading date accepts now but rejects any future observation time', () => inZone('UTC', () => {
  const now = Date.parse('2026-10-01T09:30:00Z');
  assert.equal(helpers.readingDateToIso('2026-10-01T09:30', now), '2026-10-01T09:30:00.000Z');
  assert.throws(() => helpers.readingDateToIso('2026-10-01T09:30:01', now), /future/);
}));

test('Use current time helper produces a minute-precision local input without silently switching timezones', () => {
  inZone('America/Los_Angeles', () => {
    assert.equal(helpers.localDateInput(new Date('2026-10-01T16:05:59.123Z')), '2026-10-01T09:05');
    assert.equal(helpers.localDateInput(new Date('2026-01-10T17:05:59.123Z')), '2026-01-10T09:05');
  });
  inZone('UTC', () => assert.equal(helpers.localDateInput(new Date('2026-10-01T16:05:59.123Z')), '2026-10-01T16:05'));
});

test('real zero readings are accepted; blank, nonnumeric and out-of-range readings are rejected', () => {
  assert.equal(helpers.validateReading(reading()).value, 0);
  assert.equal(helpers.validateReading(reading({ metric: 'air_temperature', unit: 'F', value: 0 })).value, 0);
  for (const value of ['', undefined, null, '0', NaN, Infinity, -1, 2001]) {
    assert.throws(() => helpers.validateReading(reading({ value })), /must be between/, String(value));
  }
});

test('manual reading validation preserves own-field, real-date and timezone requirements', () => {
  assert.throws(() => helpers.validateReading(reading({ fieldId: 'someone-elses-field' })), /saved field/);
  assert.throws(() => helpers.validateReading(reading({ observedAt: '2020-10-01T09:30:00' })), /timezone/);
  assert.throws(() => helpers.validateReading(reading({ observedAt: '2026-02-30T09:30:00Z' })), /does not exist/);
  assert.throws(() => helpers.validateReading(reading({ observedAt: '2999-10-01T09:30:00Z' })), /between 1970 and now/);
  assert.throws(() => helpers.validateReading(reading({ metric: '__proto__' })), /allowed metric/);
  assert.throws(() => helpers.validateReading(reading({ metric: ['rainfall'] })), /allowed metric/);
});
