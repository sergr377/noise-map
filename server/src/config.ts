import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { Stage } from '../../shared/stages.mjs';

/** Repository root: this file lives two levels down, both in src/ and in dist/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// .env is optional — the server runs fine without it, only the frontend needs a key.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  // Only a missing file is ordinary. Anything else — no permission to read it,
  // a directory in its place, a Node too old to have loadEnvFile at all — also
  // leaves every variable unset, and that failure then looks like a broken
  // location or a dead Overpass rather than a server started without its
  // configuration. Once was enough.
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// Node's fetch ignores HTTP(S)_PROXY, unlike curl or PowerShell. On a machine
// behind a proxy an unreachable host looks like a dead service instead, so
// honour the env vars explicitly — same reason as in scripts/lib.mjs.
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

export const PORT = Number(process.env.PORT ?? 8787);

/**
 * Геокодер. Пусто — публичный инстанс Nominatim.
 *
 * Ключа нет и не нужно, но остаётся правило хозяев: не чаще запроса в секунду
 * и опознаваемый User-Agent с рабочим контактом, иначе 403. Свой инстанс
 * снимает и то и другое — тогда NOMINATIM_MIN_INTERVAL_MS можно поставить в
 * ноль. Запрос по-прежнему идёт через сервер, а не из браузера: адрес
 * посетителя чужому сервису знать незачем, а очередь ниже общая на процесс и
 * из браузера была бы невозможна.
 */
export const NOMINATIM_URL = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';

/** Чем представляемся геокодеру. Nominatim отвергает безымянных. */
export const NOMINATIM_CONTACT =
  process.env.NOMINATIM_CONTACT ?? 'noise-map (https://github.com/sergr377/noise-map)';

/**
 * Пауза между запросами к геокодеру, мс. Умолчание с запасом к секунде,
 * которую просит публичный инстанс: часы клиента и сервера расходятся, а
 * штраф за превышение — бан, а не отказ в одном запросе.
 */
export const NOMINATIM_MIN_INTERVAL_MS = Number(process.env.NOMINATIM_MIN_INTERVAL_MS ?? 1100);

/**
 * The propagation step already saturates every core, so running two jobs at once
 * makes both slower without improving throughput.
 */
export const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 1);

/**
 * Where finished maps are kept. Overridable so a run that is not producing real
 * maps — see RUN_JOB_SCRIPT below — can be pointed somewhere disposable and
 * leave nothing behind.
 */
export const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(ROOT, process.env.CACHE_DIR)
  : path.join(ROOT, 'cache');

/**
 * Built frontend. When present the API also serves it, so a deployment is one
 * process instead of an API plus a separate static host. In development Vite
 * serves the frontend and proxies /api here, and this directory does not exist.
 */
export const WEB_DIST = path.join(ROOT, 'dist-web');

/**
 * Карта-подложка: .pmtiles, стиль, глифы и спрайт. Отдельно от WEB_DIST, потому
 * что это данные, а не сборка: файл тайлов на порядок больше всего остального в
 * образе, поэтому в образ он не кладётся, а подключается томом — как cache/.
 * Каталога может не быть вовсе: без него карта не откроется, но API живёт.
 */
export const TILES_DIR = process.env.TILES_DIR
  ? path.resolve(ROOT, process.env.TILES_DIR)
  : path.join(ROOT, 'tiles');

/**
 * Refuse to compute on demand. A cold job needs ~1.8 GB of heap and several
 * minutes of every core; on a small host that is a denial of service waiting to
 * happen. With this set the API still serves anything already in the cache.
 */
export const CACHE_ONLY = process.env.CACHE_ONLY === '1';
/**
 * Кто может обращаться к API из браузера. Пусто — любой: для публичного
 * read-mostly сервиса без cookie и без аутентификации это защитимый выбор,
 * и он остаётся значением по умолчанию.
 *
 * Но POST /api/noise не бесплатен: холодный клик занимает все ядра на
 * минуты и тратит бюджет расчётов посетителя. Пока стоит звёздочка, любой
 * сторонний сайт может встроить этот вызов и потратить чужой бюджет. Список
 * источников через запятую закрывает эту дверь в проде — и теперь это
 * единственная такая дверь: ключа с ограничением по Referer, который раньше
 * прикрывал хотя бы карту, в проекте не осталось.
 */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REAL_JOB_SCRIPT = path.join(ROOT, 'scripts', 'run-job.mjs');

