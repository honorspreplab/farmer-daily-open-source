const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichFieldBrief, selectIntelligenceFields, MAX_CONTEXT_FIELDS } = require('../api/shared/context-advisories');
const { SOURCES, TTL } = require('../api/shared/context-providers');
const { locationKey, normalizeGeometry } = require('../api/shared/field-geometry');
const NOW = Date.parse('2026-10-07T18:00:00Z'), DAY = 86400000;
const iso = value => new Date(value).toISOString();
const field = { id: 'orchard', name: 'Orchard A', crop: 'Apples', marketReportId: 1234, dataConsent: true, contextConsent: true, satelliteConsent: true,
  ...normalizeGeometry({ boundary: { type: 'Polygon', coordinates: [[[-120.36, 47.35], [-120.359, 47.35], [-120.359, 47.351], [-120.36, 47.351], [-120.36, 47.35]]] } }) };
function part(kind, data, changes = {}) { return { status: 'ready', source: SOURCES[kind], fetchedAt: iso(NOW), validUntil: iso(NOW + TTL[kind]), data, ...changes }; }
function context(parts = {}) { return { fieldId: field.id, locationKey: locationKey(field), ...parts }; }
function air() { return part('air', { observations: [{ pollutant: 'PM2.5', aqi: 165, observedAt: iso(NOW - 3600000), reportingArea: 'Yakima', category: 'Unhealthy' }] }); }
function soil() { return part('soil', { mapUnits: [{ name: 'Mapped loam', components: [] }] }); }
function water() { return part('water', { year: 2026, areas: [{ watershed: 'Yakima', status: 'Drought Emergency Declaration Area' }] }); }
function market() { return part('markets', { reportId: 1234, items: [{ date: '2026-10-06', priceLow: 12, priceHigh: 18, unit: 'carton' }] }); }
function satellite() { return { fieldId: field.id, locationKey: locationKey(field), status: 'cached', source: { id: 'sentinel-2' }, fetchedAt: iso(NOW), validUntil: iso(NOW + 2 * DAY),
  history: [{ date: iso(NOW - 6 * DAY), status: 'clear', ndvi: 0.7, clearPercent: 100, coveragePercent: 100 }, { date: iso(NOW - DAY), status: 'clear', ndvi: 0.5, clearPercent: 100, coveragePercent: 100 }],
  change: { status: 'detected', previousDate: iso(NOW - 6 * DAY), currentDate: iso(NOW - DAY), ndviDelta: -0.2, ndviPercent: -28.6, matchedPixels: 100, matchedPercent: 100, confidence: 'medium', affectedAreaAcres: 2 }, problemAreas: [] }; }
