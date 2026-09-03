/**
 * Digital elevation model from Terrarium tiles (AWS Open Data, no key required).
 *
 * Terrain matters acoustically: a slope changes the source-receiver geometry and
 * an embankment screens sound much like a building. Central Moscow is not flat —
 * the Moskva valley gives ~50 m of relief across a 1.7 km square.
 *
 * Elevation is encoded in the pixel: (R * 256 + G + B / 256) - 32768 metres.
 */
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
// Imported for the proxy dispatcher it installs as a side effect — Node's fetch
// ignores HTTPS_PROXY without it — and for `backoffDelay`, the same jittered
// ladder the Overpass loop climbs. A tile has no second mirror to fall back on,
// but the reason for spreading retries out rather than hammering is the same.
import { backoffDelay } from './lib.mjs';

const TILE_SIZE = 256;
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/**
 * What a status from the tile bucket means for a retry loop.
 *
 * Unlike Overpass there is nowhere else to ask, so the only question is whether
 * asking again could change the answer. A 404 is the bucket saying this tile
 * does not exist, which stays true on the tenth attempt; 429 and the 5xx family
 * are it saying "not now".
 */
export function tileVerdict(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'retry';
  return 'gone';
}

/**
 * One Terrarium tile, retried.
 *
 * This was a single bare `fetch`, and on a development host that was enough:
 * DNS there does not blink. Inside a container it does — one `ENOTFOUND` in six
 * consecutive lookups, measured — and because the tiles are gathered with one
 * `Promise.all`, a single failed lookup took the whole job down with it, after
 * Overpass had already spent its megabytes and its half-minute.
 *
 * The ladder is deliberately much shorter than the Overpass one, 300 ms against
 * 5 s: a tile is a couple of hundred kilobytes off a CDN, a handful of them
 * stand between the caller and the first stage of the calculation, and four
 * attempts spread over about two seconds are free against a job that costs
 * minutes. What is not free is retrying something that cannot succeed, which is
 * what `tileVerdict` is for.
 *
 * A decode failure is retried too, on purpose: a truncated body from a
 * connection that dropped mid-download reads as a corrupt PNG, and that is
 * exactly the case a second attempt fixes.
 *
 * The network, the sleep and the randomness come from the caller for the same
 * reason they do in `overpassFetch` — a test that needs a real resolver to fail
 * on cue is not a test.
 */
export async function fetchTile(
  z,
  x,
  y,
  {
    attempts = 4,
    timeoutMs = 60_000,
    fetchImpl = fetch,
    sleepImpl = sleep,
    random = Math.random,
    log = console.warn,
  } = {},
) {
  const label = `тайл ${z}/${x}/${y}`;
  let problem = 'не начиналось';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let fatal = false;
    try {
      const res = await fetchImpl(`${TILE_URL}/${z}/${x}/${y}.png`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const verdict = tileVerdict(res.status);
      if (verdict === 'ok') return PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      problem = `HTTP ${res.status}`;
      fatal = verdict === 'gone';
    } catch (err) {
      // Node's fetch reduces every network problem to a bare "fetch failed";
      // the code that says which one — EAI_AGAIN, ECONNRESET — sits one level
      // deeper in err.cause, and it is the only part worth reading in a log.
      problem = `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;
    }

    if (fatal) throw new Error(`${label}: ${problem}`);
    if (attempt < attempts) {
      const wait = backoffDelay(attempt, { base: 300, cap: 5000, random });
      log(`  ${label}: ${problem}, повтор ${attempt + 1}/${attempts} через ${wait} мс`);
      await sleepImpl(wait);
    }
  }

  throw new Error(`${label}: ${problem}, попыток ${attempts}`);
}

/**
 * Samples elevation onto a regular lon/lat grid and writes an ESRI ASCII raster.
 *
 * The grid is regular in degrees, so its cells are not square on the ground —
 * harmless here, because NoiseModelling turns the raster into a point cloud and
 * reprojects each point individually.
 */
export async function writeDemAsc(
  bbox,
  outPath,
  { zoom = 12, cellsize = 0.00025, tile = {} } = {},
) {
  const { south, west, north, east } = bbox;

  const minTileX = Math.floor(lonToTileX(west, zoom));
  const maxTileX = Math.floor(lonToTileX(east, zoom));
  const minTileY = Math.floor(latToTileY(north, zoom));
  const maxTileY = Math.floor(latToTileY(south, zoom));

  // Tiles do not depend on each other, and the wait is almost all latency:
  // fetched one after another they add up, fetched together they overlap. The
  // count is small by construction — a 750 m disc at zoom 12 is a handful — so
  // there is nothing here to throttle.
  const wanted = [];
  for (let x = minTileX; x <= maxTileX; x++) {
    for (let y = minTileY; y <= maxTileY; y++) wanted.push([x, y]);
  }
  const fetched = await Promise.all(wanted.map(([x, y]) => fetchTile(zoom, x, y, tile)));
  const tiles = new Map(wanted.map(([x, y], i) => [`${x}/${y}`, fetched[i]]));

  const cols = Math.max(2, Math.ceil((east - west) / cellsize));
  const rows = Math.max(2, Math.ceil((north - south) / cellsize));

  const sample = (lon, lat) => {
    const fx = lonToTileX(lon, zoom);
    const fy = latToTileY(lat, zoom);
    const tile = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!tile) return -9999;

    const px = Math.min(TILE_SIZE - 1, Math.floor((fx - Math.floor(fx)) * TILE_SIZE));
    const py = Math.min(TILE_SIZE - 1, Math.floor((fy - Math.floor(fy)) * TILE_SIZE));
    const idx = (tile.width * py + px) << 2;
    const [r, g, b] = [tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]];
    return r * 256 + g + b / 256 - 32768;
  };

  // ESRI ASCII rasters are written top row first.
  const lines = [
    `ncols ${cols}`,
    `nrows ${rows}`,
    `xllcorner ${west}`,
    `yllcorner ${south}`,
    `cellsize ${cellsize}`,
    'NODATA_value -9999',
  ];

  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < rows; row++) {
    const lat = south + (rows - 1 - row) * cellsize;
    const values = new Array(cols);
    for (let col = 0; col < cols; col++) {
      const elevation = sample(west + col * cellsize, lat);
      if (elevation > -9999) {
        min = Math.min(min, elevation);
        max = Math.max(max, elevation);
      }
      values[col] = elevation.toFixed(1);
    }
    lines.push(values.join(' '));
  }

  await writeFile(outPath, lines.join('\n'), 'utf8');
  return { path: outPath, cols, rows, points: cols * rows, tiles: tiles.size, min, max };
}
