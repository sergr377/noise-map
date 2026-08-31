/**
 * Builds a prewarming plan for a whole city: which discs to compute, in what
 * order, and what the batch will cost.
 *
 * A cold click is minutes of every core, so a public map is only pleasant where
 * the cache already reaches. Covering a city means tiling it with discs of
 * JOB_PARAMS.radius — but tiling it *evenly* is waste: two thirds of a Russian
 * urban okrug is farmland, where a run either produces an empty map or dies at
 * the import stage for want of roads. So the plan is ranked by how many
 * buildings each disc is the nearest one to, and prewarm.mjs takes the share
 * worth having. On Krasnodar that is 254 tiles for 95% of the buildings against
 * 633 for the whole boundary.
 *
 * Usage:
 *   node scripts/plan-tiles.mjs krasnodar
 *   node scripts/plan-tiles.mjs --rel 269701,5442462 --out plans/mine.json
 *   node scripts/plan-tiles.mjs krasnodar --radius 500 --src-radius 850
 *
 * The plan holds every tile of the lattice, ranked. Re-cutting it to a different
 * share costs nothing and needs no Overpass — that is prewarm's job, not this
 * script's, which is why this one is run once and its output kept.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hexLattice, pointInRings, ringArea, stitchRings, tilesForShare } from './geo.mjs';
import { overpassFetch } from './lib.mjs';

/**
 * OSM relation ids of the boundaries a preset covers.
 *
 * Krasnodar is three: the okrug itself, plus Enem and Yablonovsky. Those two are
 * in Adygea and so fall outside every Krasnodar boundary there is, while being
 * continuous city across the river — a plan that stops at the regional border
 * stops in the middle of the built-up area.
 */
const PRESETS = {
  krasnodar: { rels: [269701, 5442462, 5442463] },
};

/**
 * Road classes CNOSSOS gets traffic for. The pipeline imports with
 * `eliminateNoTrafficRoads=true`, so tracks, paths and footways contribute no
 * sources — counting them here would make an orchard read as a suburb.
 */
const TRAFFIC_ROADS =
  '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$';

/** The long classes, where one centroid per way would under-sample badly. */
const MAJOR_ROADS = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$';

/**
 * Seconds a run takes, from what Import_OSM will find in its extraction square.
 *
 * Fitted on the 14 finished r750 runs left in jobs/, reading the `buildings` and
 * `roads` counts out of each webserver.log against its Export_Table timing:
 * R² = 0.71, RMSE 132 s. Neither count works alone — buildings on their own give
 * R² = 0.01, because Moscow carries 8938 roads against 1838 buildings and
 * Krasnodar the reverse, while receivers come from the Delaunay mesh over both.
 *
 * The floor is not in the fit: no measured run finished under 141 s, and the
 * regression happily predicts two seconds for open steppe. The constant on top
 * is Overpass and the DEM, which the fit never saw — its input was engine time
 * from a log the engine only starts writing once it has the data.
 *
 * These are three numbers from one machine and one afternoon of Overpass. They
 * size a batch; they do not promise one.
 */
const OVERPASS_SECONDS = 40;
const FLOOR_SECONDS = 120;
const estimateSeconds = (buildings, roads) =>
  OVERPASS_SECONDS + Math.max(FLOOR_SECONDS, 1.9 + 0.073 * buildings + 0.087 * roads);

/** Mean size of a finished r750 result, from the 13 Krasnodar entries in cache/. */
const RESULT_MB = 1.57;
/** Measured over the whole cache directory at gzip -6. */
const GZIP_RATIO = 4.27;

function parseArgs(argv) {
  const args = { preset: null, rels: [], radius: 750, srcRadius: null, out: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`у ${arg} нет значения`);
      return v;
    };
    if (arg === '--rel') args.rels.push(...value().split(',').map(Number));
    else if (arg === '--radius') args.radius = Number(value());
    else if (arg === '--src-radius') args.srcRadius = Number(value());
    else if (arg === '--out') args.out = value();
    else if (arg === '--name') args.name = value();
    else if (arg.startsWith('-')) throw new Error(`не знаю ключа ${arg}`);
    else if (PRESETS[arg]) {
      args.preset = arg;
      args.rels.push(...PRESETS[arg].rels);
    } else {
      const known = Object.keys(PRESETS).join(', ');
      throw new Error(`не разобрал "${arg}" — ожидается пресет (${known}) или ключ`);
    }
  }
  if (args.rels.length === 0) throw new Error('нечего планировать: укажите пресет или --rel');
  if (!Number.isFinite(args.radius) || args.radius <= 0) {
    throw new Error('--radius должен быть числом метров');
  }
  if (args.rels.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('--rel принимает id отношений OSM через запятую');
  }
  // The extract has to reach every source a receiver on the rim can hear, which
  // is radius + maxSrcDist. 350 is the JOB_PARAMS default; --src-radius is for a
  // server configured otherwise.
  args.srcRadius ??= args.radius + 350;
  args.name ??= args.preset ?? `rel-${args.rels.join('-')}`;
  args.out ??= path.join('plans', `${args.name}.json`);
  return args;
}

