/**
 * Precomputes noise maps for a set of locations so a demo opens instantly.
 *
 * A cold click costs one to two minutes, which is fine for exploration but fatal
 * for a link someone opens once. Running this ahead of time puts the demo
 * locations in the cache; everywhere else still computes on demand.
 *
 * Usage:
 *   node scripts/prewarm.mjs              # default demo set
 *   node scripts/prewarm.mjs moscow       # one preset
 *   node scripts/prewarm.mjs 55.75,37.61  # explicit coordinates
 */
import { request as undiciRequest } from 'undici';

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

function parseTargets(argv) {
  if (argv.length === 0) return [...PRESETS.moscow, ...PRESETS.spb];

  const targets = [];
  for (const arg of argv) {
    if (PRESETS[arg]) {
      targets.push(...PRESETS[arg]);
      continue;
    }
    const [lat, lon] = arg.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(
        `не разобрал "${arg}" — ожидается пресет (${Object.keys(PRESETS).join(', ')}) или "lat,lon"`,
      );
    }
    targets.push({ name: `${lat},${lon}`, lat, lon });
  }
  return targets;
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

const targets = parseTargets(process.argv.slice(2));
console.log(`прогреваю ${targets.length} точек через ${BASE}\n`);

let warmed = 0;
let already = 0;
let failed = 0;

for (const target of targets) {
  const started = Date.now();
  process.stdout.write(`${target.name.padEnd(30)} `);
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
      // Точка может быть не посчитана сама, но попадать внутрь соседнего диска —
      // тогда она и так открывается мгновенно, и греть её нечем.
      const how = created.body.covering ? 'накрыта соседним расчётом' : 'уже в кэше';
      console.log(`${how} (${(created.body.bytes / 1024).toFixed(0)} КБ)`);
      continue;
    }
    let lastLabel = '';
    await waitForJob(created.body.id, (state) => {
      if (state.label !== lastLabel) {
        lastLabel = state.label;
        process.stdout.write('.');
      }
    });
    warmed += 1;
    console.log(` готово за ${((Date.now() - started) / 1000).toFixed(0)} с`);
  } catch (err) {
    failed += 1;
    console.log(`ошибка: ${err.message}`);
  }
}

console.log(`\nпосчитано ${warmed}, уже было ${already}, с ошибкой ${failed}`);
process.exit(failed > 0 ? 1 : 0);
