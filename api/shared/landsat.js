'use strict';
// NASA/USGS Landsat Collection 2 Level-2, delivered by Microsoft's public
// Planetary Computer. This is NOT the NASA HLS product or an HLS harmonization.
const { normalizeGeometry } = require('./field-geometry');
const { fieldGrid, createBudget, compareScenes } = require('./satellite-raster');
const DAY = 86400000;
const CATALOG = 'https://planetarycomputer.microsoft.com/api/stac/v1';
const TOKEN = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/landsateuwest/landsat-c2';
const SOURCE = Object.freeze({ id: 'nasa-landsat', name: 'NASA/USGS Landsat 8/9 Collection 2 Level-2 via Microsoft Planetary Computer', url: 'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-reflectance', deliveryUrl: 'https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2', attribution: 'Landsat data courtesy of the U.S. Geological Survey. Delivered by Microsoft Planetary Computer; not NASA HLS.' });
const FILES = { red: 'SR_B4', nir: 'SR_B5', qa: 'QA_PIXEL', saturation: 'QA_RADSAT' };
const KEYS = { red: 'red', nir: 'nir08', qa: 'qa_pixel', saturation: 'qa_radsat' };
const fail = message => { throw new Error(message); };
const round = (value, digits = 4) => Number(value.toFixed(digits));

function normalizeLandsatScene(item, timestamp) {
  const match = /^(LC0[89])_(L2SP|L2SR)_(\d{6})_(\d{8})_02_T1$/.exec(item?.id || '');
  if (!match || item.type !== 'Feature' || item.collection !== 'landsat-c2-l2') fail('Unsupported Landsat scene');
  const properties = item.properties || {}, time = properties.datetime, date = Date.parse(time);
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(time) || !Number.isFinite(date) || date > timestamp || date < timestamp - 120 * DAY || new Date(date).toISOString().slice(0, 10) !== time.slice(0, 10) || time.slice(0, 10).replaceAll('-', '') !== match[4]) fail('Landsat scene is outside the requested date range');
  if (properties.platform !== `landsat-${match[1].slice(-1)}` || ![32610, 32611].includes(properties['proj:epsg'])) fail('Unsupported Landsat platform or projection');
  const shape = properties['proj:shape'], transform = properties['proj:transform'];
  if (!Array.isArray(shape) || shape.length !== 2 || shape.some(n => !Number.isInteger(n) || n < 1 || n > 12000) || !Array.isArray(transform) || transform.length !== 6 || transform.some(n => !Number.isFinite(n)) || transform[0] !== 30 || transform[4] !== -30 || transform[1] !== 0 || transform[3] !== 0 || ((transform[2] % 30) + 30) % 30 !== 15 || ((transform[5] % 30) + 30) % 30 !== 15) fail('Unsupported Landsat grid');
  const assets = {};
  for (const [band, suffix] of Object.entries(FILES)) {
    const asset = item.assets?.[KEYS[band]], raster = asset?.['raster:bands'];
    let url; try { url = new URL(asset?.href); } catch { fail('Invalid Landsat asset URL'); }
    const prefix = `${match[1]}_${match[2]}_${match[3]}_${match[4]}_`;
    const escaped = new RegExp(`^/landsat-c2/level-2/standard/oli-tirs/${match[4].slice(0, 4)}/${match[3].slice(0, 3)}/${match[3].slice(3)}/(${prefix}\\d{8}_02_T1)/\\1_${suffix}\\.TIF$`);
    if (url.protocol !== 'https:' || url.hostname !== 'landsateuwest.blob.core.windows.net' || url.port || url.username || url.password || url.search || url.hash || !escaped.test(url.pathname)) fail('Invalid Landsat asset URL');
    if (!asset.type?.includes('cloud-optimized') || !Array.isArray(raster) || raster.length !== 1 || raster[0].data_type !== 'uint16' || raster[0].spatial_resolution !== 30) fail('Unsupported Landsat asset metadata');
    const reflectance = band === 'red' || band === 'nir';
    if (reflectance && (raster[0].scale !== 0.0000275 || raster[0].offset !== -0.2 || raster[0].nodata !== 0)) fail('Landsat calibration is missing');
    if (band === 'qa' && raster[0].nodata !== 1) fail('Landsat quality fill value is missing');
    assets[band] = { url: url.href, band, reflectance, shape, transform, nodata: reflectance ? 0 : band === 'qa' ? 1 : null };
  }
  const cloud = properties['eo:cloud_cover'];
  return { id: item.id, date: new Date(date).toISOString(), platform: properties.platform, epsg: properties['proj:epsg'], assets, sourceUrl: `${CATALOG}/collections/landsat-c2-l2/items/${item.id}`, catalogCloudPercent: Number.isFinite(cloud) && cloud >= 0 && cloud <= 100 ? cloud : 100 };
}

