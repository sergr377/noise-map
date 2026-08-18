import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

/** Repository root: this file lives two levels down, both in src/ and in dist/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// .env is optional — the server runs fine without it, only the frontend needs a key.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env present */
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
 * Geocoder key. Deliberately server-side: unlike the JS API key it carries no
 * HTTP Referer restriction, so anyone could lift it out of a browser bundle and
 * spend the quota. The frontend talks to /api/geocode instead.
 */
export const GEOCODER_KEY = process.env.YANDEX_GEOCODER_KEY ?? '';

/**
 * The propagation step already saturates every core, so running two jobs at once
 * makes both slower without improving throughput.
 */
export const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 1);

export const CACHE_DIR = path.join(ROOT, 'cache');
export const RUN_JOB_SCRIPT = path.join(ROOT, 'scripts', 'run-job.mjs');

/**
 * Operating point chosen in benchmarking: ~70 s in the densest part of Moscow.
 * See README for the accuracy/speed trade-offs behind each value.
 */
export const JOB_PARAMS = {
  radius: 500,
  maxSrcDist: 350,
  maxArea: 5000,
  reflOrder: 0,
  diffVertical: 1,
  diffHorizontal: 0,
} as const;

/**
 * Clicks are snapped to a grid before becoming a cache key. Two clicks in the
 * same courtyard should hit the same cached result rather than each costing a
 * minute of computation — the model has nothing like 100 m of spatial precision
 * in its traffic inputs anyway.
 */
export const CACHE_GRID_METERS = 100;

export type Stage =
  | 'queued'
  | 'overpass'
  | 'import'
  | 'grid'
  | 'propagation'
  | 'isosurface'
  | 'dissolve'
  | 'export'
  | 'done'
  | 'error';

/** Shown to the user as-is; the frontend does not need its own copy of this. */
export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'В очереди',
  overpass: 'Загружаю здания и дороги',
  import: 'Разбираю данные OpenStreetMap',
  grid: 'Строю сетку приёмников',
  propagation: 'Считаю распространение звука',
  isosurface: 'Строю изофоны',
  dissolve: 'Склеиваю контуры',
  export: 'Готовлю результат',
  done: 'Готово',
  error: 'Ошибка',
};
