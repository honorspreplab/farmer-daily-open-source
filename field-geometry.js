(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FarmerFieldGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPS = 1e-12;
  function fail(message) { throw new Error(message); }
  function coordinate(longitude, latitude) {
    if (typeof longitude !== 'number' || typeof latitude !== 'number' || !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        longitude < -125 || longitude > -116.7 || latitude < 45.5 || latitude > 49.1) fail('Choose a location within the Washington service area');
    return [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))];
  }
  function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
  function equal(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  function onSegment(a, b, p) {
    return Math.abs(cross(a, b, p)) <= EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
      p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
  }
  function intersects(a, b, c, d) {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return ((abC > EPS && abD < -EPS || abC < -EPS && abD > EPS) && (cdA > EPS && cdB < -EPS || cdA < -EPS && cdB > EPS)) ||
      onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  }
  function inside(point, ring) {
    let result = false;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i], b = ring[i + 1];
      if (onSegment(a, b, point)) return true;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  }
  function signedArea(ring) {
    // Translate before the shoelace calculation to avoid cancellation near -120 degrees.
    const origin = ring[0];
    return ring.slice(0, -1).reduce((sum, p, i) => sum + cross(origin, p, ring[i + 1]), 0) / 2;
  }
  function canonicalRing(value) {
    if (!Array.isArray(value) || value.length < 4 || value.length > 201) fail('Use a closed boundary with 3 to 200 vertices');
    let ring = value.map(point => {
      if (!Array.isArray(point) || point.length !== 2) fail('Boundary coordinates must be longitude, latitude pairs');
      return coordinate(point[0], point[1]);
    });
    if (!equal(ring[0], ring[ring.length - 1])) fail('Close the field boundary');
    const vertices = ring.slice(0, -1);
    if (new Set(vertices.map(p => p.join(','))).size !== vertices.length) fail('A boundary cannot repeat vertices');
    for (let i = 0; i < vertices.length; i += 1) {
      const previous = vertices[(i + vertices.length - 1) % vertices.length], current = vertices[i], next = vertices[(i + 1) % vertices.length];
      if (Math.abs(cross(previous, current, next)) <= EPS && (onSegment(previous, current, next) || onSegment(current, next, previous))) fail('Boundary edges cannot overlap');
      for (let j = i + 1; j < vertices.length; j += 1) {
        if (j === i + 1 || i === 0 && j === vertices.length - 1) continue;
        if (intersects(ring[i], ring[i + 1], ring[j], ring[j + 1])) fail('Boundary edges cannot intersect');
      }
    }
    const area = signedArea(ring);
    if (Math.abs(area) <= EPS) fail('Boundary must enclose an area');
    if (area < 0) vertices.reverse();
    let first = 0;
    for (let i = 1; i < vertices.length; i += 1) if (vertices[i][0] < vertices[first][0] || vertices[i][0] === vertices[first][0] && vertices[i][1] < vertices[first][1]) first = i;
    ring = [...vertices.slice(first), ...vertices.slice(0, first)];
    return [...ring, [...ring[0]]];
  }
  function representative(ring) {
    const origin = ring[0], area = signedArea(ring);
    let x = 0, y = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i], b = ring[i + 1], weight = cross(origin, a, b);
      x += (a[0] + b[0] - 2 * origin[0]) * weight;
      y += (a[1] + b[1] - 2 * origin[1]) * weight;
    }
    const centroid = coordinate(origin[0] + x / (6 * area), origin[1] + y / (6 * area));
    if (inside(centroid, ring)) return centroid;
    // Concave polygons can have an outside centroid. Pick the widest interior
    // scan-line interval between vertex latitudes, with deterministic ties.
    const latitudes = [...new Set(ring.map(p => p[1]))].sort((a, b) => a - b);
    let best = null, width = -1;
    for (let index = 1; index < latitudes.length; index += 1) {
      const latitude = (latitudes[index - 1] + latitudes[index]) / 2, crossings = [];
      for (let i = 0; i < ring.length - 1; i += 1) {
        const a = ring[i], b = ring[i + 1];
        if ((a[1] > latitude) !== (b[1] > latitude)) crossings.push(a[0] + (latitude - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) if (crossings[i + 1] - crossings[i] > width) {
        const candidate = coordinate((crossings[i] + crossings[i + 1]) / 2, latitude);
        if (inside(candidate, ring)) { best = candidate; width = crossings[i + 1] - crossings[i]; }
      }
    }
    if (!best) fail('Boundary is too narrow; use a field point instead');
    return best;
  }
  function normalizeGeometry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid field geometry');
    const boundary = value.boundary;
    if (boundary !== undefined && boundary !== null) {
      if (typeof boundary !== 'object' || boundary.type !== 'Polygon' || Object.keys(boundary).some(key => !['type', 'coordinates'].includes(key)) ||
          !Array.isArray(boundary.coordinates) || boundary.coordinates.length !== 1) fail('Use one Polygon boundary without holes');
      const ring = canonicalRing(boundary.coordinates[0]), [longitude, latitude] = representative(ring);
      if (value.location !== undefined) validateLocation(value.location);
      return { location: { latitude, longitude }, boundary: { type: 'Polygon', coordinates: [ring] } };
    }
    const [longitude, latitude] = validateLocation(value.location);
    return { location: { latitude, longitude } };
  }
  function validateLocation(location) {
    if (!location || typeof location !== 'object' || Array.isArray(location) || Object.keys(location).some(key => !['latitude', 'longitude'].includes(key))) fail('Choose a field location');
    return coordinate(location.longitude, location.latitude);
  }
  function locationKey(field) {
    if (!field || !field.location && !field.boundary) return '';
    const normalized = normalizeGeometry(field);
    return JSON.stringify(normalized);
  }
  function areaAcres(boundary) {
    const ring = normalizeGeometry({ boundary }).boundary.coordinates[0];
    const latitude = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    return Math.abs(signedArea(ring)) * 111320 * 111320 * Math.cos(latitude * Math.PI / 180) / 4046.8564224;
  }
  return { normalizeGeometry, locationKey, areaAcres };
});
