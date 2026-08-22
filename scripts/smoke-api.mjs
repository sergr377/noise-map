/**
 * Exercises the HTTP layer end to end: health, job creation, SSE progress,
 * result download, and the cache hit on a repeat request.
 *
 * Every step is a named check, and the process exits 1 if any of them failed —
 * so this can gate a build rather than only inform a human reading the log.
 * Checks whose outcome depends on the environment rather than on the code are
 * reported as skipped, not as passed: the rate limit does not apply to loopback,
 * and a neighbouring point may already be in the cache.
 *
 * Needs a running server, and a cold point costs minutes of real calculation.
 *
 * Usage: node scripts/smoke-api.mjs [lat] [lon]
 */
import { request as undiciRequest } from 'undici';

const BASE = process.env.API_BASE ?? 'http://localhost:8787';
const lat = Number(process.argv[2] ?? 55.7558);
const lon = Number(process.argv[3] ?? 37.6173);

const checks = [];

/** Records a verdict and prints it as it happens, next to the output it judges. */
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** For what the environment decides, not the code. Never fails the run. */
function skip(name, why) {
  checks.push({ name, skipped: true });
  console.log(`  SKIP ${name} — ${why}`);
}

/**
 * Withdraws interest in a calculation, waiting out the rate limiter if it has
 * to. A refused DELETE is not a failed check — it is a job left running for the
 * next quarter of an hour, which matters more than the check does.
 */
async function cancelJob(id, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`${BASE}/api/noise/${id}`, { method: 'DELETE' });
    const body = await res.json();
    if (res.status !== 429) return { status: res.status, body };
    const wait = (Number(body.retryAfter) || 1) * 1000 + 200;
    console.log(`  отмена отклонена лимитом, повтор через ${wait} мс`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return { status: 429, body: { error: 'лимит частоты не пустил отмену' } };
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log('health:', health);
check('health отвечает ok', health.ok === true);

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
// 200 — уже посчитано, 202 — расчёт принят в работу.
check('POST /api/noise принят', first.status === 200 || first.status === 202, `HTTP ${first.status}`);
check(
  'в ответе есть id, центр и радиус',
  typeof first.body.id === 'string' &&
    Number.isFinite(first.body.centre?.lat) &&
    Number.isFinite(first.body.centre?.lon) &&
    Number.isFinite(first.body.radius),
);

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
  let finalStage = '';
  let framesBroken = 0;

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
        if (!gj?.features) framesBroken += 1;
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
        finalStage = state.stage;
        console.log(`  final:`, state);
        console.log(`  progress events received: ${ticks}, промежуточных карт: ${frames}`);
        break outer;
      }
    }
  }

  check('поток прогресса что-то сообщил', ticks > 0, `событий: ${ticks}`);
  check('расчёт завершился успехом', finalStage === 'done', `стадия: ${finalStage || 'поток оборвался'}`);
  if (frames === 0) {
    // Кадры по умолчанию выключены (PARTIAL_INTERVAL_MS=0) — их отсутствие
    // здесь не дефект, а настройка.
    skip('промежуточные кадры разбираются', 'сервер не прислал ни одного кадра');
  } else {
    check('промежуточные кадры разбираются', framesBroken === 0, `кадров: ${frames}`);
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
check('GET result -> 200', resultRes.status === 200, `HTTP ${resultRes.status}`);
check('результат ушёл сжатым', raw.headers['content-encoding'] === 'gzip');
check('gzip действительно меньше', wire < buf.byteLength, `${wire} против ${buf.byteLength} байт`);
check(
  'результат — FeatureCollection с контурами',
  gj.type === 'FeatureCollection' && gj.features.length > 0,
  `контуров: ${gj.features?.length ?? 0}`,
);

// A second identical request must be served from cache, instantly.
const tCache = Date.now();
const second = await request();
const cacheMs = Date.now() - tCache;
console.log(`POST again -> ${second.status} cached=${second.body.cached} in ${cacheMs}ms`);
check('повтор отдан из кэша', second.body.cached === true);
// Не замер производительности: порог грубый и ловит только случай, когда
// «из кэша» на самом деле означает новый расчёт.
check('из кэша отвечает сразу', cacheMs < 2000, `${cacheMs} мс`);

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
const drift = Math.abs(again.centre.lat - centre.lat) + Math.abs(again.centre.lon - centre.lon);
console.log(`centre re-snaps to itself: ${again.id === first.body.id}, cached=${again.cached}, drift=${drift}`);
check('центр ячейки округляется сам в себя', again.id === first.body.id && drift === 0);

// Клик мимо центра, но внутри посчитанного круга, обязан открыться из кэша:
// диск показа 750 м, а ячейка кэша ~100 м, так что без этого правила почти любой
// клик по затенённой области запускал бы расчёт заново.
const near = { lat: centre.lat + 500 / 111320, lon: centre.lon };
const nearRes = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(near),
}).then((r) => r.json());
const nearOffset = Math.round(
  Math.hypot(
    (nearRes.centre.lat - near.lat) * 111320,
    (nearRes.centre.lon - near.lon) * 111320 * Math.cos((near.lat * Math.PI) / 180),
  ),
);
console.log(
  `клик в 500 м от центра: cached=${nearRes.cached}, накрывающий=${nearRes.covering === true}, ` +
    `центр в ${nearOffset} м от клика`,
);
check('клик в 500 м от центра открывается из кэша', nearRes.cached === true);
if (nearRes.id === first.body.id) {
  check('ответ помечен как накрывающий', nearRes.covering === true);
} else {
  skip('ответ помечен как накрывающий', 'эта ячейка уже посчитана сама по себе');
}
// Если правило сломалось, мы только что заказали расчёт на четверть часа.
if (!nearRes.cached && nearRes.id) {
  await cancelJob(nearRes.id);
  console.log('  расчёт, запущенный по ошибке, отменён');
}