async function readLandsatBand(asset, scene, grid, budget, token) {
  const { GeoTIFF } = await import('geotiff');
  const blocks = new Map(), blockSize = 65536;
  const signedUrl = `${asset.url}?${token}`; // Never persisted, returned or logged.
  async function range(start, length) {
    const { body, response } = await budget.request(signedUrl, { headers: { Range: `bytes=${start}-${start + length - 1}`, Accept: 'image/tiff' } }, length, 206);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.get?.('content-range') || '');
    if (!match || Number(match[1]) !== start || Number(match[2]) > start + length - 1 || Number(match[2]) - start + 1 !== body.length || Number(match[3]) <= Number(match[2])) fail('Invalid Landsat range response');
    return body;
  }
  const source = { async fetch(slices) {
    if (!Array.isArray(slices) || slices.length > 32) fail('Too many Landsat byte ranges');
    return Promise.all(slices.map(async ({ offset, length }) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 2 * 1024 * 1024) fail('Invalid Landsat byte range');
      let buffer;
      if (length > blockSize) buffer = await range(offset, length);
      else {
        const buffers = [], first = Math.floor(offset / blockSize), last = Math.floor((offset + length - 1) / blockSize);
        for (let block = first; block <= last; block++) {
          if (!blocks.has(block)) blocks.set(block, range(block * blockSize, blockSize));
          buffers.push(await blocks.get(block));
        }
        buffer = Buffer.concat(buffers).subarray(offset - first * blockSize, offset - first * blockSize + length);
      }
      if (buffer.length !== length) fail('Truncated Landsat range');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }));
  } };
  const tiff = await GeoTIFF.fromSource(source, { cache: false }, budget.signal), image = await tiff.getImage();
  const keys = image.getGeoKeys(), tiepoint = image.getOrigin(), resolution = image.getResolution(), bits = image.fileDirectory.getValue('BitsPerSample'), sampleFormat = image.fileDirectory.getValue('SampleFormat');
  // Landsat COGs are PixelIsPoint: the TIFF tiepoint is the first pixel CENTER,
  // whereas STAC's affine origin denotes its outer corner. Normalize exactly.
  const origin = keys.GTRasterTypeGeoKey === 2 ? [tiepoint[0] - 15, tiepoint[1] + 15] : tiepoint;
  if (keys.ProjectedCSTypeGeoKey !== scene.epsg || ![1, 2].includes(keys.GTRasterTypeGeoKey) || image.getWidth() !== asset.shape[1] || image.getHeight() !== asset.shape[0] || image.getSamplesPerPixel() !== 1 || resolution[0] !== 30 || resolution[1] !== -30 || Math.abs(origin[0] - asset.transform[2]) > 0.001 || Math.abs(origin[1] - asset.transform[5]) > 0.001 || bits?.length !== 1 || bits[0] !== 16 || sampleFormat && (sampleFormat.length !== 1 || sampleFormat[0] !== 1) || image.getTileWidth() * image.getTileHeight() > 1024 * 1024) fail('Landsat raster disagrees with its catalog grid');
  if (asset.reflectance && image.getGDALNoData() !== 0 || asset.band === 'qa' && ![null, 1].includes(image.getGDALNoData())) fail('Landsat raster has an unsupported fill value');
  const pixelX = (grid.x - origin[0]) / 30, pixelY = (origin[1] - grid.y) / 30;
  if (!Number.isInteger(pixelX) || !Number.isInteger(pixelY) || grid.resolutionMeters !== 30) fail('Landsat grid does not align');
  const x0 = Math.max(0, pixelX), y0 = Math.max(0, pixelY), x1 = Math.min(image.getWidth(), pixelX + grid.width), y1 = Math.min(image.getHeight(), pixelY + grid.height);
  const values = new Float64Array(grid.width * grid.height); values.fill(NaN);
  if (x1 <= x0 || y1 <= y0) return values;
  const pixels = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true, signal: budget.signal });
  for (let row = 0; row < grid.height; row++) for (let col = 0; col < grid.width; col++) {
    const x = pixelX + col, y = pixelY + row;
    if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
    const value = pixels[(y - y0) * (x1 - x0) + x - x0];
    if (Number.isFinite(value) && (asset.nodata === null || value !== asset.nodata)) values[row * grid.width + col] = asset.reflectance ? value * 0.0000275 - 0.2 : value;
  }
  return values;
}

