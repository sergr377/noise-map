/**
 * Physical plausibility check on an isophone GeoJSON.
 *
 * The failure mode we care about is silently losing building screening: without
 * it the map degrades into "distance from the nearest road", quiet areas only
 * appear at the far edge, and the whole point of using CNOSSOS is lost.
 *
 * Usage: node scripts/sanity-check.mjs <geojson> [period]
 */
import { readFile } from 'node:fs/promises';
import { bandMid } from './lib.mjs';

const file = process.argv[2];
const period = process.argv[3] ?? 'DEN';

const gj = JSON.parse(await readFile(file, 'utf8'));
const feats = gj.features.filter((f) => f.properties?.PERIOD === period);
if (feats.length === 0) throw new Error(`no features for period ${period}`);

function centroid(coords) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      sx += c[0];
      sy += c[1];
      n += 1;
    } else c.forEach(walk);
  };
  walk(coords);
  return [sx / n, sy / n];
}

/**
 * After the dissolve step a whole noise band arrives as one MultiPolygon whose
 * parts are scattered across the map, and its overall centroid would sit
 * somewhere in between them — meaningless for a distance test. Measure per part.
 */
function parts(geom) {
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'Polygon') return [geom.coordinates];
  return [];
}

const items = feats.flatMap((f) =>
  parts(f.geometry).map((poly) => ({
    level: bandMid(f.properties.ISOLABEL),
    c: centroid(poly),
  })),
);

const latRef = items[0].c[1];
const mPerDegLat = 111320;
const mPerDegLon = 111320 * Math.cos((latRef * Math.PI) / 180);
const dist = (a, b) =>
  Math.hypot((a[0] - b[0]) * mPerDegLon, (a[1] - b[1]) * mPerDegLat);

const loud = items.filter((i) => i.level >= 70);
const quiet = items.filter((i) => i.level <= 47.5);

const levels = items.map((i) => i.level);
console.log(`period ${period}: ${items.length} polygons`);
console.log(`  level range: ${Math.min(...levels)} .. ${Math.max(...levels)} dB(A)`);
console.log(`  loud (>=70 dB): ${loud.length}   quiet (<=47.5 dB): ${quiet.length}`);

if (loud.length === 0 || quiet.length === 0) {
  console.log('  VERDICT: inconclusive — need both loud and quiet areas present');
  process.exit(0);
}

// For each quiet polygon, how close is the nearest loud one?
let best = Infinity;
const gaps = [];
for (const q of quiet) {
  let m = Infinity;
  for (const l of loud) m = Math.min(m, dist(q.c, l.c));
  gaps.push(m);
  best = Math.min(best, m);
}
gaps.sort((a, b) => a - b);
const median = gaps[Math.floor(gaps.length / 2)];

console.log(`  closest quiet-to-loud distance: ${best.toFixed(0)} m`);
console.log(`  median quiet-to-loud distance:  ${median.toFixed(0)} m`);
console.log(
  best < 150
    ? '  VERDICT: sharp gradients present — building screening is active'
    : '  VERDICT: quiet zones only far from roads — screening likely NOT applied',
);