// Garbage input must be rejected rather than queued.
const bad = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lat: 'nope', lon: 999 }),
});
console.log(`invalid coords -> ${bad.status} ${JSON.stringify(await bad.json())}`);
check('кривые координаты отклонены', bad.status === 400, `HTTP ${bad.status}`);

// Посчитанные области в рамке — то, что карта спрашивает при каждой остановке
// камеры, чтобы затенить готовые места. Точка выше только что посчиталась, так
// что хотя бы одна область здесь обязана найтись.
const box = [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05].map((n) => n.toFixed(5)).join(',');
const areas = await fetch(`${BASE}/api/noise/areas?bbox=${box}`).then((r) => r.json());
const own = areas.areas.filter((a) => a.id === first.body.id).length;
console.log(
  `areas в рамке ±0.05°: ${areas.areas.length}, своя точка среди них: ${own === 1}` +
    (areas.areas[0] ? `, радиус ${Math.round(areas.areas[0].radius)} м` : ''),
);
check('своя посчитанная область видна в рамке', own === 1, `областей всего: ${areas.areas.length}`);
const badBox = await fetch(`${BASE}/api/noise/areas?bbox=nonsense`);
console.log(`  кривой bbox -> ${badBox.status} ${JSON.stringify(await badBox.json())}`);
check('кривой bbox отклонён', badBox.status === 400, `HTTP ${badBox.status}`);

// --- отмена -----------------------------------------------------------------
//
// Точка берётся в стороне от основной, чтобы не попасть в её кэш. Задача живёт
// секунду и снимается: проверяется, что сервер сообщает об отмене, поток
// прогресса закрывается стадией `cancelled`, а результата у задачи не будет.
const spare = { lat: lat + 0.01, lon: lon + 0.01 };
const cancelRes = await fetch(`${BASE}/api/noise`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(spare),
});
const cancelTarget = await cancelRes.json();

