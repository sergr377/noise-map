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

let coords = 0;
const walk = (c) => (typeof c[0] === 'number' ? (coords += 1) : c.forEach(walk));
feats.forEach((f) => f.geometry && walk(f.geometry.coordinates));
console.log(`total coordinate pairs: ${coords}`);
