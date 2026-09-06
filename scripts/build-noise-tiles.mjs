/**
 * Bakes the computed noise maps into a vector tile pyramid.
 *
 * The pipeline is three steps, and each one exists for a measured reason:
 *
 *   1. cut every disc to its Voronoi cell — neighbouring discs overlap by
 *      ~200 m, and a fill layer has no blend mode, so drawn raw they stack
 *      transparency and disagree about the band in the lens
 *   2. drop rings smaller than a few pixels of the target zoom — at z12 that
 *      is 82% of the rings and takes a tile from 232 to 85 KB
 *   3. slice to MVT, one tileset per period
 *
 * Periods go into separate tilesets rather than into one tile as a property:
 * four periods in one tile is four times the weight for a layer that is almost
 * always looked at as DEN.
 *
 * Usage:
 *   node scripts/build-noise-tiles.mjs                  # every period, z12..16
 *   node scripts/build-noise-tiles.mjs --period DEN     # one tileset
 *   node scripts/build-noise-tiles.mjs --min-zoom 13 --max-zoom 15
 *   node scripts/build-noise-tiles.mjs --dry-run        # weigh, write nothing
 *
 * Environment: CACHE_DIR (what to read), NOISE_TILES_DIR (where to write).
 *
 * The mosaic of one period is ~70 MB of GeoJSON for a warmed Krasnodar, and it
 * has to be in memory whole — geojson-vt indexes a collection, it does not
 * stream. Give it room:
 *
 *   node --max-old-space-size=6144 scripts/build-noise-tiles.mjs
 *
 * Deliberately does NOT import lib.mjs. Nothing here talks to the network, and
 * that import installs a global undici ProxyAgent — the same reason geo.mjs is
 * kept separate from it.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.resolve(ROOT, process.env.CACHE_DIR ?? 'cache');
const OUT_DIR = path.resolve(ROOT, process.env.NOISE_TILES_DIR ?? 'tiles/noise');

const PERIODS = ['DEN', 'D', 'E', 'N'];

/**
 * How small a ring may be before it is dropped, in square pixels of the zoom
 * being baked. Four is two pixels by two: below that a ring cannot show its
 * shape at all, only tint one pixel of the fill it sits in.
 */
const MIN_RING_PX2 = 4;

/**
 * geojson-vt defaults. `tolerance` is the Douglas-Peucker allowance in tile
 * units; the ring filter above does the heavy lifting, and this was left where
 * the library puts it rather than tuned.
 */
const EXTENT = 4096;
const TOLERANCE = 3;
const BUFFER = 64;

function parseArgs(argv) {
  const args = {
    periods: PERIODS,
    minZoom: 12,
    maxZoom: 16,
    radius: 750,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--period') {
      const wanted = (value ?? '').toUpperCase();
      if (!PERIODS.includes(wanted)) throw new Error(`неизвестный период: ${value}`);
      args.periods = [wanted];
      i++;
    } else if (arg === '--min-zoom') {
      args.minZoom = Number(value);
      i++;
    } else if (arg === '--max-zoom') {
      args.maxZoom = Number(value);
      i++;
    } else if (arg === '--radius') {
      args.radius = Number(value);
      i++;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--force') {
      args.force = true;
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }
  if (!(args.minZoom >= 0 && args.maxZoom >= args.minZoom && args.maxZoom <= 20)) {
    throw new Error('зумы должны идти по возрастанию и не выходить за 0..20');
  }
  return args;
}

// --- the metric plane ------------------------------------------------------
//
// Everything geometric happens in metres relative to one origin: distances,
// bisectors and ring areas are all wrong in degrees, and this is the same flat
// approximation the server uses for its own frames.

const METRES_PER_DEGREE = 111320;
let originScaleX = METRES_PER_DEGREE;

const toMetres = ([lon, lat]) => [lon * originScaleX, lat * METRES_PER_DEGREE];
const toDegrees = ([x, y]) => [x / originScaleX, y / METRES_PER_DEGREE];
const mapRings = (multi, fn) => multi.map((poly) => poly.map((ring) => ring.map(fn)));

