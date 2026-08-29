/**
 * Precomputes noise maps so a click opens instantly instead of starting minutes
 * of work on every core.
 *
 * Two scales of the same job. A handful of demo points is a preset or a pair of
 * coordinates. A whole city is a plan from `plan-tiles.mjs` — a lattice of discs
 * ranked by how much of the built-up area each one is the nearest to — and
 * `--share` decides how far down that ranking to go. Everywhere not warmed still
 * computes on demand, unless the server runs with CACHE_ONLY=1.
 *
 * Usage:
 *   node scripts/prewarm.mjs                                    # demo set
 *   node scripts/prewarm.mjs moscow                             # one preset
 *   node scripts/prewarm.mjs 55.75,37.61                        # coordinates
 *   node scripts/prewarm.mjs --plan plans/krasnodar.json --share 0.95
 *   node scripts/prewarm.mjs --plan plans/krasnodar.json --limit 20
 *   node scripts/prewarm.mjs --grid 45.035,38.975,5             # lattice, 5 km around
 *
 * A batch is hours long and is meant to be interrupted: tiles already in the
 * cache are skipped in milliseconds, so re-running it resumes. Ctrl+C stops this
 * script, not the pipeline it is waiting on — the run in flight finishes in the
 * server and lands in the cache anyway.
 */
import { readFile } from 'node:fs/promises';
import { request as undiciRequest } from 'undici';
import { hexLattice, tilesForShare } from './geo.mjs';

const BASE = process.env.API_BASE ?? 'http://localhost:8787';

/** Spots chosen for contrast: a major road beside sheltered courtyards. */
const PRESETS = {
  moscow: [
    { name: 'Москва, Тверская', lat: 55.7649, lon: 37.6055 },
    { name: 'Москва, Садовое кольцо', lat: 55.7708, lon: 37.6335 },
    { name: 'Москва, Хамовники', lat: 55.7315, lon: 37.5806 },
  ],
  spb: [
    { name: 'СПб, Невский проспект', lat: 59.9331, lon: 30.3351 },
    { name: 'СПб, Петроградская', lat: 59.9626, lon: 30.3126 },
  ],
};

function parseArgs(argv) {
  const args = { plan: null, share: 0.95, limit: Infinity, grid: null, points: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`у ${arg} нет значения`);
      return v;
    };
    if (arg === '--plan') args.plan = value();
    else if (arg === '--share') args.share = Number(value());
    else if (arg === '--limit') args.limit = Number(value());
    else if (arg === '--grid') args.grid = value().split(',').map(Number);
    else if (arg.startsWith('-')) throw new Error(`не знаю ключа ${arg}`);
    else if (PRESETS[arg]) args.points.push(...PRESETS[arg]);
    else {
      const [lat, lon] = arg.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const known = Object.keys(PRESETS).join(', ');
        throw new Error(`не разобрал "${arg}" — ожидается пресет (${known}) или "lat,lon"`);
      }
      args.points.push({ name: `${lat},${lon}`, lat, lon });
    }
  }
  if (!(args.share > 0 && args.share <= 1)) throw new Error('--share должен быть в (0, 1]');
  if (!(args.limit > 0)) throw new Error('--limit должен быть положительным');
  if (args.grid && (args.grid.length !== 3 || args.grid.some((n) => !Number.isFinite(n)))) {
    throw new Error('--grid принимает "lat,lon,km"');
  }
  return args;
}

async function getJson(path) {
  const res = await undiciRequest(`${BASE}${path}`);
  return { status: res.statusCode, body: await res.body.json() };
}

async function postJson(path, body) {
  const res = await undiciRequest(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: await res.body.json() };
}

/**
 * Follows the progress stream. Polling /result would work for the happy path but
 * cannot see a failure: a failed job keeps answering 409 until it is evicted, so
 * a broken location would stall the batch for ten minutes instead of reporting.
 */