function base(advisories) { return { language: 'en', advisories: advisories || [{ id: 'condition', fieldId: field.id, fieldName: field.name, kind: 'conditions', title: 'Review weather', whatChanged: 'Weather unchanged' }], coverage: { notices: [] } }; }
function build({ farmContexts = [], satelliteContexts = [], fields = [field], contextFields = [field], satelliteFields = [], brief = base(), ...other } = {}) {
  return enrichFieldBrief(brief, { profile: { firstName: 'Sam', farmName: 'Sunrise' }, fields, farmContexts, satelliteContexts, contextFields, satelliteFields, timestamp: NOW, ...other });
}
test('Phase2/3 selectors cap three fields independently of weather permission and require actual boundary for imagery', () => {
  const fields = Array.from({ length: 7 }, (_, index) => ({ ...field, dataConsent: false, id: `field-${index}`, name: `Block ${index}` }));
  const tasks = [{ fieldId: 'field-5', done: false }], profile = { priorityField: 'Block 6' };
  const selected = selectIntelligenceFields(fields, tasks, profile, 'contextConsent');
  assert.equal(MAX_CONTEXT_FIELDS, 3); assert.deepEqual(selected.map(item => item.id), ['field-6', 'field-5', 'field-0']);
  assert.deepEqual(selectIntelligenceFields(fields.map(item => ({ ...item, boundary: undefined })), tasks, profile, 'satelliteConsent'), []);
  assert.deepEqual(selectIntelligenceFields(fields.map(item => ({ ...item, contextConsent: false })), tasks, profile), []);
});
test('official alerts outrank air and satellite while output stays at three short, sourced priorities', () => {
  const brief = base([{ id: 'warning', fieldId: field.id, fieldName: field.name, kind: 'alert-0', title: 'Official NWS warning', whatChanged: 'Official alert active' }, ...base().advisories]);
  const result = build({ brief, farmContexts: [context({ air: air(), water: water() })], satelliteContexts: [satellite()], satelliteFields: [field] });
  assert.deepEqual(result.advisories.map(item => item.kind), ['alert-0', 'air-awareness', 'satellite-scout']); assert.equal(result.items.length, 3);
  for (const advisory of result.advisories.slice(1)) for (const key of ['whatChanged', 'whyItMatters', 'suggestedAction', 'validUntil', 'confidence', 'sources', 'followUp']) assert.ok(advisory[key], key);
  assert.match(result.advisories[1].whyItMatters, /preliminary/); assert.match(result.advisories[1].whyItMatters, /does not establish worker-safety compliance/);
  assert.match(result.advisories[2].whyItMatters, /not proof of disease/); assert.match(result.advisories[2].suggestedAction, /before deciding on any treatment/);
  assert.equal(result.advisories[2].sources[0].attribution, 'Contains modified Copernicus Sentinel data 2026');
});
test('current soil, chosen market, and regional drought are context rather than field measurements or allocations', () => {
  const result = build({ farmContexts: [context({ soil: soil(), markets: market(), water: water() })] });
  assert.deepEqual(result.advisories.map(item => item.kind), ['regional-drought', 'market-report', 'soil-context']);
  assert.match(result.advisories[0].whyItMatters, /does not reveal your water right/);
  assert.match(result.advisories[1].whyItMatters, /no like-for-like price movement/);
  assert.match(result.advisories[2].whatChanged, /representative point/); assert.match(result.advisories[2].whyItMatters, /cannot establish soil conditions across the field/);
  assert.ok(!result.items.join(' ').includes('70% of your water'));
});
test('only a newer exact selected market report date is a report change, never an inferred price delta', () => {
  const previousBrief = { contextSummaries: [{ fieldId: field.id, locationKey: locationKey(field), market: { reportId: 1234, date: '2026-10-01' } }] };
  const result = build({ farmContexts: [context({ markets: market() })], previousBrief });
  assert.equal(result.advisories[0].title, 'New selected market report'); assert.match(result.advisories[0].whatChanged, /newer than your saved report/);
  const different = market(); different.data.reportId = 4321;
  assert.ok(build({ farmContexts: [context({ markets: different })], previousBrief }).advisories.every(item => item.kind !== 'market-report'));
  for (const date of ['2026-08-01', '2026-10-08', 'invalid']) { const invalid = market(); invalid.data.items[0].date = date; assert.ok(build({ farmContexts: [context({ markets: invalid })] }).advisories.every(item => item.kind !== 'market-report')); }
});
test('stale/future/source-mismatched context, expired validity and revoked consent never generate source advice', () => {
  for (const change of [{ status: 'unavailable' }, { fetchedAt: iso(NOW + 1) }, { fetchedAt: iso(NOW - TTL.air) }, { validUntil: iso(NOW) }, { validUntil: iso(NOW + TTL.air * 2) }, { source: { id: 'unknown-provider' } }]) {
    assert.ok(build({ farmContexts: [context({ air: { ...air(), ...change } })] }).advisories.every(item => item.kind !== 'air-awareness'));
  }
  for (const observedAt of [iso(NOW + 1), iso(NOW - 4 * 3600000), 'invalid']) { const invalid = air(); invalid.data.observations[0].observedAt = observedAt; assert.ok(build({ farmContexts: [context({ air: invalid })] }).advisories.every(item => item.kind !== 'air-awareness')); }
  const wrong = context({ air: air() }); wrong.locationKey = 'other-farm';
  assert.ok(build({ farmContexts: [wrong] }).advisories.every(item => item.kind !== 'air-awareness'));
  assert.ok(build({ fields: [{ ...field, contextConsent: false }], farmContexts: [context({ air: air() })] }).advisories.every(item => item.kind !== 'air-awareness'));
});
test('old water years and USDA regional statistics do not become field-specific agronomic advice', () => {
  const old = water(); old.data.year = 2025;
  const result = build({ farmContexts: [context({ water: old, statistics: part('statistics', { rows: [{ year: 2025, description: 'WASHINGTON APPLE YIELD', value: 34 }] }) })] });
  assert.ok(result.advisories.every(item => !['regional-drought', 'statistics', 'yield', 'harvest'].includes(item.kind)));
  assert.match(result.explanation, /NASS.*background context/);
});
test('satellite advice ignores missing evidence, wrong field, stale/future acquisitions and invalid comparisons', () => {
  const mutations = [data => { data.status = 'insufficient'; }, data => { data.locationKey = 'other'; }, data => { data.fetchedAt = iso(NOW - 2 * DAY); }, data => { data.fetchedAt = iso(NOW + 1); }, data => { data.change.currentDate = iso(NOW + 1); }, data => { data.change.currentDate = iso(NOW - 22 * DAY); }, data => { data.change.previousDate = data.change.currentDate; }, data => { data.change.matchedPercent = 69; }, data => { data.change.matchedPixels = 8; }, data => { data.change.ndviDelta = NaN; }, data => { data.validUntil = iso(NOW - 1); }, data => { data.history = []; }];
  for (const mutate of mutations) { const data = satellite(); mutate(data); assert.ok(build({ contextFields: [], satelliteFields: [field], satelliteContexts: [data] }).advisories.every(item => item.kind !== 'satellite-scout'), mutate.toString()); }
  assert.ok(build({ fields: [{ ...field, satelliteConsent: false }], contextFields: [], satelliteFields: [field], satelliteContexts: [satellite()] }).advisories.every(item => item.kind !== 'satellite-scout'));
});
test('Spanish context keeps uncertainty, regional scope and treatment caution visible', () => {
  const result = build({ brief: { ...base(), language: 'es' }, farmContexts: [context({ air: air() })], satelliteFields: [field], satelliteContexts: [satellite()] });
  assert.equal(result.advisories[0].title, 'Revise la calidad del aire regional'); assert.match(result.advisories[0].whyItMatters, /preliminares/);
  assert.match(result.advisories.find(item => item.kind === 'satellite-scout').suggestedAction, /antes de decidir tratamientos/);
  assert.match(result.summary, /prioridades para revisar/);
});
test('no opted-in context returns the original working brief unchanged', () => {
  const brief = base(); assert.equal(enrichFieldBrief(brief, { fields: [field], timestamp: NOW }), brief);
});
test('NASA-only permission selects the field and supports a separately attributed Landsat advisory', () => {
  const selected = { ...field, satelliteConsent: false, landsatConsent: true }, landsat = { ...satellite(), source: { id: 'nasa-landsat' }, resolutionMeters: 30 };
  assert.deepEqual(selectIntelligenceFields([selected], [], {}, 'satelliteConsent'), [selected]);
  const result = build({ fields: [selected], contextFields: [], satelliteFields: [selected], satelliteContexts: [{ ...satellite(), status: 'not_selected', history: [], landsat }] });
  const advice = result.advisories.find(item => item.kind === 'satellite-scout'); assert.ok(advice);
  assert.match(advice.sources[0].name, /NASA\/USGS Landsat/); assert.match(advice.sources[0].name, /Microsoft/);
  assert.doesNotMatch(advice.sources[0].attribution, /Copernicus/);
});
test('dual-source evidence yields at most one source-specific scouting priority and never combines histories', () => {
  const selected = { ...field, landsatConsent: true }, data = satellite();
  data.landsat = { ...satellite(), source: { id: 'nasa-landsat' } };
  const run = value => build({ fields: [selected], contextFields: [], satelliteFields: [selected], satelliteContexts: [value] }).advisories.filter(item => item.kind === 'satellite-scout');
  assert.equal(run(data).length, 1);
  data.history = [data.history[0]]; data.landsat.history = [data.landsat.history[1]]; assert.equal(run(data).length, 0);
});
test('Landsat advisories reject stale, future, insufficient, untrusted and revoked evidence', () => {
  const selected = { ...field, satelliteConsent: false, landsatConsent: true };
  for (const mutate of [part => { part.status = 'insufficient'; }, part => { part.change.currentDate = iso(NOW + 1); }, part => { part.fetchedAt = iso(NOW + 1); }, part => { part.change.currentDate = iso(NOW - 22 * DAY); }, part => { part.validUntil = iso(NOW - 1); }, part => { part.history = []; }, part => { part.source.id = 'unexpected'; }, part => { part.locationKey = 'other-field'; }]) {
    const data = satellite(); data.landsat = { ...satellite(), source: { id: 'nasa-landsat' } }; mutate(data.landsat);
    assert.ok(build({ fields: [selected], contextFields: [], satelliteFields: [selected], satelliteContexts: [data] }).advisories.every(item => item.kind !== 'satellite-scout'), mutate.toString());
  }
  const revoked = { ...selected, landsatConsent: false }, data = { ...satellite(), landsat: { ...satellite(), source: { id: 'nasa-landsat' } } };
  assert.deepEqual(selectIntelligenceFields([revoked], [], {}, 'satelliteConsent'), []);
  assert.ok(build({ fields: [revoked], contextFields: [], satelliteFields: [revoked], satelliteContexts: [data] }).advisories.every(item => item.kind !== 'satellite-scout'));
});