/**
 * The pipeline the server spawns for a job.
 *
 * Overridable because the HTTP layer and the engine are separable, and only one
 * of them can be tested on an ordinary runner: `scripts/fake-job.mjs` speaks
 * the same marker protocol, writes the same files and computes nothing, which
 * is what lets `smoke-api.mjs` gate a build (see .github/workflows/ci.yml). A
 * relative path is taken from the repository root.
 */
export const RUN_JOB_SCRIPT = process.env.RUN_JOB_SCRIPT
  ? path.resolve(ROOT, process.env.RUN_JOB_SCRIPT)
  : REAL_JOB_SCRIPT;

/**
 * Whether the maps this server produces are computed at all. A server quietly
 * serving invented isophones is a worse failure than one that is plainly down,
 * so this is said at startup and answered by /api/health.
 */
export const ENGINE_IS_REAL = RUN_JOB_SCRIPT === REAL_JOB_SCRIPT;

/**
 * How often a running job exports the map of what it has computed so far. Zero
 * switches the frames off, and that is the default now: propagation fills the
 * disc cell by cell, so a frame is exact but covers a quarter of the area — on
 * Tverskaya the first one arrived at 83 s with 6% of the receivers, and half the
 * disc was drawn only in the tenth minute. PREVIEW_SRC_DIST below buys the whole
 * area at once instead, and a frame must never replace it: the map would appear
 * to shrink back to a quadrant.
 *
 * Deliberately not part of JOB_PARAMS: it changes nothing about the result, and
 * putting it there would make the whole cache unreachable over a display
 * setting. The pipeline also backs off on its own when a frame turns out
 * expensive, so this is a floor rather than a promise.
 */
export const PARTIAL_INTERVAL_MS = Number(process.env.PARTIAL_INTERVAL_MS ?? 0);

/**
 * Source distance, in metres, for the preview pass that runs before the real
 * one; zero skips it. The preview covers the whole disc from the start, and how
 * far it reaches is the whole trade — the far sources it drops are exactly what
 * makes the exact pass slow.
 *
 * Measured on Tverskaya, against the exact map (350 m, 926 s of propagation):
 *
 *   150 m — 97 s, 9.9% of the area a band off, 1.1 dB low
 *    75 m — 38 s, 19.0% a band off, 2.7 dB low
 *
 * Set to 75: a complete map about a minute after the click is worth more here
 * than a more accurate one at two and a half minutes, given the exact answer is
 * a quarter of an hour away regardless. The interface says plainly how rough it
 * is — see the note in App.tsx, and keep the two in step if this number moves.
 *
 * The honest result costs ~6% more wall clock for it, and only when somebody is
 * watching: prewarming runs without this, as it does without frames.
 *
 * Not part of JOB_PARAMS for the same reason as the frames — the cached result
 * is the exact one either way.
 */
export const PREVIEW_SRC_DIST = Number(process.env.PREVIEW_SRC_DIST ?? 75);

/**
 * How long a cancelled pipeline gets to exit on its own before it is killed
 * outright. The JVM has nothing to flush here — the grace only avoids leaving a
 * half-written H2 file that the next run would have to delete anyway.
 */
export const KILL_GRACE_MS = Number(process.env.KILL_GRACE_MS ?? 5_000);

/**
 * Client address for rate limiting. Behind a reverse proxy every request arrives
 * from the proxy, so the real address is only in `X-Forwarded-For` — and that
 * header is trivially forged, which would let one client pose as thousands.
 * Trusting it is therefore opt-in and correct only when nothing can reach the
 * server except the proxy.
 */
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/**
 * Requests from the machine itself are not throttled: `prewarm.mjs` starts jobs
 * back to back through the same API, and the operator warming their own cache is
 * not the traffic this is defending against. Set RATE_LIMIT_LOOPBACK=1 to drop
 * the exemption — that is how the limits get tested locally.
 */
export const RATE_LIMIT_LOOPBACK = process.env.RATE_LIMIT_LOOPBACK === '1';

/**
 * Per-IP budgets, as token buckets: `capacity` is how much may be spent at once,
 * `perHour` how fast it comes back. Zero capacity disables a bucket.
 *
 * `job` is the one that matters. A cold calculation costs minutes of every core,
 * and only one runs at a time, so the whole machine is worth 6–20 jobs an hour —
 * one address holding six of them is already most of it. Cache hits are not
 * charged against it: clicking around prewarmed places must stay free, and the
 * defence is against occupying the queue, not against reading.
 *
 * `api` is the flood guard on everything else, and `geocode` is separate because
 * it spends someone else's patience — a public Nominatim asks for no more than a
 * request a second — rather than our CPU.
 */