/** Ring area by the shoelace formula. Coordinates are already metres. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

// --- what the cache holds --------------------------------------------------

/**
 * Cached results a click could actually be served from.
 *
 * The radius filter is what `ensureIndex` does with the cache key: a result
 * computed under earlier JOB_PARAMS sits under a key nothing will ask for
 * again, and baking it would draw a map the server would refuse to open. The
 * radius recovered from geometry wobbles by a metre, so it is compared with a
 * tolerance and then snapped — cells built from wobbling radii do not meet.
 */
async function readAreas(radius) {
  const names = await readdir(CACHE_DIR).catch(() => []);
  const areas = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    let meta;
    try {
      meta = JSON.parse(await readFile(path.join(CACHE_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lon)) continue;
    if (!Number.isFinite(meta.radius) || Math.abs(meta.radius - radius) > 5) continue;
    const map = path.join(CACHE_DIR, `${id}.geojson`);
    if (!(await stat(map).catch(() => null))?.isFile()) continue;
    areas.push({ id, lat: meta.lat, lon: meta.lon, radius, map });
  }
  return areas;
}

// --- Voronoi cells ---------------------------------------------------------

/** Sutherland-Hodgman: clip a convex polygon by one half-plane. */
function clipHalfPlane(poly, signedDistance) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const current = poly[i];
    const previous = poly[(i + poly.length - 1) % poly.length];
    const dCurrent = signedDistance(current);
    const dPrevious = signedDistance(previous);
    const crossing = () => {
      const t = dPrevious / (dPrevious - dCurrent);
      return [
        previous[0] + (current[0] - previous[0]) * t,
        previous[1] + (current[1] - previous[1]) * t,
      ];
    };
    if (dCurrent <= 0) {
      if (dPrevious > 0) out.push(crossing());
      out.push(current);
    } else if (dPrevious <= 0) {
      out.push(crossing());
    }
  }
  return out;
}

/**
 * The piece of the plane this result owns: nearer to its centre than to any
 * other, and inside its own disc.
 *
 * The ownership rule has to be the one `coveringArea` answers by, or the map
 * draws one result under the cursor while a click there serves another — the
 * same class of disagreement as the probe and POST having to agree. Radii are
 * equal by construction (see readAreas), so the weighted diagram degenerates
 * into an ordinary Voronoi one and a bisector is enough.
 *
 * For a disc on the lattice this cell is a regular hexagon inscribed in it, so
 * the cut loses nothing and leaves no gap. For a stray disc at the edge of the
 * warmed area the cell runs past the rim, which is what the disc clip below is
 * for.
 */
function cellFor(area, neighbours) {
  const [cx, cy] = area.centre;
  const reach = area.radius * 2;
  let poly = [
    [cx - reach, cy - reach],
    [cx + reach, cy - reach],
    [cx + reach, cy + reach],
    [cx - reach, cy + reach],
  ];
  for (const other of neighbours) {
    if (other === area) continue;
    const [ox, oy] = other.centre;
    const dx = ox - cx;
    const dy = oy - cy;
    const spread = dx * dx + dy * dy;
    // A centre further than two diameters cannot cut this cell at all.
    if (spread === 0 || spread > (4 * area.radius) ** 2) continue;
    const midX = (cx + ox) / 2;
    const midY = (cy + oy) / 2;
    poly = clipHalfPlane(poly, (p) => (p[0] - midX) * dx + (p[1] - midY) * dy);
    if (poly.length < 3) return null;
  }

  const disc = [];
  const segments = 64;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    disc.push([cx + area.radius * Math.cos(angle), cy + area.radius * Math.sin(angle)]);
  }
  const cut = polygonClipping.intersection([[...poly, poly[0]]], [disc]);
  return cut.length ? cut : null;
}

// --- the mosaic ------------------------------------------------------------

/**
 * Every cached result of one period, cut to its cell and merged into one
 * collection. Returned in degrees, which is what geojson-vt wants.
 */
