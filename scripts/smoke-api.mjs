/**
 * Exercises the HTTP layer end to end: health, job creation, SSE progress,
 * result download, and the cache hit on a repeat request.
 *
 * Usage: node scripts/smoke-api.mjs [lat] [lon]
 */
import { request as undiciRequest } from 'undici';

const BASE = process.env.API_BASE ?? 'http://localhost:8787';
const lat = Number(process.argv[2] ?? 55.7558);
const lon = Number(process.argv[3] ?? 37.6173);

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log('health:', health);

async function request() {
  const res = await fetch(`${BASE}/api/noise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon }),
  });
  return { status: res.status, body: await res.json() };
}

const t0 = Date.now();
const first = await request();
console.log(`POST /api/noise -> ${first.status}`, first.body);

if (!first.body.cached) {
  // Stream progress. Reported stages should advance monotonically and the bar
  // should keep moving during propagation rather than freezing at one value.
  const res = await fetch(`${BASE}/api/noise/${first.body.id}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastLabel = '';
  let ticks = 0;
  let frames = 0;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const state = JSON.parse(line.slice(6));
      ticks += 1;
      // Промежуточные карты: сервер сообщает только их число, геометрию клиент
      // забирает сам. Проверяем, что кадр действительно отдаётся и разбирается.
      if ((state.partials ?? 0) > frames) {
        frames = state.partials;
        const res = await fetch(`${BASE}/api/noise/${first.body.id}/partial/${frames}`);
        const gj = res.ok ? await res.json() : null;
        console.log(
          `  [${((Date.now() - t0) / 1000).toFixed(0)}s] кадр ${frames} -> ${res.status}` +
            (gj ? `, ${gj.features.length} контуров` : ''),
        );
      }
      if (state.label !== lastLabel) {
        console.log(
          `  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${state.label} ${(state.progress * 100).toFixed(0)}%`,
        );
        lastLabel = state.label;
      }
      if (state.stage === 'done' || state.stage === 'error') {
        console.log(`  final:`, state);
        console.log(`  progress events received: ${ticks}, промежуточных карт: ${frames}`);
        break outer;
      }
    }
  }
}

const resultRes = await fetch(`${BASE}/api/noise/${first.body.id}/result`);
const buf = Buffer.from(await resultRes.arrayBuffer());

// fetch decompresses transparently and drops Content-Length while doing so, so
// measuring the transferred size needs a client that leaves the body encoded.
const raw = await undiciRequest(`${BASE}/api/noise/${first.body.id}/result`, {
  headers: { 'accept-encoding': 'gzip' },
});
let wire = 0;
for await (const chunk of raw.body) wire += chunk.length;
console.log(
  `GET result -> ${resultRes.status}, ${(wire / 1024).toFixed(0)} KB on the wire ` +
    `(${raw.headers['content-encoding'] ?? 'identity'}) -> ${(buf.byteLength / 1024).toFixed(0)} KB decoded`,
);
const gj = JSON.parse(buf.toString('utf8'));
console.log(`  features: ${gj.features.length}, type: ${gj.type}`);

// A second identical request must be served from cache, instantly.
const tCache = Date.now();
const second = await request();
console.log(
  `POST again -> ${second.status} cached=${second.body.cached} in ${Date.now() - tCache}ms`,
);

// Snapping must be idempotent: posting the cell centre has to resolve to that
// same cell. Testing with an arbitrary small offset would be flaky instead —
// a click sitting on a cell boundary flips cells under a nudge of a few metres,
// which is inherent to grid snapping and not a defect.
const centre = first.body.centre;
const again = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(centre),
}).then((r) => r.json());
console.log(
  `centre re-snaps to itself: ${again.id === first.body.id}, cached=${again.cached}, ` +
    `drift=${Math.abs(again.centre.lat - centre.lat) + Math.abs(again.centre.lon - centre.lon)}`,
);