/** One Overpass call, with the answer parsed and the mirror that gave it named. */
async function ask(what, query, budgetMs = 900_000) {
  const started = Date.now();
  const { body, endpoint } = await overpassFetch(query, {
    hasPayload: (b) => b.includes('"elements"'),
    budgetMs,
    attemptTimeoutMs: Math.min(budgetMs, 600_000),
  });
  const { elements } = JSON.parse(body);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const size = (body.length / 1e6).toFixed(1);
  console.log(
    `  ${what}: ${elements.length} шт, ${size} МБ, ${seconds} с — ${new URL(endpoint).host}`,
  );
  return elements;
}

/** Overpass turns a relation id into an area id by adding 3600000000. */
const areaSet = (rels) => `(${rels.map((id) => `area(${3600000000 + id});`).join(' ')})->.a;`;

async function fetchBoundaries(rels) {
  const query = `[out:json][timeout:180];\n(${rels.map((id) => `relation(${id});`).join('')});\nout geom;`;
  const elements = await ask('границы', query, 300_000);

  const found = new Set(elements.map((e) => e.id));
  const missing = rels.filter((id) => !found.has(id));
  // A relation missing from the answer is not an empty boundary — it is a typo
  // or a deleted object, and the lattice would quietly come out short.
  if (missing.length > 0) throw new Error(`Overpass не знает relation ${missing.join(', ')}`);

  const boundaries = [];
  for (const rel of elements) {
    const outer = stitchRings(rel.members.filter((m) => m.role !== 'inner'));
    const inner = stitchRings(rel.members.filter((m) => m.role === 'inner'));
    if (outer.length === 0) throw new Error(`relation ${rel.id} не сложился в замкнутый контур`);
    const area =
      outer.reduce((s, r) => s + Math.abs(ringArea(r)), 0) -
      inner.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
    const name = rel.tags?.name ?? String(rel.id);
    boundaries.push({ id: rel.id, name, rings: [...outer, ...inner], km2: area / 1e6 });
    console.log(`    ${name}: ${(area / 1e6).toFixed(1)} км²`);
  }
  return boundaries;
}

async function fetchPoints(rels) {
  // Buildings and roads are asked for as centroids rather than geometry: this
  // only has to decide which square kilometre is worth an hour of CPU, and full
  // geometry for a whole okrug is tens of megabytes off somebody else's server.
  const buildings = await ask(
    'здания',
    `[out:json][timeout:600];\n${areaSet(rels)}\nway["building"](area.a);\nout center;`,
    1_200_000,
  );
  const roads = await ask(
    'дороги',
    `[out:json][timeout:600];\n${areaSet(rels)}\nway["highway"~"${TRAFFIC_ROADS}"](area.a);\nout center;`,
  );
  // Except for the long ones. A trunk road crossing four tiles has one centroid,
  // in the middle, and the three tiles it merely passes through would read as
  // empty — while being exactly the places where road noise is the whole story.
  const major = await ask(
    'магистрали, с геометрией',
    `[out:json][timeout:600];\n${areaSet(rels)}\nway["highway"~"${MAJOR_ROADS}"](area.a);\nout geom;`,
  );

  const centre = (e) => (e.center ? [e.center.lon, e.center.lat] : null);
  return {
    buildings: buildings.map(centre).filter(Boolean),
    roads: roads
      .map(centre)
      .filter(Boolean)
      .concat(major.flatMap((w) => (w.geometry ?? []).map((p) => [p.lon, p.lat]))),
  };
}

/**
 * The counts every tile needs, in one pass over a point cloud.
 *
 * `square` counts what Import_OSM will see: the extraction *square* of
 * srcRadius, not the display disc, because that is the shape the extract has and
 * the runtime model above was fitted against those very numbers.
 *
 * `owned` is the hexagon partition — every point belongs to exactly one tile,
 * the nearest centre — so summing it over any selection gives coverage without
 * double counting, which counting inside overlapping discs would not.
 *
 * One cosine for the whole city is enough here, unlike in hexLattice: this is a
 * counting radius, and 0.5% of 1100 m decides nothing. A lattice built that way
 * would open seams instead.
 */
function tally(tiles, points, radiusMetres, fields) {
  const metresPerLat = 111320;
  const metresPerLon = 111320 * Math.cos((tiles[0].lat * Math.PI) / 180);
  const bin = radiusMetres;
  const bins = new Map();
  for (const tile of tiles) {
    tile.x = tile.lon * metresPerLon;
    tile.y = tile.lat * metresPerLat;
    const key = `${Math.round(tile.x / bin)}:${Math.round(tile.y / bin)}`;
    const bucket = bins.get(key);
    if (bucket) bucket.push(tile);
    else bins.set(key, [tile]);
  }

  for (const [lon, lat] of points) {
    const x = lon * metresPerLon;
    const y = lat * metresPerLat;
    const bx = Math.round(x / bin);
    const by = Math.round(y / bin);
    let nearest = null;
    let nearestDistance = Infinity;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (const tile of bins.get(`${bx + i}:${by + j}`) ?? []) {
          const dx = Math.abs(tile.x - x);
          const dy = Math.abs(tile.y - y);
          if (fields.square && dx <= radiusMetres && dy <= radiusMetres) tile[fields.square]++;
          const distance = dx * dx + dy * dy;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = tile;
          }
        }
      }
    }
    if (fields.owned && nearest) nearest[fields.owned]++;
  }
}