async function buildMosaic(areas, period) {
  const features = [];
  let clipped = 0;
  let failed = 0;
  for (const area of areas) {
    const cell = cellFor(area, areas);
    if (!cell) continue;
    const collection = JSON.parse(await readFile(area.map, 'utf8'));
    for (const feature of collection.features ?? []) {
      if (feature.properties?.PERIOD !== period) continue;
      const multi =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates;
      let cut;
      try {
        cut = polygonClipping.intersection(mapRings(multi, toMetres), cell);
      } catch {
        // Degenerate rings — zero-area slivers the isosurface leaves behind —
        // make the clipper throw. They are exactly what step 2 drops anyway.
        failed++;
        continue;
      }
      if (!cut.length) continue;
      clipped++;
      features.push({
        type: 'Feature',
        properties: { ISOLVL: feature.properties.ISOLVL },
        // Kept in metres: every zoom filters by ring area, and converting back
        // and forth per zoom would cost more than holding one extra array.
        geometry: { type: 'MultiPolygon', coordinates: cut },
      });
    }
  }
  return { features, clipped, failed };
}

// --- slicing ---------------------------------------------------------------

const EQUATOR_METRES_PER_PIXEL = 156543.03392;

/** Ground resolution at a zoom, metres per pixel, at the mosaic's latitude. */
const metresPerPixel = (zoom, lat) =>
  (EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/**
 * Which tiles a zoom actually has to look at.
 *
 * Not the bounding box of the whole cache: it holds the Moscow demo points as
 * well as Krasnodar, so that box spans a third of the country and is empty
 * almost everywhere in between. At z16 walking it would be millions of misses
 * for a few thousand hits. Each disc contributes only the tiles it touches.
 */
function candidateTiles(areas, zoom) {
  const wanted = new Set();
  for (const area of areas) {
    const padLat = area.radius / METRES_PER_DEGREE;
    const padLon = area.radius / originScaleX;
    const x0 = lonToX(area.lon - padLon, zoom);
    const x1 = lonToX(area.lon + padLon, zoom);
    const y0 = latToY(area.lat + padLat, zoom);
    const y1 = latToY(area.lat - padLat, zoom);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) wanted.add(`${x}/${y}`);
    }
  }
  return [...wanted].map((key) => key.split('/').map(Number));
}

/**
 * The mosaic with everything too small for this zoom removed, in degrees.
 *
 * A fixed threshold is not enough: it holds the weight at z14 and up and lets
 * z12 run to 232 KB a tile. Tying it to the zoom's own pixel is what makes the
 * pyramid's weight flat.
 */
