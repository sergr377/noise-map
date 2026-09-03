/**
 * The cache-only mode, end to end.
 *
 * `CACHE_ONLY=1` is what makes a demo on a small host defensible: the API keeps
 * serving everything already computed and refuses to start anything new, so a
 * single click cannot take every core for a quarter of an hour. It was written,
 * documented and never exercised — no test, no CI step, no recorded run — while
 * the hosting decision rests on it.
 *
 * What has to hold is a pair of rules, not one. New work must be refused, and
 * everything that does not start work must keep answering: the probe, the shaded
 * areas, health. A mode that refuses the click *and* stops telling the map which
 * places are ready would leave a visitor with a grey screen and no explanation —
 * which is a worse demo than no demo.
 *
 * Needs a running server with `CACHE_ONLY=1` and a cache that is not empty. The
 * computed point is discovered through `/api/noise/areas` rather than hardcoded,
 * so this runs against the warmed demo cache and against CI's invented one alike.
 *
 * Usage: node scripts/smoke-cache-only.mjs
 */
const BASE = process.env.API_BASE ?? 'http://localhost:8787';

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

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const post = async (lat, lon) => {
  const res = await fetch(`${BASE}/api/noise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const summary = () => {
  const failed = checks.filter((c) => c.ok === false);
  const skipped = checks.filter((c) => c.skipped);
  console.log(
    `\nпроверок ${checks.length}: прошло ${checks.length - failed.length - skipped.length}, ` +
      `провалено ${failed.length}, пропущено ${skipped.length}`,
  );
  for (const c of failed) console.log(`  FAIL ${c.name}`);
  return failed.length === 0 ? 0 : 1;
};

// --- сервер в нужном режиме -------------------------------------------------

const health = await get('/api/health');
console.log('health:', JSON.stringify(health.body));
check('health отвечает ok', health.body.ok === true);

// Без этого всё остальное проверяло бы обычный сервер и радостно проходило:
// холодная точка ушла бы в расчёт, а не в отказ.
if (health.body.cacheOnly !== true) {
  check('сервер запущен с CACHE_ONLY=1', false, 'health не сообщает cacheOnly — режим не включён');
  process.exit(summary());
}
check('сервер запущен с CACHE_ONLY=1', true);

// --- что уже посчитано ------------------------------------------------------

// Весь мир одним запросом: областей всё равно не больше, чем отдаёт маршрут.
const areas = await get('/api/noise/areas?bbox=-180,-90,180,90');
check('areas отвечает под CACHE_ONLY', areas.status === 200, `HTTP ${areas.status}`);

const warm = areas.body.areas?.[0];
if (!warm) {
  skip('кэшированная точка отдаётся', 'кэш пуст — нечего отдавать');
  skip('холодная точка отклонена', 'без кэша режим не отличить от пустого сервера');
  process.exit(summary());
}
check(
  'areas видит посчитанные области',
  areas.body.areas.length > 0,
  `${areas.body.areas.length} шт., первая ${warm.lat.toFixed(4)},${warm.lon.toFixed(4)}`,
);

// --- готовое отдаётся -------------------------------------------------------

const hit = await post(warm.lat, warm.lon);
check(
  'кэшированная точка отдаётся, а не отклоняется',
  hit.status === 200 && hit.body.cached === true,
  `HTTP ${hit.status}, cached=${hit.body.cached}`,
);
check('и приходит с размером результата', Number(hit.body.bytes) > 0, `${hit.body.bytes} байт`);

// --- нового не считаем ------------------------------------------------------

/** Точка, которой в кэше быть не может: отступ от посчитанной на десятки градусов. */
async function findCold() {
  for (const [dLat, dLon] of [
    [10, 10],
    [-20, -20],
    [30, -30],
  ]) {
    const lat = Math.max(-85, Math.min(85, warm.lat + dLat));
    const lon = ((((warm.lon + dLon + 180) % 360) + 360) % 360) - 180;
    const probe = await get(`/api/noise?lat=${lat}&lon=${lon}`);
    if (probe.status === 200 && probe.body.cached === false) return { lat, lon, probe };
  }
  return null;
}

const cold = await findCold();
if (!cold) {
  skip('холодная точка отклонена', 'не нашлось точки вне кэша');
  process.exit(summary());
}

check(
  'probe отвечает по холодной точке',
  cold.probe.status === 200 && cold.probe.body.cached === false,
  'карта продолжает узнавать, что готово, а что нет',
);

const refused = await post(cold.lat, cold.lon);
check('холодная точка отклонена с 503', refused.status === 503, `HTTP ${refused.status}`);
check('отказ несёт признак cacheOnly', refused.body.cacheOnly === true);
// Фронтенд показывает пользователю именно это поле (`api.ts`), так что пустой
// текст здесь — это молча сломанный экран, а не мелочь.
check(
  'отказ несёт текст для человека',
  typeof refused.body.error === 'string' && refused.body.error.length > 20,
  refused.body.error ? `«${refused.body.error.slice(0, 60)}…»` : 'текста нет',
);

// Отказ должен случиться до старта работы, а не вместо её результата: иначе
// слабый хост всё равно займут, только тихо.
const after = await get(`/api/noise?lat=${cold.lat}&lon=${cold.lon}`);
check(
  'отказ ничего не запустил',
  after.body.cached === false && after.body.state === undefined,
  after.body.state ? `осталась задача в стадии ${after.body.state.stage}` : 'задачи нет',
);

// --- служебное не заблокировано ---------------------------------------------

const healthAgain = await get('/api/health');
check(
  'health не отклоняется в этом режиме',
  healthAgain.status === 200 && healthAgain.body.ok === true,
  'платформенная проверка живости продолжает работать',
);

process.exit(summary());
