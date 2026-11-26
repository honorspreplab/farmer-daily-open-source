const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const geometry = require('../api/shared/field-geometry');
const polygon = points => ({ type: 'Polygon', coordinates: [points] });
const square = polygon([[-122.01, 47], [-122, 47], [-122, 47.01], [-122.01, 47.01], [-122.01, 47]]);

test('field geometry has the same browser and server exports and rounds points deterministically', () => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/shared/field-geometry'), 'utf8'), scope);
  assert.equal(typeof scope.FarmerFieldGeometry.normalizeGeometry, 'function');
  const point = { location: { latitude: 47.12345678, longitude: -122.76543219 } };
  assert.deepEqual(geometry.normalizeGeometry(point), { location: { latitude: 47.123457, longitude: -122.765432 } });
  assert.equal(scope.FarmerFieldGeometry.locationKey(point), geometry.locationKey(point));
});

test('polygon representative point, canonical boundary and approximate area are deterministic', () => {
  const normalized = geometry.normalizeGeometry({ boundary: square, location: { latitude: 48, longitude: -123 } });
  assert.deepEqual(normalized.location, { latitude: 47.005, longitude: -122.005 });
  const reversed = polygon([...square.coordinates[0]].reverse());
  const rotated = polygon([[-122, 47.01], [-122.01, 47.01], [-122.01, 47], [-122, 47], [-122, 47.01]]);
  assert.equal(geometry.locationKey({ boundary: square }), geometry.locationKey({ boundary: reversed }));
  assert.equal(geometry.locationKey({ boundary: square }), geometry.locationKey({ boundary: rotated }));
  assert.ok(geometry.areaAcres(square) > 200 && geometry.areaAcres(square) < 215);
  assert.equal(geometry.locationKey({ id: 'legacy' }), '');
});

test('concave boundary uses an interior point when its centroid is outside', () => {
  const boundary = polygon([[-122,47],[-121.97,47],[-121.97,47.03],[-121.98,47.03],[-121.98,47.01],[-121.99,47.01],[-121.99,47.03],[-122,47.03],[-122,47]]);
  const { location } = geometry.normalizeGeometry({ boundary });
  assert.ok(location.latitude < 47.01 || location.longitude <= -121.99 || location.longitude >= -121.98);
  assert.equal(geometry.locationKey({ boundary }), geometry.locationKey({ boundary }));
});

test('invalid, active, huge, degenerate and self-intersecting geometry is rejected', () => {
  const invalid = [null, {}, { location: { latitude: '47', longitude: -122 } }, { location: { latitude: 45, longitude: -122 } },
    { location: { latitude: 47, longitude: -126 } }, { location: { latitude: 47, longitude: -122, url: 'https://example.test' } },
    { boundary: { type: 'MultiPolygon', coordinates: [square.coordinates] } }, { boundary: { ...square, coordinates: [...square.coordinates, square.coordinates[0]] } },
    { boundary: { ...square, url: 'https://example.test' } }, { boundary: polygon([[-122,47],[-121,48],[-122,48],[-121,47],[-122,47]]) },
    { boundary: polygon([[-122,47],[-121,47],[-120,47],[-122,47]]) }, { boundary: polygon([[-122,47],[-121,47],[-121,48]]) },
    { boundary: polygon([[-122,47],[-121,47],[-121,48],[-121,47],[-122,47]]) },
    { boundary: polygon(Array.from({length:202},()=>[-122,47])) }, { boundary: polygon([[-122,47,1],[-121,47],[-121,48],[-122,47,1]]) }];
  for (const value of invalid) assert.throws(() => geometry.normalizeGeometry(value), undefined, JSON.stringify(value));
});