function forZoom(features, threshold) {
  const out = [];
  let kept = 0;
  let total = 0;
  for (const feature of features) {
    const polys = [];
    for (const poly of feature.geometry.coordinates) {
      const rings = poly.filter((ring) => {
        total++;
        const big = ringArea(ring) >= threshold;
        if (big) kept++;
        return big;
      });
      // A polygon whose outer ring went with the filter takes its holes along;
      // holes without their outer ring would render as solid islands.
      if (rings.length && rings[0] === poly[0]) polys.push(rings);
    }
    if (polys.length) {
      out.push({
        type: 'Feature',
        properties: feature.properties,
        geometry: { type: 'MultiPolygon', coordinates: mapRings(polys, toDegrees) },
      });
    }
  }
  return { collection: { type: 'FeatureCollection', features: out }, kept, total };
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const areas = await readAreas(args.radius);
  if (areas.length === 0) {
    console.error(
      `в ${CACHE_DIR} нет результатов с радиусом ${args.radius} м. ` +
        'Кэш пуст, или он посчитан с другими JOB_PARAMS — тогда его надо греть заново.',
    );
    process.exit(1);
  }

  // One cosine for the whole city: the warmed area is tens of kilometres, and
  // the error a single origin introduces over that is centimetres.
  const midLat = areas.reduce((sum, a) => sum + a.lat, 0) / areas.length;
  originScaleX = METRES_PER_DEGREE * Math.cos((midLat * Math.PI) / 180);
  for (const area of areas) area.centre = toMetres([area.lon, area.lat]);

  const bounds = areas.reduce(
    (box, a) => {
      const padLat = a.radius / METRES_PER_DEGREE;
      const padLon = a.radius / originScaleX;
      return [
        Math.min(box[0], a.lon - padLon),
        Math.min(box[1], a.lat - padLat),
        Math.max(box[2], a.lon + padLon),
        Math.max(box[3], a.lat + padLat),
      ];
    },
    [180, 90, -180, -90],
  );

  console.log(
    `кэш: ${areas.length} результатов радиусом ${args.radius} м, ` +
      `рамка ${bounds.map((n) => n.toFixed(3)).join(', ')}`,
  );
  console.log(`зумы ${args.minZoom}..${args.maxZoom}, периоды ${args.periods.join(', ')}`);
  console.log(args.dryRun ? 'сухой прогон: ничего не пишем\n' : `пишем в ${OUT_DIR}\n`);

  if (!args.dryRun && args.force) await rm(OUT_DIR, { recursive: true, force: true });

  let totalTiles = 0;
  let totalBytes = 0;

  for (const period of args.periods) {
    const started = Date.now();
    const { features, clipped, failed } = await buildMosaic(areas, period);
    console.log(
      `${period}: ${clipped} фигур обрезано за ${((Date.now() - started) / 1000).toFixed(0)} с` +
        (failed ? `, ${failed} вырожденных пропущено` : ''),
    );
    if (features.length === 0) {
      console.log(`${period}: пусто, пропускаем\n`);
      continue;
    }

    for (let zoom = args.minZoom; zoom <= args.maxZoom; zoom++) {
      const threshold = MIN_RING_PX2 * metresPerPixel(zoom, midLat) ** 2;
      const { collection, kept, total } = forZoom(features, threshold);
      const index = geojsonvt(collection, {
        // The whole pyramid is indexed against the deepest zoom it will serve:
        // simplification is computed from maxZoom, so building each level
        // against itself would give the same tile a different geometry
        // depending on which run produced it.
        maxZoom: args.maxZoom,
        indexMaxZoom: 5,
        tolerance: TOLERANCE,
        extent: EXTENT,
        buffer: BUFFER,
      });

      let written = 0;
      let bytes = 0;
      // Wire sizes, which is what a screenful actually costs: the route gzips
      // on the way out, and .pbf compresses by about a fifth.
      const wire = [];
      for (const [x, y] of candidateTiles(areas, zoom)) {
        const tile = index.getTile(zoom, x, y);
        if (!tile || tile.features.length === 0) continue;
        const buffer = Buffer.from(vtpbf.fromGeojsonVt({ noise: tile }, { version: 2 }));
        written++;
        bytes += buffer.length;
        wire.push(gzipSync(buffer, { level: 6 }).length);
        if (args.dryRun) continue;
        const dir = path.join(OUT_DIR, period, String(zoom), String(x));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `${y}.pbf`), buffer);
      }
      wire.sort((a, b) => a - b);
      const median = wire.length ? wire[Math.floor(wire.length / 2)] : 0;
      const heaviest = wire.length ? wire[wire.length - 1] : 0;
      console.log(
        `  z${zoom}: ${String(written).padStart(5)} тайлов, ` +
          `колец ${((100 * kept) / total).toFixed(0).padStart(3)}%, ` +
          `gzip: медиана ${kb(median).padStart(6)} КБ, максимум ${kb(heaviest).padStart(6)} КБ; ` +
          `на диске ${(bytes / 1048576).toFixed(1)} МБ`,
      );
      totalTiles += written;
      totalBytes += bytes;
    }
    console.log('');
  }

  if (!args.dryRun) {
    // What the client needs to build a source without a second copy of these
    // numbers in the frontend. `built` is also the cache buster: tiles are
    // rebuilt under the same names, and a stale one would be the worst kind of
    // stale — so the client asks with ?v=<built> and the server may then call
    // them immutable.
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      path.join(OUT_DIR, 'meta.json'),
      `${JSON.stringify(
        {
          built: Date.now(),
          minzoom: args.minZoom,
          maxzoom: args.maxZoom,
          bounds: bounds.map((n) => Number(n.toFixed(5))),
          periods: args.periods,
          radius: args.radius,
          areas: areas.length,
          extent: EXTENT,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  console.log(
    `итого ${totalTiles} тайлов, ${(totalBytes / 1048576).toFixed(1)} МБ` +
      (args.dryRun ? ' (не записаны)' : ''),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
