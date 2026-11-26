'use strict';
// All indices are computed from decoded L2A pixels, never catalog cloud-cover metadata.
const proj4 = require('proj4');
const { normalizeGeometry } = require('./field-geometry');
const GRID_METERS = 20, MAX_PIXELS = 25000;
const BAND_FILES = { red: 'B04', nir: 'B08', rededge1: 'B05', nir08: 'B8A', scl: 'SCL' };
function fail(message) { throw new Error(message); }
function inside(point, ring) {
  let value = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) value = !value;
  }
  return value;
}
function segmentCrosses(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const one = cross(a, b, c), two = cross(a, b, d), three = cross(c, d, a), four = cross(c, d, b);
  return one * two < 0 && three * four < 0;
}
function interiorCell(cell, boundary) {
  if (!cell.every(point => inside(point, boundary))) return false;
  for (let i = 0; i < cell.length - 1; i++) for (let j = 0; j < boundary.length - 1; j++) if (segmentCrosses(cell[i], cell[i + 1], boundary[j], boundary[j + 1])) return false;
  // Also reject a narrow notch whose vertices meet a cell edge without a strict crossing.
  if (boundary.some(point => inside(point, cell))) return false;
  return true;
}
function projection(epsg) {
  if (![32610, 32611].includes(epsg)) fail('Unsupported satellite projection');
  return proj4('EPSG:4326', `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`);
}
function fieldGrid(field, epsg, resolutionMeters = GRID_METERS, gridOffset = 0) {
  if (![20, 30].includes(resolutionMeters)) fail('Unsupported satellite analysis resolution');
  if (![0, 15].includes(gridOffset) || gridOffset === 15 && resolutionMeters !== 30) fail('Unsupported satellite grid origin');
  const boundary = normalizeGeometry(field).boundary;
  if (!boundary) fail('A saved field boundary is required');
  const transform = projection(epsg), ring = boundary.coordinates[0].map(p => transform.forward(p));
  const x = Math.floor((Math.min(...ring.map(p => p[0])) - gridOffset) / resolutionMeters) * resolutionMeters + gridOffset;
  const y = Math.ceil((Math.max(...ring.map(p => p[1])) - gridOffset) / resolutionMeters) * resolutionMeters + gridOffset;
  const width = Math.ceil((Math.max(...ring.map(p => p[0])) - x) / resolutionMeters);
  const height = Math.ceil((y - Math.min(...ring.map(p => p[1]))) / resolutionMeters);
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) fail('Boundary is too large for the bounded satellite preview; split it into smaller blocks');
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    if (inside([x + (col + 0.5) * resolutionMeters, y - (row + 0.5) * resolutionMeters], ring)) { mask[row * width + col] = 1; count++; }
  }
  return { epsg, x, y, width, height, mask, count, ring, transform, resolutionMeters, key: [epsg, x, y, width, height, resolutionMeters].join('/') };
}
function assetUrl(value, band) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'sentinel-cogs.s3.us-west-2.amazonaws.com' || url.port || url.username || url.password || url.search || url.hash) return null;
    if (!new RegExp(`^/sentinel-s2-l2a-cogs/(10|11)/[A-Z]/[A-Z]{2}/20[0-9]{2}/(?:[1-9]|1[0-2])/S2[A-C]_[A-Z0-9_]+_L2A/${BAND_FILES[band]}\\.tif$`).test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
function normalizeScene(item, timestamp) {
  if (item?.type !== 'Feature' || item.collection !== 'sentinel-2-l2a' || !/^S2[A-C]_[A-Z0-9_]+_L2A$/.test(item.id || '')) fail('Invalid satellite scene');
  const time = item.properties?.datetime, date = Date.parse(time);
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(time) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== time.slice(0, 10) || !item.id.includes(`_${time.slice(0, 10).replaceAll('-', '')}_`) || date > timestamp || date < timestamp - 120 * 86400000) fail('Satellite scene is outside the requested date range');
  const epsg = item.properties['proj:epsg']; projection(epsg);
  const assets = {};
  for (const band of Object.keys(BAND_FILES)) {
    const asset = item.assets?.[band], raster = asset?.['raster:bands'];
    const url = assetUrl(asset?.href, band), resolution = ['red', 'nir'].includes(band) ? 10 : 20;
    if (!url || !url.includes(`/${item.id}/${BAND_FILES[band]}.tif`) || !asset.type?.includes('cloud-optimized') || !Array.isArray(raster) || raster.length !== 1 || raster[0].nodata !== 0 || raster[0].spatial_resolution !== resolution || asset.gsd !== resolution || raster[0].data_type !== (band === 'scl' ? 'uint8' : 'uint16')) fail('Unsupported satellite asset');
    if (band !== 'scl' && (raster[0].scale !== 0.0001 || ![0, -0.1].includes(raster[0].offset))) fail('Satellite calibration is missing or unsupported');
    const shape = asset['proj:shape'], transform = asset['proj:transform'];
    if (!Array.isArray(shape) || shape.length !== 2 || shape.some(n => !Number.isInteger(n) || n < 1 || n > 12000) || !Array.isArray(transform) || transform.length !== 6 || transform.some(n => !Number.isFinite(n)) || transform[0] !== resolution || transform[4] !== -resolution || transform[1] !== 0 || transform[3] !== 0) fail('Unsupported satellite grid');
    assets[band] = { url, band, resolution, shape, transform, scale: raster[0].scale, offset: raster[0].offset, nodata: 0 };
  }
  const catalogCloudPercent = item.properties['eo:cloud_cover'];
  return { id: item.id, date: new Date(date).toISOString(), epsg, assets, platform: `Sentinel-2${item.id[2]}`, catalogCloudPercent: Number.isFinite(catalogCloudPercent) && catalogCloudPercent >= 0 && catalogCloudPercent <= 100 ? catalogCloudPercent : 100, sourceUrl: `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/${item.id}` };
}
async function boundedBytes(response, limit) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > limit) fail('Satellite response exceeded its byte budget');
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let count = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > limit) fail('Satellite response exceeded its byte budget'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), count);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) fail('Satellite response exceeded its byte budget');
  return buffer;
}
function createBudget({ fetchImpl = globalThis.fetch, timeoutMs = 24000, maxRequests = 160, maxBytes = 32 * 1024 * 1024 } = {}) {
  const controller = new AbortController(), end = Date.now() + timeoutMs;
  let requests = 0, bytes = 0, active = true;
  return {
    signal: controller.signal,
    async request(url, options = {}, limit = 2 * 1024 * 1024, expectedStatus) {
      if (!active || ++requests > maxRequests || Date.now() >= end || bytes >= maxBytes) fail('Satellite request budget exhausted');
      let timer;
      try {
        return await Promise.race([(async () => {
          const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
          if (!response.ok || expectedStatus && response.status !== expectedStatus) fail('Satellite provider unavailable');
          const body = await boundedBytes(response, Math.min(limit, maxBytes - bytes));
          bytes += body.length;
          if (bytes > maxBytes || !active) fail('Satellite request budget exhausted');
          return { body, response };
        })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Satellite provider timed out')); }, Math.max(1, end - Date.now())); })]);
      } finally { clearTimeout(timer); }
    },
    close() { active = false; controller.abort(); },
    stats() { return { requests, bytes }; }
  };
}
async function readBand(asset, scene, grid, budget) {
  // A custom GeoTIFF source prevents arbitrary fetches and forbids whole-file fallback.
  const { GeoTIFF } = await import('geotiff');
  const blocks = new Map(), blockSize = 65536;
  const source = {
    async fetch(slices) {
      if (!Array.isArray(slices) || slices.length > 32) fail('Too many satellite byte ranges');
      return Promise.all(slices.map(async ({ offset, length }) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 2 * 1024 * 1024) fail('Invalid satellite byte range');
        if (length > blockSize) {
          const { body, response } = await budget.request(asset.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, Accept: 'image/tiff' } }, length, 206);
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.get?.('content-range') || '');
          if (!match || Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1 || body.length !== length || Number(match[3]) <= Number(match[2])) fail('Invalid satellite range response');
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.length);
        }
        const first = Math.floor(offset / blockSize), last = Math.floor((offset + length - 1) / blockSize), buffers = [];
        for (let block = first; block <= last; block++) {
          if (!blocks.has(block)) {
            const start = block * blockSize, end = start + blockSize - 1;
            blocks.set(block, budget.request(asset.url, { headers: { Range: `bytes=${start}-${end}`, Accept: 'image/tiff' } }, blockSize, 206).then(({ body, response }) => {
              const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.get?.('content-range') || '');
              if (!match || Number(match[1]) !== start || Number(match[2]) > end || Number(match[2]) - start + 1 !== body.length || Number(match[3]) <= Number(match[2])) fail('Invalid satellite range response');
              return body;
            }));
          }
          buffers.push(await blocks.get(block));
        }
        const buffer = Buffer.concat(buffers).subarray(offset - first * blockSize, offset - first * blockSize + length);
        if (buffer.length !== length) fail('Truncated satellite range');
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      }));
    }
  };
  const tiff = await GeoTIFF.fromSource(source, { cache: false }, budget.signal), image = await tiff.getImage();
  const keys = image.getGeoKeys(), origin = image.getOrigin(), resolution = image.getResolution();
  if (keys.ProjectedCSTypeGeoKey !== scene.epsg || keys.GTRasterTypeGeoKey !== 1 || image.getWidth() !== asset.shape[1] || image.getHeight() !== asset.shape[0] || image.getSamplesPerPixel() !== 1 || resolution[0] !== asset.resolution || resolution[1] !== -asset.resolution || Math.abs(origin[0] - asset.transform[2]) > 0.001 || Math.abs(origin[1] - asset.transform[5]) > 0.001 || image.getGDALNoData() !== 0) fail('Satellite raster disagrees with its catalog grid');
  const tileWidth = image.getTileWidth(), tileHeight = image.getTileHeight();
  const bits = image.fileDirectory.getValue('BitsPerSample'), sampleFormat = image.fileDirectory.getValue('SampleFormat');
  if (tileWidth * tileHeight > 1024 * 1024 || bits?.length !== 1 || bits[0] !== (asset.band === 'scl' ? 8 : 16) || sampleFormat && (sampleFormat.length !== 1 || sampleFormat[0] !== 1)) fail('Satellite raster tile is too large or has unsupported sample types');
  const pixelX = (grid.x - origin[0]) / asset.resolution, pixelY = (origin[1] - grid.y) / asset.resolution, factor = GRID_METERS / asset.resolution;
  if (!Number.isInteger(pixelX) || !Number.isInteger(pixelY)) fail('Satellite grids do not align');
  const x0 = Math.max(0, pixelX), y0 = Math.max(0, pixelY), x1 = Math.min(image.getWidth(), pixelX + grid.width * factor), y1 = Math.min(image.getHeight(), pixelY + grid.height * factor);
  const result = new Float64Array(grid.width * grid.height); result.fill(NaN);
  if (x1 <= x0 || y1 <= y0) return result;
  const raster = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true, signal: budget.signal });
  for (let row = 0; row < grid.height; row++) for (let col = 0; col < grid.width; col++) {
    const x = pixelX + col * factor, y = pixelY + row * factor;
    if (x < x0 || y < y0 || x + factor > x1 || y + factor > y1) continue;
    let total = 0, valid = true;
    // Average all four 10m reflectance samples into the exact shared 20m cell.
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const raw = raster[(y + dy - y0) * (x1 - x0) + x + dx - x0];
      if (!Number.isFinite(raw) || raw === asset.nodata) valid = false;
      total += asset.band === 'scl' ? raw : raw * asset.scale + asset.offset;
    }
    if (valid) result[row * grid.width + col] = total / (factor * factor);
  }
  blocks.clear();
  return result;
}
function round(value, digits = 4) { return Number(value.toFixed(digits)); }
function stats(values) {
  if (!values.length) return { mean: null, p10: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: round(values.reduce((sum, n) => sum + n, 0) / values.length), p10: round(sorted[Math.floor((sorted.length - 1) * 0.1)]), p90: round(sorted[Math.floor((sorted.length - 1) * 0.9)]) };
}
function analyzePixels(scene, grid, bands) {
  const size = grid.width * grid.height;
  if (Object.keys(BAND_FILES).some(key => !bands[key] || bands[key].length !== size)) fail('Satellite bands have different grids');
  const indices = new Float64Array(size); indices.fill(NaN);
  const ndvi = [], ndre = []; let coverage = 0, clouds = 0;
  for (let i = 0; i < size; i++) {
    if (!grid.mask[i]) continue;
    const scl = bands.scl[i];
    if (Number.isInteger(scl) && scl >= 1 && scl <= 11) coverage++;
    if ([3, 8, 9, 10].includes(scl)) clouds++;
    // Unknown, shadows, water, snow, saturated and unclassified pixels are excluded.
    if (![4, 5].includes(scl)) continue;
    const values = ['red', 'nir', 'rededge1', 'nir08'].map(key => bands[key][i]);
    if (values.some(n => !Number.isFinite(n) || n < 0 || n > 1.5)) continue;
    const [red, nir, edge, narrowNir] = values;
    if (nir + red <= 0 || narrowNir + edge <= 0) continue;
    const vegetation = (nir - red) / (nir + red), redEdge = (narrowNir - edge) / (narrowNir + edge);
    indices[i] = vegetation; ndvi.push(vegetation); ndre.push(redEdge);
  }
  const clearPercent = grid.count ? round(ndvi.length / grid.count * 100, 1) : 0, coveragePercent = grid.count ? round(coverage / grid.count * 100, 1) : 0;
  const sufficient = ndvi.length >= 9 && clearPercent >= 70 && coveragePercent >= 90;
  const vegetation = stats(ndvi), edge = stats(ndre);
  return { grid, indices, summary: { date: scene.date, ndvi: sufficient ? vegetation.mean : null, ndre: sufficient ? edge.mean : null, p10: sufficient ? vegetation.p10 : null, p90: sufficient ? vegetation.p90 : null,
    clearPercent, coveragePercent, cloudPercent: grid.count ? round(clouds / grid.count * 100, 1) : 0, validPixels: ndvi.length, resolutionMeters: GRID_METERS,
    status: sufficient ? 'clear' : clouds ? 'cloudy' : 'insufficient', confidence: sufficient ? 'medium' : 'low', sourceId: scene.id, sourceUrl: scene.sourceUrl, sourceName: 'Copernicus Sentinel-2 L2A', platform: scene.platform } };
}
function compareScenes(previous, current) {
  const empty = { change: { status: 'insufficient', confidence: 'low', message: 'Two recent clear images on the same grid are needed for a comparison.' }, problemAreas: [] };
  if (!previous || !current || previous.summary.status !== 'clear' || current.summary.status !== 'clear' || previous.grid.key !== current.grid.key || Date.parse(current.summary.date) - Date.parse(previous.summary.date) > 35 * 86400000 || Date.parse(current.summary.date) <= Date.parse(previous.summary.date)) return empty;
  const before = [], after = [], changes = [], cells = [], grid = current.grid, resolutionMeters = grid.resolutionMeters || GRID_METERS;
  for (let i = 0; i < current.indices.length; i++) if (grid.mask[i] && Number.isFinite(previous.indices[i]) && Number.isFinite(current.indices[i])) { before.push(previous.indices[i]); after.push(current.indices[i]); changes.push(current.indices[i] - previous.indices[i]); cells.push(i); }
  if (cells.length < 9 || cells.length / grid.count < 0.7) return empty;
  const older = stats(before).mean, newer = stats(after).mean, delta = round(newer - older);
  const flagged = cells.filter(i => current.indices[i] - previous.indices[i] <= -0.1 && current.indices[i] <= newer - 0.1), problemAreas = [];
  // Only complete interior cells are drawn, preventing an overlay outside the farmer's polygon.
  for (const i of flagged.slice(0, 128)) {
    const col = i % grid.width, row = Math.floor(i / grid.width), x = grid.x + col * resolutionMeters, y = grid.y - row * resolutionMeters;
    const ring = [[x, y], [x + resolutionMeters, y], [x + resolutionMeters, y - resolutionMeters], [x, y - resolutionMeters], [x, y]];
    if (!interiorCell(ring, grid.ring)) continue;
    problemAreas.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring.map(p => grid.transform.inverse(p).map(n => round(n, 7)))] }, properties: { kind: 'scout', ndviDelta: round(current.indices[i] - previous.indices[i]), areaAcres: round(resolutionMeters ** 2 / 4046.8564224, 3) } });
  }
  const detected = delta <= -0.08 || flagged.length >= 3;
  return { change: { status: detected ? 'detected' : 'stable', previousDate: previous.summary.date, currentDate: current.summary.date, ndviDelta: delta, ndviPercent: Math.abs(older) >= 0.1 ? round(delta / Math.abs(older) * 100, 1) : null, matchedPixels: cells.length, matchedPercent: round(cells.length / grid.count * 100, 1), confidence: 'medium', affectedAreaAcres: round(flagged.length * resolutionMeters ** 2 / 4046.8564224, 2), overlayTruncated: flagged.length > 128,
    message: detected ? 'The vegetation signal declined. Scout the highlighted area and compare with harvest, irrigation and field notes. Imagery cannot diagnose a disease or its cause.' : 'No decline crossed the scouting threshold in the shared clear pixels. This is not a crop-health diagnosis.' }, problemAreas };
}
module.exports = { GRID_METERS, MAX_PIXELS, fieldGrid, assetUrl, normalizeScene, createBudget, readBand, analyzePixels, compareScenes, inside, interiorCell, boundedBytes };
