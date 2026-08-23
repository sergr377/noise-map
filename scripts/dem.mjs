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
// Imported for the side effect: it installs the proxy dispatcher that Node's
// fetch otherwise ignores.
import './lib.mjs';

const TILE_SIZE = 256;
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

async function fetchTile(z, x, y) {
  const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`тайл ${z}/${x}/${y}: HTTP ${res.status}`);
  return PNG.sync.read(Buffer.from(await res.arrayBuffer()));
}

/**
 * Samples elevation onto a regular lon/lat grid and writes an ESRI ASCII raster.
 *
 * The grid is regular in degrees, so its cells are not square on the ground —
 * harmless here, because NoiseModelling turns the raster into a point cloud and
 * reprojects each point individually.
 */
export async function writeDemAsc(bbox, outPath, { zoom = 12, cellsize = 0.00025 } = {}) {
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
  const fetched = await Promise.all(wanted.map(([x, y]) => fetchTile(zoom, x, y)));
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