function analyzeLandsatPixels(scene, grid, bands) {
  const size = grid.width * grid.height;
  if (Object.keys(FILES).some(key => bands[key]?.length !== size)) fail('Landsat bands have different grids');
  const indices = new Float64Array(size); indices.fill(NaN);
  const values = []; let coverage = 0, cloudy = 0;
  for (let i = 0; i < size; i++) {
    if (!grid.mask[i]) continue;
    const qa = bands.qa[i], saturation = bands.saturation[i], red = bands.red[i], nir = bands.nir[i];
    if (!Number.isInteger(qa) || qa < 0 || qa > 65535 || qa & 1) continue;
    coverage++;
    if (qa & 30 || ((qa >> 8) & 3) >= 2 || ((qa >> 10) & 3) >= 2 || ((qa >> 14) & 3) >= 2) cloudy++;
    // Exclude fill, cloud buffers, cirrus, clouds, shadow, snow, water; also
    // medium/high confidence conditions, any saturation and terrain occlusion.
    if (qa & 191 || !(qa & 64) || [8, 10, 12, 14].some(shift => ((qa >> shift) & 3) >= 2) || !Number.isInteger(saturation) || saturation !== 0) continue;
    if (![red, nir].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || red + nir <= 0) continue;
    indices[i] = (nir - red) / (nir + red); values.push(indices[i]);
  }
  const clearPercent = grid.count ? round(values.length / grid.count * 100, 1) : 0, coveragePercent = grid.count ? round(coverage / grid.count * 100, 1) : 0;
  const sufficient = values.length >= 9 && clearPercent >= 70 && coveragePercent >= 90;
  values.sort((a, b) => a - b);
  return { grid, indices, summary: { date: scene.date, platform: scene.platform, ndvi: sufficient ? round(values.reduce((sum, n) => sum + n, 0) / values.length) : null, ndre: null, p10: sufficient ? round(values[Math.floor((values.length - 1) * 0.1)]) : null, p90: sufficient ? round(values[Math.floor((values.length - 1) * 0.9)]) : null, clearPercent, coveragePercent, cloudPercent: grid.count ? round(cloudy / grid.count * 100, 1) : 0, validPixels: values.length, resolutionMeters: 30, status: sufficient ? 'clear' : cloudy ? 'cloudy' : 'insufficient', confidence: sufficient ? 'medium' : 'low', sourceId: scene.id, sourceUrl: scene.sourceUrl } };
}

