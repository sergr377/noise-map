/** Quick structural report on an exported isophone GeoJSON. */
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const gj = JSON.parse(await readFile(file, 'utf8'));
const feats = gj.features ?? [];

console.log(`features: ${feats.length}`);
console.log(`property keys: ${JSON.stringify(Object.keys(feats[0]?.properties ?? {}))}`);
console.log(`sample properties: ${JSON.stringify(feats[0]?.properties)}`);

const byKey = (key) => {
  const counts = new Map();
  for (const f of feats) {
    const v = f.properties?.[key];
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
};

for (const key of ['PERIOD', 'ISOLVL', 'ISOLABEL']) {
  if (feats[0]?.properties && key in feats[0].properties) {
    console.log(`${key}: ${JSON.stringify(byKey(key))}`);
  }
}

// A coordinate pair is the leaf of the nesting: [x, y] against rings of rings.
function countPairs(node) {
  if (typeof node[0] === 'number') return 1;
  let total = 0;
  for (const child of node) total += countPairs(child);
  return total;
}

let coords = 0;
for (const f of feats) {
  if (f.geometry) coords += countPairs(f.geometry.coordinates);
}
console.log(`total coordinate pairs: ${coords}`);
