/**
 * Grid snapping must be idempotent: quantize(quantize(p)) === quantize(p).
 * If it is not, one location can end up with two different cache keys and the
 * same click can trigger a recomputation it should have hit cache for.
 */
import { quantize } from '../server/dist/cache.js';

const cities = [
  ['Москва', 55.7558, 37.6173],
  ['Санкт-Петербург', 59.9343, 30.3351],
  ['Мурманск', 68.9585, 33.0827],
  ['Сочи', 43.5855, 39.7231],
  ['Владивосток', 43.1155, 131.8855],
  ['Калининград', 54.7104, 20.4522],
];

let checked = 0;
let failures = 0;

for (const [name, baseLat, baseLon] of cities) {
  let cityFailures = 0;
  // Sweep well past one cell in each direction so boundaries are hit repeatedly.
  for (let i = -60; i <= 60; i++) {
    for (let j = -60; j <= 60; j++) {
      const lat = baseLat + i * 0.00005;
      const lon = baseLon + j * 0.00005;
      const once = quantize(lat, lon);
      const twice = quantize(once.lat, once.lon);
      checked += 1;
      if (once.lat !== twice.lat || once.lon !== twice.lon) {
        cityFailures += 1;
        if (cityFailures === 1) {
          console.log(
            `  ${name}: ${lat},${lon} -> ${once.lat},${once.lon} -> ${twice.lat},${twice.lon}`,
          );
        }
      }
    }
  }
  failures += cityFailures;
  console.log(`${cityFailures === 0 ? 'OK  ' : 'FAIL'} ${name}: ${cityFailures} unstable points`);
}

console.log(`\nchecked ${checked} points, ${failures} unstable`);
process.exit(failures === 0 ? 0 : 1);