// Garbage input must be rejected rather than queued.
const bad = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lat: 'nope', lon: 999 }),
});
console.log(`invalid coords -> ${bad.status} ${JSON.stringify(await bad.json())}`);

// --- отмена -----------------------------------------------------------------
//
// Точка берётся в стороне от основной, чтобы не попасть в её кэш. Задача живёт
// секунду и снимается: проверяется, что сервер сообщает об отмене, поток
// прогресса закрывается стадией `cancelled`, а результата у задачи не будет.
const spare = { lat: lat + 0.01, lon: lon + 0.01 };
const cancelTarget = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(spare),
}).then((r) => r.json());

if (cancelTarget.cached) {
  console.log('cancel: пропущено — соседняя точка уже в кэше');
} else {
  // Пока задача ещё считается — сколько подписок на прогресс сервер позволяет
  // держать открытыми одновременно. Это ограничение по занятости, а не по
  // частоте: соединение живёт весь расчёт, а стоило одного токена бюджета.
  const probes = [];
  let refusedAt = 0;
  for (let i = 1; i <= 10 && !refusedAt; i += 1) {
    const res = await fetch(`${BASE}/api/noise/${cancelTarget.id}/events`);
    if (res.status === 429) refusedAt = i;
    else probes.push(res.body);
  }
  console.log(
    refusedAt
      ? `  одновременные подписки: отказ на ${refusedAt}-й с 429`
      : '  одновременные подписки: десять прошло — адрес в исключениях (loopback) ' +
          'или STREAM_LIMIT_PER_IP больше десяти',
  );
  // Слоты обязаны вернуться до проверки отмены ниже, иначе её поток откажут.
  for (const body of probes) await body.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  // Стадия из SSE, а не из ответа на DELETE: важно именно то, что видит клиент,
  // который в этот момент следит за прогрессом.
  const events = await fetch(`${BASE}/api/noise/${cancelTarget.id}/events`);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();

  const cancelled = await fetch(`${BASE}/api/noise/${cancelTarget.id}`, { method: 'DELETE' }).then(
    (r) => r.json(),
  );
  console.log(`DELETE /api/noise/:id ->`, cancelled);

  let lastStage = '';
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (line) lastStage = JSON.parse(line.slice(6)).stage;
    }
  }
  console.log(`  поток закрылся на стадии "${lastStage}" (ожидается cancelled)`);

  const afterCancel = await fetch(`${BASE}/api/noise/${cancelTarget.id}/result`);
  console.log(
    `  GET result отменённой -> ${afterCancel.status} ${JSON.stringify(await afterCancel.json())}`,
  );

  const unknown = await fetch(`${BASE}/api/noise/${'0'.repeat(16)}`, { method: 'DELETE' });
  console.log(`  DELETE несуществующей -> ${unknown.status}`);
}

// --- ограничение частоты ----------------------------------------------------
//
// Идёт последней: после неё бюджет адреса исчерпан и всё остальное получало бы
// 429. Запросы намеренно дешёвые — проверяется счётчик, а не работа сервера.
const burst = 80;
const codes = [];
for (let i = 0; i < burst; i += 1) {
  const res = await fetch(`${BASE}/api/noise/${'f'.repeat(16)}/result`);
  codes.push({ status: res.status, retryAfter: res.headers.get('retry-after') });
}
const refused = codes.filter((c) => c.status === 429);
if (refused.length === 0) {
  console.log(
    `rate limit: ${burst} запросов подряд прошли — адрес в исключениях ` +
      '(loopback). Чтобы проверить лимит, запустите сервер с RATE_LIMIT_LOOPBACK=1',
  );
} else {
  console.log(
    `rate limit: ${refused.length} из ${burst} отклонено с 429, ` +
      `Retry-After=${refused[0].retryAfter} с, первое отклонение на запросе ` +
      `${codes.findIndex((c) => c.status === 429) + 1}`,
  );
}