export const RATE_LIMITS = {
  api: {
    capacity: Number(process.env.RATE_LIMIT_RPM ?? 60),
    perHour: Number(process.env.RATE_LIMIT_RPM ?? 60) * 60,
  },
  geocode: {
    capacity: Number(process.env.GEOCODE_LIMIT_RPM ?? 20),
    perHour: Number(process.env.GEOCODE_LIMIT_RPM ?? 20) * 60,
  },
  job: {
    capacity: Number(process.env.JOB_LIMIT_BURST ?? 2),
    perHour: Number(process.env.JOB_LIMIT_PER_HOUR ?? 6),
  },
} as const;

export type LimitName = keyof typeof RATE_LIMITS;

/**
 * How many progress streams one address may hold open at once. Zero disables the
 * check, as with the buckets above.
 *
 * Metered separately because it is occupancy, not rate: an SSE connection lives
 * for as long as the calculation it follows, so the request limits above say
 * nothing about it — a client can open a hundred within its budget and simply
 * leave them there. Six is well past what honest use needs: a tab holds one
 * stream, and only while it waits for a result.
 */
export const STREAM_LIMIT_PER_IP = Number(process.env.STREAM_LIMIT_PER_IP ?? 6);

/**
 * Operating point chosen in benchmarking. See README for the accuracy/speed
 * trade-off behind each value; the current cost is ~830 s cold on Tverskaya,
 * of which ~790 s is propagation.
 */
export const JOB_PARAMS = {
  // Displayed disc. Receivers are still laid out over the enclosing square —
  // Delaunay_Grid only honours the envelope of its fence — so the shown area is
  // cut to this radius at the end of the pipeline.
  radius: 750,
  maxSrcDist: 350,
  maxArea: 5000,
  reflOrder: 0,
  diffVertical: 1,
  diffHorizontal: 0,
  // Terrain costs ~60% more propagation time and moves 9.6% of the area into a
  // different band, lowering the mean by 1.2 dB — slopes screen sound. Worth the
  // time: without it the model quietly assumes the city is a flat plate.
  dem: 1,
} as const;

/**
 * Clicks are snapped to a grid before becoming a cache key. Two clicks in the
 * same courtyard should hit the same cached result rather than each costing a
 * minute of computation — the model has nothing like 100 m of spatial precision
 * in its traffic inputs anyway.
 */
export const CACHE_GRID_METERS = 100;

// Shared with the browser and with run-job.mjs, which emits these names as
// markers. Re-exported so the modules importing Stage from './config.js' —
// queue.ts, index.ts — keep their single import.
export type { Stage };

/** Stages after which nothing more will be published — the stream can close. */
export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set<Stage>(['done', 'error', 'cancelled']);

/**
 * Proxy the outgoing requests go through, if any. Exported so the server can say
 * so at startup: on a machine where Overpass is only reachable through a local
 * proxy, a server started without these variables fails every single job at the
 * first stage — and the failure looks like a property of the clicked place
 * rather than of the environment.
 */
export const PROXY_URL = proxyUrl ?? '';

/** Shown to the user as-is; the frontend does not need its own copy of this. */
export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'В очереди',
  overpass: 'Загружаю здания и дороги',
  import: 'Разбираю данные OpenStreetMap',
  grid: 'Строю сетку приёмников',
  preview: 'Считаю предварительную карту',
  propagation: 'Считаю распространение звука',
  isosurface: 'Строю изофоны',
  dissolve: 'Склеиваю контуры',
  export: 'Готовлю результат',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

/**
 * What to tell the caller when the pipeline dies, based on how far it got.
 *
 * One message for every failure is worse than none: "возможно, поблизости нет
 * дорог" sent someone looking at their map when the real problem was that
 * Overpass could not be reached at all. The stage the job died in is the only
 * thing we know for sure, so the text says exactly that much and no more; the
 * stack trace stays in the server log.
 */
export function failureMessage(stage: Stage): string {
  switch (stage) {
    case 'queued':
      return 'расчёт не удалось запустить';
    case 'overpass':
      return (
        'не удалось получить данные OpenStreetMap — Overpass не ответил. ' +
        'Это не про выбранное место: попробуйте позже'
      );
    case 'import':
    case 'grid':
      return 'данные OpenStreetMap не разобрались — возможно, поблизости нет дорог';
    default:
      return `расчёт оборвался на этапе «${STAGE_LABELS[stage]}»`;
  }
}