const args = parseArgs(process.argv.slice(2));
console.log(`планирую ${args.name}: круг показа ${args.radius} м, выгрузка ${args.srcRadius} м\n`);

const boundaries = await fetchBoundaries(args.rels);
const points = await fetchPoints(args.rels);

const bounds = boundaries
  .flatMap((b) => b.rings)
  .flat()
  .reduce(
    (b, [lon, lat]) => ({
      south: Math.min(b.south, lat),
      north: Math.max(b.north, lat),
      west: Math.min(b.west, lon),
      east: Math.max(b.east, lon),
    }),
    { south: 90, north: -90, west: 180, east: -180 },
  );

const tiles = hexLattice(bounds, args.radius)
  .filter(({ lat, lon }) => boundaries.some((b) => pointInRings(b.rings, lon, lat)))
  .map((tile) => ({ ...tile, buildings: 0, roads: 0, owned: 0 }));
if (tiles.length === 0) throw new Error('решётка вышла пустой — проверьте границы');

tally(tiles, points.buildings, args.srcRadius, { square: 'buildings', owned: 'owned' });
tally(tiles, points.roads, args.srcRadius, { square: 'roads' });

// Ranked by how many buildings the tile is the nearest one to. That order is the
// point of the file: a prewarm stopped halfway has computed the most valuable
// half rather than an arbitrary one.
const ranked = tiles
  .map(({ lat, lon, buildings, roads, owned }) => ({
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    buildings,
    roads,
    owned,
    seconds: Math.round(estimateSeconds(buildings, roads)),
  }))
  .sort((a, b) => b.owned - a.owned || b.buildings - a.buildings);

const totalOwned = ranked.reduce((s, t) => s + t.owned, 0);
const alongRow = args.radius * Math.sqrt(3);
const betweenRows = 1.5 * args.radius;
const tileKm2 = (alongRow * betweenRows) / 1e6;

console.log(
  `\nрешётка ${alongRow.toFixed(0)}×${betweenRows.toFixed(0)} м, ${tileKm2.toFixed(3)} км² на тайл`,
);
console.log(
  `${tiles.length} тайлов внутри границ, ` +
    `${points.buildings.length} зданий, ${points.roads.length} дорожных точек\n`,
);
console.log('доля зданий  тайлов    км²      счёт   кэш raw   кэш gz');
for (const share of [0.5, 0.75, 0.9, 0.95, 0.99, 1]) {
  const chosen = tilesForShare(ranked, share);
  const seconds = chosen.reduce((sum, tile) => sum + tile.seconds, 0);
  const mb = chosen.length * RESULT_MB;
  const label = share >= 1 ? 'вся сетка' : `${(share * 100).toFixed(0)}%`;
  console.log(
    `${label.padStart(9)}  ${String(chosen.length).padStart(6)}` +
      `  ${(chosen.length * tileKm2).toFixed(0).padStart(5)}  ${(seconds / 3600).toFixed(1).padStart(6)} ч` +
      `  ${(mb / 1024).toFixed(2).padStart(6)} ГБ  ${(mb / 1024 / GZIP_RATIO).toFixed(2).padStart(5)} ГБ`,
  );
}

const plan = {
  name: args.name,
  generated: new Date().toISOString(),
  // The radius is recorded because it is half of the cache key: a plan built for
  // 750 warms nothing on a server running 500. prewarm.mjs checks it against
  // what the server reports before spending a night computing.
  radius: args.radius,
  srcRadius: args.srcRadius,
  boundaries: boundaries.map(({ id, name, km2 }) => ({ id, name, km2: Number(km2.toFixed(1)) })),
  totals: {
    tiles: ranked.length,
    areaKm2: Number((ranked.length * tileKm2).toFixed(1)),
    buildings: totalOwned,
    roadPoints: points.roads.length,
    seconds: ranked.reduce((s, t) => s + t.seconds, 0),
  },
};
// One tile per line rather than pretty-printed: this is a table of six hundred
// rows that a person reads and git diffs, and eight lines per row makes both
// useless. The head is indented normally — that part is meant to be read.
const rows = ranked.map((tile) => `    ${JSON.stringify(tile)}`).join(',\n');
const head = JSON.stringify(plan, null, 2).replace(/\n}$/, '');
await mkdir(path.dirname(args.out), { recursive: true });
await writeFile(args.out, `${head},\n  "tiles": [\n${rows}\n  ]\n}\n`, 'utf8');

console.log(`\nплан записан в ${args.out}`);
console.log(`прогреть:  node scripts/prewarm.mjs --plan ${args.out} --share 0.95`);