async function waitForJob(id, onStage) {
  const res = await fetch(`${BASE}/api/noise/${id}/events`);
  if (!res.ok) throw new Error(`не удалось подписаться на прогресс: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('поток прогресса закрылся до завершения');
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const state = JSON.parse(line.slice(6));
      onStage(state);
      if (state.stage === 'done') return;
      if (state.stage === 'error') throw new Error(state.error ?? 'расчёт завершился ошибкой');
    }
  }
}

/**
 * What the server is actually configured to compute.
 *
 * Asked before anything is started, because the answer decides whether the batch
 * is worth running at all: the radius is half of the cache key, so a plan built
 * for 750 m fills a cache that a server running 500 m can never read back. A
 * night of computing is not a thing to discover afterwards. The probe route
 * cannot answer this — for a point already covered it reports the covering
 * result's radius rather than the configured one.
 */
async function serverParams() {
  const health = await getJson('/api/health').catch((err) => {
    throw new Error(`сервер на ${BASE} не отвечает: ${err.message}`);
  });
  if (health.status !== 200) throw new Error(`/api/health ответил ${health.status}`);
  if (health.body.engine === 'stub' && process.env.PREWARM_ALLOW_STUB !== '1') {
    // The stub writes concentric rings into a cache of its own. Warming it is
    // not wrong, only pointless, and silently pointless is the bad kind. The
    // escape hatch exists because the plan and share logic is worth exercising
    // without Java and half a day of CPU — same reason as RATE_LIMIT_LOOPBACK.
    throw new Error(
      'сервер запущен с подставным движком (engine: stub) — греть нечего. ' +
        'PREWARM_ALLOW_STUB=1, если это проверка самого прогрева',
    );
  }
  return health.body.params ?? {};
}

async function planTargets(args, params) {
  const plan = JSON.parse(await readFile(args.plan, 'utf8'));
  if (!Array.isArray(plan.tiles) || plan.tiles.length === 0) {
    throw new Error(`в ${args.plan} нет тайлов`);
  }
  if (params.radius !== undefined && plan.radius !== params.radius) {
    throw new Error(
      `план построен на радиус ${plan.radius} м, сервер считает ${params.radius} м — ` +
        'результаты лягут в кэш, который никто не прочитает. Пересоберите план ' +
        `(node scripts/plan-tiles.mjs --radius ${params.radius})`,
    );
  }
  const chosen = tilesForShare(plan.tiles, args.share);
  const owned = chosen.reduce((sum, t) => sum + t.owned, 0);
  const total = plan.totals?.buildings || owned;
  console.log(
    `план ${plan.name} от ${plan.generated?.slice(0, 10)}: ` +
      `${chosen.length} из ${plan.tiles.length} тайлов, ` +
      `${((owned / total) * 100).toFixed(1)}% застройки`,
  );
  return chosen.map((tile) => ({
    name: `${tile.lat.toFixed(4)},${tile.lon.toFixed(4)}`,
    lat: tile.lat,
    lon: tile.lon,
    seconds: tile.seconds,
    owned: tile.owned,
  }));
}

/**
 * A bare lattice around a point, for warming a district without asking Overpass
 * what is in it. Cheap to run and blunt: it will happily spend an hour on a
 * field, which is the whole reason plan-tiles.mjs exists.
 */
function gridTargets([lat, lon, km], params) {
  const radius = params.radius ?? 750;
  const dLat = (km * 1000) / 111320;
  const dLon = (km * 1000) / (111320 * Math.cos((lat * Math.PI) / 180));
  const centres = hexLattice(
    { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon },
    radius,
  );
  console.log(
    `решётка ${km} км вокруг ${lat},${lon} на радиусе ${radius} м: ${centres.length} точек`,
  );
  return centres.map((c) => ({ name: `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`, ...c }));
}

/**
 * Everything before the first job is a refusal to start, not a crash: a wrong
 * radius, a stub engine, a server that is not up. Those are all answers the
 * operator has to read and act on, and a stack trace on top of them buries the
 * one line that says what to do.
 */
async function collectTargets() {
  const args = parseArgs(process.argv.slice(2));
  const params = await serverParams();
  let targets;
  if (args.plan) targets = await planTargets(args, params);
  else if (args.grid) targets = gridTargets(args.grid, params);
  else if (args.points.length > 0) targets = args.points;
  else targets = [...PRESETS.moscow, ...PRESETS.spb];
  return Number.isFinite(args.limit) ? targets.slice(0, args.limit) : targets;
}

const targets = await collectTargets().catch((err) => {
  console.error(err.message);
  process.exit(2);
});

const predicted = targets.reduce((sum, t) => sum + (t.seconds ?? 0), 0);
console.log(
  `прогреваю ${targets.length} точек через ${BASE}` +
    (predicted > 0 ? `, по оценке ${(predicted / 3600).toFixed(1)} ч` : '') +
    '\n',
);

let warmed = 0;
let already = 0;
let failed = 0;
let spent = 0;
// Estimates come from a fit on fourteen runs; this machine and this Overpass are
// not those. Scaling what is left by how the finished ones actually went is a
// better guess than the fit alone, and it needs a few runs before it means
// anything — hence the guard on the count rather than on the ratio.
let predictedSoFar = 0;

const startedAt = Date.now();

/**
 * Two progress numbers, because tiles are not interchangeable. The plan is
 * ranked, so the first tiles carry far more of the city than the last: at a
 * third of the tiles the map already covers well over half the buildings. A bar
 * counting only tiles would understate what has been achieved all the way
 * through, which matters when the question is whether to stop early.
 */
const plannedOwned = targets.reduce((sum, t) => sum + (t.owned ?? 0), 0);
let coveredOwned = 0;
// Milestones are their own lines so a watcher can follow an overnight batch
// without reading every tile.
const MILESTONE = 5;
let nextMilestone = MILESTONE;

function progress(index) {
  const tiles = ((index + 1) / targets.length) * 100;
  if (plannedOwned === 0) return `${tiles.toFixed(0)}% точек`;
  return `${tiles.toFixed(0)}% тайлов, ${((coveredOwned / plannedOwned) * 100).toFixed(0)}% застройки`;
}

function milestone(index) {
  if (plannedOwned === 0) return;
  const share = (coveredOwned / plannedOwned) * 100;
  if (share < nextMilestone) return;
  while (nextMilestone <= share) nextMilestone += MILESTONE;
  const elapsed = (Date.now() - startedAt) / 3600000;
  console.log(
    `@@MARK застройка ${share.toFixed(0)}% · тайлов ${index + 1}/${targets.length}` +
      ` · прошло ${elapsed.toFixed(1)} ч · посчитано ${warmed}, из кэша ${already}, ошибок ${failed}`,
  );
}

const summary = () => {
  console.log(
    `\nпосчитано ${warmed}, уже было ${already}, с ошибкой ${failed}` +
      `, всего ${((Date.now() - startedAt) / 3600000).toFixed(2)} ч` +
      (plannedOwned > 0
        ? `, накрыто ${((coveredOwned / plannedOwned) * 100).toFixed(1)}% застройки плана`
        : ''),
  );
};
// A batch is hours long, and Ctrl+C on hour three should still say what it did.
// The pipeline in flight is detached from this process and finishes on its own.
process.on('SIGINT', () => {
  console.log('\nостановлено; расчёт, начатый последним, доводится сервером до конца');
  summary();
  process.exit(130);
});

for (const [index, target] of targets.entries()) {
  const started = Date.now();
  process.stdout.write(
    `${String(index + 1).padStart(4)}/${targets.length} ${target.name.padEnd(24)} `,
  );
  try {
    // Без предварительной карты: её никто не увидит, а стоит она 12–22%
    // времени расчёта. Прогрев ждёт результат, а не картинку.
    const created = await postJson('/api/noise', {
      lat: target.lat,
      lon: target.lon,
      preview: false,
    });
    if (created.body.cached) {
      already += 1;
      coveredOwned += target.owned ?? 0;
      // Точка может быть не посчитана сама, но попадать внутрь соседнего диска —
      // тогда она и так открывается мгновенно, и греть её нечем.
      const how = created.body.covering ? 'накрыта соседним расчётом' : 'уже в кэше';
      console.log(`${how} · ${progress(index)}`);
      milestone(index);
      continue;
    }
    if (created.status !== 200 && created.status !== 202) {
      throw new Error(created.body?.error ?? `HTTP ${created.status}`);
    }
    let lastLabel = '';
    await waitForJob(created.body.id, (state) => {
      if (state.label !== lastLabel) {
        lastLabel = state.label;
        process.stdout.write('.');
      }
    });
    warmed += 1;
    coveredOwned += target.owned ?? 0;
    const seconds = (Date.now() - started) / 1000;
    spent += seconds;
    predictedSoFar += target.seconds ?? 0;

    let eta = '';
    const remaining = targets.slice(index + 1);
    if (warmed >= 3 && predictedSoFar > 0 && remaining.some((t) => t.seconds)) {
      // Only the runs that actually computed are used to calibrate: a cache hit
      // costs milliseconds and would drag the correction towards zero.
      const correction = spent / predictedSoFar;
      const left = remaining.reduce((sum, t) => sum + (t.seconds ?? 0), 0) * correction;
      eta = ` · осталось ~${(left / 3600).toFixed(1)} ч`;
    }
    console.log(` ${seconds.toFixed(0)} с · ${progress(index)}${eta}`);
    milestone(index);
  } catch (err) {
    failed += 1;
    console.log(`ошибка: ${err.message} · ${progress(index)}`);
    // A failed tile is still a tile the batch will not come back to, so the
    // milestone line has to keep moving — otherwise a run where a stretch of
    // points has no roads goes quiet and looks hung.
    milestone(index);
  }
}

summary();
process.exit(failed > 0 ? 1 : 0);
