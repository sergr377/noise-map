/**
 * Compares two isophone results band by band.
 *
 * Used to answer whether a modelling option actually changes the map or only
 * costs time — "the numbers moved" is a claim that needs measuring, not eyeballing.
 *
 * Usage: node scripts/compare-runs.mjs <a.geojson> <b.geojson> [period]
 */
import { readFile } from 'node:fs/promises';

const [fileA, fileB, period = 'DEN'] = process.argv.slice(2);
if (!fileA || !fileB) throw new Error('нужны два файла для сравнения');

function bandMid(label) {
  if (label.startsWith('-')) return 32.5;
  if (label.endsWith('+')) return 82.5;
  const [a, b] = label.split('-').map(Number);
  return (a + b) / 2;
}

/**
 * Planar area via the shoelace formula on a local equirectangular projection.
 * Over a 1 km square the distortion is far below the difference being measured.
 */
function ringArea(ring, latRef) {
  const mx = 111320 * Math.cos((latRef * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    sum += x1 * mx * (y2 * 111320) - x2 * mx * (y1 * 111320);
  }
  return Math.abs(sum) / 2;
}

function polygonArea(coords, latRef) {
  // First ring is the outer boundary, the rest are holes.
  return coords.reduce(
    (acc, ring, index) => acc + (index === 0 ? ringArea(ring, latRef) : -ringArea(ring, latRef)),
    0,
  );
}

async function areasByBand(file) {
  const gj = JSON.parse(await readFile(file, 'utf8'));
  const features = gj.features.filter((f) => f.properties.PERIOD === period);
  if (features.length === 0) throw new Error(`${file}: нет данных за период ${period}`);

  const latRef = features[0].geometry.coordinates.flat(Infinity)[1];
  const areas = new Map();
  for (const feature of features) {
    const polys =
      feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    const area = polys.reduce((acc, poly) => acc + polygonArea(poly, latRef), 0);
    areas.set(feature.properties.ISOLABEL, (areas.get(feature.properties.ISOLABEL) ?? 0) + area);
  }
  return areas;
}

const a = await areasByBand(fileA);
const b = await areasByBand(fileB);

const labels = [...new Set([...a.keys(), ...b.keys()])].sort(
  (x, y) => bandMid(x) - bandMid(y),
);

console.log(`период ${period}\n`);
console.log('диапазон    A, га      B, га      разница');
let totalA = 0;
let totalB = 0;
let shifted = 0;
let weightedA = 0;
let weightedB = 0;

for (const label of labels) {
  const areaA = a.get(label) ?? 0;
  const areaB = b.get(label) ?? 0;
  totalA += areaA;
  totalB += areaB;
  shifted += Math.abs(areaA - areaB);
  weightedA += areaA * bandMid(label);
  weightedB += areaB * bandMid(label);
  const delta = (areaB - areaA) / 10000;
  console.log(
    `${label.padEnd(10)} ${(areaA / 10000).toFixed(2).padStart(8)} ${(areaB / 10000)
      .toFixed(2)
      .padStart(10)} ${(delta >= 0 ? '+' : '') + delta.toFixed(2)}`.padEnd(50),
  );
}

console.log(`\nплощадь всего:        A ${(totalA / 10000).toFixed(1)} га, B ${(totalB / 10000).toFixed(1)} га`);
console.log(
  `средний уровень:      A ${(weightedA / totalA).toFixed(2)} дБ(A), B ${(weightedB / totalB).toFixed(2)} дБ(A)`,
);
// Each hectare that changed band is counted once in A and once in B.
console.log(
  `сменило диапазон:     ${((shifted / 2 / totalA) * 100).toFixed(1)}% площади`,
);
