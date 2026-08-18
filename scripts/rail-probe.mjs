/**
 * What does OpenStreetMap actually know about railways near a point?
 *
 * The rail module needs track count, speed and traffic. OSM reliably supplies
 * only geometry, so this reports how much of the rest is present before any of
 * it is assumed away.
 *
 * Usage: node scripts/rail-probe.mjs [lat] [lon] [radius]
 */
import './lib.mjs'; // installs the proxy dispatcher

const lat = Number(process.argv[2] ?? 55.776);
const lon = Number(process.argv[3] ?? 37.656);
const radius = Number(process.argv[4] ?? 850);

const dLat = radius / 111320;
const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;

const query = `[out:json][timeout:120];
(way["railway"](${bbox}););
out tags;`;

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'noise-map/0.1 (rail coverage probe)',
  },
  body: new URLSearchParams({ data: query }),
  signal: AbortSignal.timeout(180_000),
});
if (!res.ok) {
  throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
}
const ways = (await res.json()).elements ?? [];

console.log(`точка ${lat},${lon}, радиус ${radius} м`);
console.log(`объектов railway=*: ${ways.length}`);

const count = (list, key) => {
  const map = new Map();
  for (const w of list) {
    const v = w.tags[key];
    if (v) map.set(v, (map.get(v) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('по типам:', count(ways, 'railway').map(([k, v]) => `${k}=${v}`).join(', ') || '—');

// Only these carry trains the CNOSSOS rail module can represent.
const surface = ways.filter(
  (w) => ['rail', 'light_rail', 'narrow_gauge'].includes(w.tags.railway) && w.tags.tunnel !== 'yes',
);
console.log(`\nповерхностная ж/д (без тоннелей): ${surface.length}`);

for (const key of ['usage', 'maxspeed', 'tracks', 'service', 'electrified']) {
  const present = surface.filter((w) => w.tags[key]).length;
  const share = surface.length ? ((present / surface.length) * 100).toFixed(0) : '0';
  const values = count(surface, key).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(', ');
  console.log(`  ${key.padEnd(12)} есть у ${String(present).padStart(3)} из ${surface.length} (${share}%)  ${values}`);
}

const trams = ways.filter((w) => w.tags.railway === 'tram');
console.log(`\nтрамвайных путей: ${trams.length} — не моделируются, в каталоге CNOSSOS нет трамвая`);