async function getLandsat({ field, previous, timestamp = Date.now(), fetchImpl = globalThis.fetch, timeoutMs = 24000, readBandImpl = readLandsatBand } = {}) {
  const result = { status: 'unavailable', source: SOURCE, history: [], change: { status: 'insufficient', confidence: 'low', message: 'Two recent clear Landsat observations are needed for a Landsat-only comparison.' }, problemAreas: [], resolutionMeters: 30, fetchedAt: new Date(timestamp).toISOString(), message: 'NASA/USGS Landsat observations are temporarily unavailable. No vegetation values have been estimated.' };
  const budget = createBudget({ fetchImpl, timeoutMs, maxRequests: 100, maxBytes: 16 * 1024 * 1024 });
  const json = async url => JSON.parse((await budget.request(url)).body.toString('utf8'));
  try {
    const ring = normalizeGeometry(field).boundary?.coordinates?.[0];
    if (!ring) fail('A saved field boundary is required');
    const bbox = [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))];
    const search = new URLSearchParams({ collections: 'landsat-c2-l2', bbox: bbox.join(','), datetime: `${new Date(timestamp - 90 * DAY).toISOString()}/${new Date(timestamp).toISOString()}`, limit: '24', sortby: '-datetime' });
    const catalog = await json(`${CATALOG}/search?${search}`);
    if (catalog?.type !== 'FeatureCollection' || !Array.isArray(catalog.features) || catalog.features.length > 24) fail('Invalid Landsat catalog');
    const candidates = [];
    for (const item of catalog.features) { try { candidates.push(normalizeLandsatScene(item, timestamp)); } catch {} }
    candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const newest = candidates[0]; result.latestAvailableDate = newest?.date || null;
    const preferred = [...candidates].sort((a, b) => Number(timestamp - Date.parse(b.date) <= 21 * DAY) - Number(timestamp - Date.parse(a.date) <= 21 * DAY) || a.catalogCloudPercent - b.catalogCloudPercent || Date.parse(b.date) - Date.parse(a.date));
    const scenes = [], days = new Set();
    for (const scene of newest ? [newest, ...preferred] : []) {
      if (days.has(scene.date.slice(0, 10))) continue;
      scenes.push(scene); days.add(scene.date.slice(0, 10)); if (scenes.length >= 4) break;
    }
    if (!scenes.length) { result.status = 'insufficient'; result.message = 'No supported NASA/USGS Landsat 8/9 scenes were found for this boundary in the last 90 days.'; }
    const analyzed = [];
    if (scenes.length) {
      const access = await json(TOKEN), token = access?.token;
      if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /[\r\n#?]/.test(token)) fail('Public Landsat data access unavailable');
      const permissions = new URLSearchParams(token);
      if (!['r', 'rl'].includes(permissions.get('sp')) || !permissions.get('sig') || !Number.isFinite(Date.parse(permissions.get('se'))) || Date.parse(permissions.get('se')) <= Date.now()) fail('Public Landsat data access expired');
      for (const scene of scenes) {
        try {
          const grid = fieldGrid(field, scene.epsg, 30, 15);
          const bands = Object.fromEntries(await Promise.all(Object.entries(scene.assets).map(async ([name, asset]) => [name, await readBandImpl(asset, scene, grid, budget, token)])));
          analyzed.push(analyzeLandsatPixels(scene, grid, bands));
        } catch (error) { if (/too large/.test(error.message)) { result.status = 'insufficient'; result.message = error.message; break; } }
      }
    }
    if (analyzed.length) {
      analyzed.sort((a, b) => Date.parse(a.summary.date) - Date.parse(b.summary.date));
      const clear = analyzed.filter(item => item.summary.status === 'clear'), latest = analyzed[analyzed.length - 1], latestClear = clear[clear.length - 1];
      const prior = latestClear && clear.slice(0, -1).reverse().find(item => item.grid.key === latestClear.grid.key), recent = latestClear && timestamp - Date.parse(latestClear.summary.date) <= 21 * DAY;
      result.status = recent ? 'live' : 'insufficient';
      if (recent) { const compared = compareScenes(prior, latestClear); result.change = compared.change; result.problemAreas = compared.problemAreas; result.validUntil = new Date(Math.min(timestamp + 2 * DAY, Date.parse(latestClear.summary.date) + 21 * DAY)).toISOString(); }
      const history = new Map((previous?.history || []).filter(item => /^LC0[89]_/.test(item.sourceId || '') && Date.parse(item.date) <= timestamp && timestamp - Date.parse(item.date) < 366 * DAY).map(item => [item.sourceId, item]));
      for (const item of analyzed) history.set(item.summary.sourceId, item.summary);
      result.history = [...history.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-36);
      result.message = recent ? (latest.summary.status === 'clear' ? 'NASA/USGS Landsat NDVI is calculated from clear, unsaturated land pixels inside your field. Landsat-only comparisons are kept separate from Sentinel-2; this is not a crop-health diagnosis.' : 'The newest Landsat scene is cloudy or incomplete. The most recent usable clear observation is shown with its actual date.') : 'There are not enough recent clear Landsat pixels for a reliable comparison. Dated history remains visible; no crop-health conclusion is made.';
    }
  } catch { /* Never invent measurements or use catalog cloud cover as field quality. */ }
  finally { budget.close(); }
  if (!result.history.length) result.history = (previous?.history || []).filter(item => /^LC0[89]_/.test(item.sourceId || '') && Date.parse(item.date) <= timestamp && timestamp - Date.parse(item.date) < 366 * DAY).slice(-36);
  return result;
}
module.exports = { getLandsat, normalizeLandsatScene, readLandsatBand, analyzeLandsatPixels, SOURCE, CATALOG, TOKEN };