if (cancelRes.status !== 200 && cancelRes.status !== 202) {
  // 429 — бюджет расчётов исчерпан, 503 — сервер в режиме «только кэш». И то и
  // другое про окружение, а не про код: запускать здесь нечего, значит и
  // отменять нечего.
  console.log(`cancel: пропущено — POST ответил ${cancelRes.status}`, cancelTarget);
  skip('отмена расчёта', `запустить задачу не дали: HTTP ${cancelRes.status}`);
} else if (cancelTarget.cached) {
  console.log('cancel: пропущено — соседняя точка уже в кэше');
  skip('отмена расчёта', 'соседняя точка уже в кэше, отменять нечего');
} else {
  // Пока задача ещё считается — сколько подписок на прогресс сервер позволяет
  // держать открытыми разом. Это ограничение по занятости, а не по
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
  if (refusedAt) check('лишние подписки на прогресс отклоняются', refusedAt > 1, `отказ на ${refusedAt}-й`);
  else skip('лишние подписки на прогресс отклоняются', 'адрес в исключениях или лимит больше десяти');
  // Слоты обязаны вернуться до проверки отмены ниже, иначе её поток откажут.
  for (const body of probes) await body.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  // Стадия из SSE, а не из ответа на DELETE: важно именно то, что видит клиент,
  // который в этот момент следит за прогрессом.
  const events = await fetch(`${BASE}/api/noise/${cancelTarget.id}/events`);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();

  const { status: cancelStatus, body: cancelled } = await cancelJob(cancelTarget.id);
  console.log(`DELETE /api/noise/:id ->`, cancelled);
  // cancelled: false при waiters > 0 — не дефект: запросы к одной точке делят
  // один расчёт, и уход одного из них не вправе остановить работу для
  // остальных. На практике так выглядит недобитый прогон этого же скрипта.
  const shared = cancelled.cancelled === false && cancelled.waiters > 0;
  if (cancelStatus === 429) skip('DELETE сообщил об отмене', 'лимит частоты не пустил отмену');
  else if (shared) skip('DELETE сообщил об отмене', `расчёт ждёт ещё ${cancelled.waiters} — прерванный прогон?`);
  else check('DELETE сообщил об отмене', cancelled.cancelled === true);

  // Ждать закрытия потока можно только у остановленного расчёта. У живого он
  // не закроется до самого конца — минуты, а то и четверть часа молчания.
  const stopped = cancelStatus !== 429 && !shared;
  let lastStage = '';
  if (!stopped) {
    await reader.cancel().catch(() => {});
  } else {
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
  }

  const afterCancel = await fetch(`${BASE}/api/noise/${cancelTarget.id}/result`);
  const afterCancelBody = await afterCancel.json();
  console.log(`  GET result отменённой -> ${afterCancel.status} ${JSON.stringify(afterCancelBody)}`);

  const unknown = await fetch(`${BASE}/api/noise/${'0'.repeat(16)}`, { method: 'DELETE' });
  console.log(`  DELETE несуществующей -> ${unknown.status}`);

  // Всё, что ниже, имеет смысл только если отмена состоялась. Иначе это отчёт
  // о лимитере, а не о поведении сервера при отмене.
  if (!stopped) {
    const why = shared ? 'расчёт остался жить для других ожидающих' : 'отмена не прошла лимит частоты';
    skip('поток закрылся стадией cancelled', why);
    skip('у отменённой задачи нет результата', why);
  } else {
    check('поток закрылся стадией cancelled', lastStage === 'cancelled', `стадия: ${lastStage}`);
    // 409, а не 404: задача существует, просто результата у неё не будет никогда.
    check(
      'у отменённой задачи нет результата',
      afterCancel.status === 409,
      `HTTP ${afterCancel.status}`,
    );
  }
  if (unknown.status === 429) skip('DELETE несуществующей -> 404', 'лимит частоты ответил раньше');
  else check('DELETE несуществующей -> 404', unknown.status === 404, `HTTP ${unknown.status}`);
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
  skip('лимит частоты отклоняет пачку', 'адрес в исключениях (RATE_LIMIT_LOOPBACK=0)');
} else {
  console.log(
    `rate limit: ${refused.length} из ${burst} отклонено с 429, ` +
      `Retry-After=${refused[0].retryAfter} с, первое отклонение на запросе ` +
      `${codes.findIndex((c) => c.status === 429) + 1}`,
  );
  check('лимит частоты отклоняет пачку', refused.length > 0, `${refused.length} из ${burst}`);
  check(
    'отказ несёт Retry-After',
    Number(refused[0].retryAfter) > 0,
    `Retry-After=${refused[0].retryAfter}`,
  );
}

// --- итог -------------------------------------------------------------------
const failed = checks.filter((c) => c.ok === false);
const skipped = checks.filter((c) => c.skipped);
console.log(
  `\nпроверок ${checks.length}: прошло ${checks.length - failed.length - skipped.length}, ` +
    `провалено ${failed.length}, пропущено ${skipped.length}`,
);
for (const c of failed) console.log(`  FAIL ${c.name}`);
process.exit(failed.length === 0 ? 0 : 1);
