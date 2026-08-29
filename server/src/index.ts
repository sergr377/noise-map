import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  ALLOWED_ORIGINS,
  CACHE_ONLY,
  ENGINE_IS_REAL,
  JOB_PARAMS,
  KILL_GRACE_MS,
  PORT,
  PROXY_URL,
  RUN_JOB_SCRIPT,
  STAGE_LABELS,
  TERMINAL_STAGES,
  WEB_DIST,
} from './config.js';
import { cacheKey, quantize, readCache, cacheSize, cachedAreas, coveringArea } from './cache.js';
import {
  startJob,
  getJob,
  subscribe,
  snapshot,
  cancelJob,
  stopAll,
  partialPath,
  previewPath,
} from './queue.js';
import { geocode, GeocoderError } from './geocode.js';
import { clientIp, limitHeaders, openStream, take, type Verdict } from './ratelimit.js';

const gzipAsync = promisify(gzip);

/**
 * Ceiling on how many computed areas one viewport query returns. A whole-country
 * view would otherwise hand back the entire cache, and at that zoom a 750-metre
 * disc is a pixel — the client stops asking long before this bites.
 */
const AREAS_PER_REQUEST = 500;

/**
 * CORS-заголовки на ответ. Ставятся один раз, в начале обработки запроса:
 * writeHead ниже добавляет свои к уже выставленным, а не заменяет их, так
 * что каждому маршруту не нужно помнить про заголовки самому.
 *
 * Пустой ALLOWED_ORIGINS означает звёздочку — публичный API, как и было.
 * Со списком отвечаем эхом того источника, который в нём есть, и молчим для
 * остальных: браузер сам не пустит ответ без заголовка. Vary: Origin —
 * чтобы кэш не отдал ответ, выписанный на другой источник.
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return;
  }
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

/** 429 with the wait in both the header machines read and the text people read. */
function sendTooMany(res: http.ServerResponse, verdict: Verdict, message: string) {
  return sendJson(
    res,
    429,
    { error: message, retryAfter: verdict.retryAfter },
    limitHeaders(verdict),
  );
}

/**
 * Ceiling on a request body. The only body this API reads is
 * {lat, lon, preview} — tens of bytes — so anything approaching this is not a
 * client of ours. The rate limiter counts requests, not their size, and a
 * public POST endpoint has no business collecting an unbounded string in
 * memory just to find out it was never valid JSON.
 */
const MAX_BODY_BYTES = 8 * 1024;

class BodyTooLargeError extends Error {}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  // Content-Length is a claim, not a guarantee, so it is a shortcut rather
  // than the check: an honest oversized body is refused before a byte of it
  // is read, and a lying one runs into the counter below.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** A point on Earth, or null if the caller sent something else. */
function readPoint(rawLat: unknown, rawLon: unknown): { lat: number; lon: number } | null {
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * GET /api/noise?lat=&lon= — has this place been computed, and is anything being
 * computed for it right now.
 *
 * Exists because POST cannot answer that without also starting the work: asking
 * "is this ready?" used to cost minutes of every core, which is both a way to
 * occupy the machine by accident and the reason the map could not show which
 * places open instantly. Nothing here starts, joins or changes a job.
 */
async function handleProbe(res: http.ServerResponse, params: URLSearchParams) {
  const point = readPoint(params.get('lat'), params.get('lon'));
  if (!point) {
    return sendJson(res, 400, { error: 'lat and lon must be valid coordinates' });
  }

  const id = cacheKey(point.lat, point.lon);
  const bytes = await cacheSize(id);
  const job = getJob(id);
  // A place is ready when a result covers it, not only when it is the centre of
  // one — the same rule the POST below answers by.
  const covering = bytes === null ? await ready(point.lat, point.lon) : null;

  return sendJson(res, 200, {
    id: covering?.id ?? id,
    centre: covering ? { lat: covering.lat, lon: covering.lon } : quantize(point.lat, point.lon),
    radius: covering?.radius ?? JOB_PARAMS.radius,
    cached: bytes !== null || covering !== null,
    ...(bytes !== null ? { bytes } : {}),
    ...(covering ? { bytes: covering.bytes, covering: true } : {}),
    // Present only while a calculation for this cell is alive, so a caller can
    // tell "nobody has asked for this" from "somebody is already waiting".
    ...(job ? { state: snapshot(job) } : {}),
  });
}

/**
 * A finished result covering this point, with its size — or null if the place
 * has to be computed.
 *
 * Split out because both the probe and the create route answer the same
 * question, and answering it differently in the two would mean the map shades a
 * place as ready and then spends a quarter of an hour on it when clicked.
 */
async function ready(lat: number, lon: number) {
  const area = await coveringArea(lat, lon);
  if (!area) return null;
  const bytes = await cacheSize(area.id);
  // The index is memory and the file is disk; a result deleted underneath it is
  // not a covering result any more.
  return bytes === null ? null : { ...area, bytes };
}

/**
 * GET /api/noise/areas?bbox=minLon,minLat,maxLon,maxLat — computed places whose
 * disc reaches into that box.
 *
 * Exists so the map can shade what is already computed instead of making people
 * find it with the cursor. Only centres and radii travel: the shapes are discs,
 * and sending their outlines would be kilobytes per area for a circle the client
 * can draw from three numbers.
 */
async function handleAreas(res: http.ServerResponse, params: URLSearchParams) {
  const parts = (params.get('bbox') ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return sendJson(res, 400, { error: 'bbox must be minLon,minLat,maxLon,maxLat' });
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  const { areas, truncated } = await cachedAreas(
    {
      minLat: Math.min(minLat, maxLat),
      maxLat: Math.max(minLat, maxLat),
      minLon: Math.min(minLon, maxLon),
      maxLon: Math.max(minLon, maxLon),
    },
    AREAS_PER_REQUEST,
  );
  // Not cacheable: the set grows every time a calculation finishes, and a stale
  // copy would tell someone a place is ready when it is not.
  return sendJson(
    res,
    200,
    { areas, ...(truncated ? { truncated } : {}) },
    { 'Cache-Control': 'no-store' },
  );
}

/** POST /api/noise — resolve a click to either a cached result or a running job. */
async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
  let body: { lat?: unknown; lon?: unknown; preview?: unknown } | null;
  try {
    body = (await readBody(req)) as { lat?: unknown; lon?: unknown; preview?: unknown } | null;
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    // Connection: close — whatever the client is still sending will never be
    // read, and without this it would go on filling the socket after the answer.
    return sendJson(
      res,
      413,
      { error: `тело запроса больше ${MAX_BODY_BYTES} байт` },
      { Connection: 'close' },
    );
  }
  const point = readPoint(body?.lat, body?.lon);

  if (!point) {
    return sendJson(res, 400, { error: 'lat and lon must be valid coordinates' });
  }
  const { lat, lon } = point;

  const id = cacheKey(lat, lon);
  // Where the map is actually centred. Clicks snap to a grid, so this can sit
  // up to half a cell from the click and the UI should show it honestly.
  const centre = quantize(lat, lon);
  // How far the result reaches. Sent rather than duplicated in the frontend:
  // it is a calculation parameter, and a second copy there would drift from the
  // one the answer was actually computed with.
  const radius = JOB_PARAMS.radius;

  const bytes = await cacheSize(id);
  if (bytes !== null) {
    return sendJson(res, 200, { id, cached: true, bytes, centre, radius });
  }

  // Nothing computed for this cell — but a neighbour's disc may already cover
  // the point. A result is a map of an area, and the click is inside that area,
  // so handing it over answers the question that was asked. Without this, every
  // click in a shaded area except the one cell it was computed from started a
  // quarter of an hour of work for a map that already existed.
  const covering = await ready(lat, lon);
  if (covering) {
    return sendJson(res, 200, {
      id: covering.id,
      cached: true,
      bytes: covering.bytes,
      // The centre is the neighbour's, up to a radius away from the click. Said
      // plainly rather than hidden: the interface draws the disc around it and
      // explains the offset.
      centre: { lat: covering.lat, lon: covering.lon },
      radius: covering.radius,
      covering: true,
    });
  }

  if (CACHE_ONLY) {
    return sendJson(res, 503, {
      error:
        'здесь показаны только заранее посчитанные места — расчёт нового требует нескольких минут на всех ядрах',
      cacheOnly: true,
    });
  }

  // The job budget is charged for starting work, not for asking. Joining a run
  // that is already under way costs the machine nothing, and neither does a
  // cache hit — both are handled above and below this check.
  if (!getJob(id)) {
    const verdict = take('job', ip);
    if (!verdict.ok) {
      return sendTooMany(
        res,
        verdict,
        `слишком много расчётов подряд — новый можно запустить через ${verdict.retryAfter} с. ` +
          'Уже посчитанные места открываются без ограничений.',
      );
    }
  }

  // Opting out of the preview is for callers that are not watching — the cache
  // warmer above all. Honoured from anyone: it only makes the machine do less
  // work, at the price of the caller seeing nothing until the result.
  const job = startJob(lat, lon, body?.preview !== false);
  return sendJson(res, 202, { id: job.id, cached: false, centre, radius, state: snapshot(job) });
}

/**
 * DELETE /api/noise/:id — withdraw interest in a running calculation.
 *
 * Answers 200 either way: `cancelled` says whether the pipeline was actually
 * stopped, and it is not when other callers are still waiting for the same cell.
 * That is not an error for the caller — their own wait is over regardless.
 */
function handleCancel(res: http.ServerResponse, id: string) {
  const outcome = cancelJob(id);
  if (!outcome) {
    return sendJson(res, 404, { error: 'нет такой задачи — возможно, она уже завершилась' });
  }
  return sendJson(res, 200, outcome);
}

/** GET /api/noise/:id/events — progress as server-sent events. */
function handleEvents(res: http.ServerResponse, id: string, ip: string) {
  const job = getJob(id);
  if (!job) {
    return sendJson(res, 404, { error: 'unknown job — it may have finished; fetch the result' });
  }

  // What has to be metered here is occupancy, not rate: the connection stays
  // open for the whole calculation, holding a socket, a listener and a timer,
  // and the request budget spent to open it was one token. Nothing else would
  // stop a client from leaving a hundred of these hanging.
  const stream = openStream(ip);
  if (!stream.ok) {
    return sendJson(res, 429, {
      error:
        `слишком много одновременных подписок на прогресс с этого адреса ` +
        `(${stream.limit}) — закройте лишние вкладки`,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // subscribe() invokes the listener synchronously with the current state. For a
  // job that has already finished that happens *during* the call below, before
  // its own result is bound — so nothing the listener touches may be declared
  // after it. Both the interval and the release hook are therefore hoisted, and
  // the subscription is released again once the handle exists.
  //
  // Proxies drop idle connections; a comment line keeps this one alive without
  // being mistaken for an event.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  let unsubscribe: (() => void) | undefined;
  let finished = false;

  const close = () => {
    finished = true;
    unsubscribe?.();
    clearInterval(heartbeat);
    stream.release();
    if (!res.writableEnded) res.end();
  };

  unsubscribe = subscribe(job, (state) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    if (TERMINAL_STAGES.has(state.stage)) close();
  });

  // The listener already fired and closed the stream; drop the now-known handle.
  if (finished) unsubscribe();

  // Fires however the connection ends — a closed tab, a dropped network, our
  // own end() above — which is what makes the slot come back at all.
  res.on('close', () => {
    unsubscribe?.();
    clearInterval(heartbeat);
    stream.release();
  });
}

/** GET /api/noise/:id/result — the isophone GeoJSON. */
async function handleResult(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const data = await readCache(id);
  if (!data) {
    const job = getJob(id);
    if (!job) return sendJson(res, 404, { error: 'no result for this id' });
    // A cancelled job will never produce one, so say that rather than "not
    // ready" — the caller would otherwise keep waiting for it.
    return sendJson(res, 409, {
      error: job.stage === 'cancelled' ? 'расчёт отменён' : `not ready: ${STAGE_LABELS[job.stage]}`,
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/geo+json; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  };

  // These files are mostly coordinate digits and compress by roughly 5x.
  if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const compressed = await gzipAsync(data);
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    return res.end(compressed);
  }
  res.writeHead(200, headers);
  return res.end(data);
}

/**
 * GET /api/noise/:id/partial/:n — the map as it stood partway through the job.
 *
 * Never cached: a frame is a snapshot of an unfinished calculation, and the only
 * thing worse than waiting for a map is being handed an old half-drawn one.
 */
async function handlePartial(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  index: number,
) {
  const file = partialPath(id, index);
  const data = file ? await readFile(file).catch(() => null) : null;
  if (!data) {
    return sendJson(res, 404, { error: 'нет такого промежуточного кадра' });
  }
  return sendScratchMap(req, res, data);
}

/**
 * GET /api/noise/:id/preview — the rough map of the whole area, computed before
 * the real pass with only nearby sources.
 *
 * Never cached, for the same reason a frame is not: it reads about a decibel
 * low and a tenth of its area sits in a neighbouring band. That is fine for
 * something the interface labels as preliminary and wrong for something handed
 * out as the answer.
 */
async function handlePreview(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const file = previewPath(id);
  const data = file ? await readFile(file).catch(() => null) : null;
  if (!data) {
    return sendJson(res, 404, { error: 'предварительной карты для этой задачи нет' });
  }
  return sendScratchMap(req, res, data);
}

/** Shared tail of the two routes above: same headers, same gzip decision. */
async function sendScratchMap(req: http.IncomingMessage, res: http.ServerResponse, data: Buffer) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/geo+json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    return res.end(await gzipAsync(data));
  }
  res.writeHead(200, headers);
  return res.end(data);
}

/** GET /api/geocode?q= — address lookup, proxied so the key stays server-side. */
async function handleGeocode(res: http.ServerResponse, query: string, ip: string) {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return sendJson(res, 400, { error: 'запрос слишком короткий' });
  }
  // Metered separately from everything else: each lookup spends the Yandex
  // quota, which runs out for the whole service and not just for this caller.
  const verdict = take('geocode', ip);
  if (!verdict.ok) {
    return sendTooMany(
      res,
      verdict,
      `слишком много запросов поиска — повторите через ${verdict.retryAfter} с`,
    );
  }
  try {
    return sendJson(res, 200, { places: await geocode(trimmed) });
  } catch (err) {
    if (err instanceof GeocoderError) {
      return sendJson(res, err.status, { error: err.message });
    }
    return sendJson(res, 502, { error: `геокодер недоступен: ${(err as Error).message}` });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built frontend when it exists. Unknown paths fall back to
 * index.html so that a deep link like /?lat=..&lon=.. survives a page reload.
 */
async function serveStatic(res: http.ServerResponse, pathname: string) {
  // decodeURIComponent matters: %2e%2e%2f survives URL normalisation and would
  // otherwise reach the filesystem as ../ after any later decoding.
  let relative: string;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }

  let file = path.resolve(WEB_DIST, relative);
  // startsWith would also accept a sibling directory whose name merely begins
  // with the root's; comparing the relative path is the reliable form.
  const inside = path.relative(WEB_DIST, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    file = path.join(WEB_DIST, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return sendJson(res, 404, { error: 'not found' });
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Vite fingerprints asset filenames, so only the entry page must stay fresh.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

/** One capture group: the job id, as the cache names it. */
const JOB_ID = '([a-f0-9]{16})';

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  ip: string;
  /** Capture groups of the path pattern, in order. */
  params: string[];
}

interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: RegExp;
  handle: (ctx: RouteContext) => unknown;
}

/**
 * Every route in one place, which is the point: the alternative — a column of
 * `if (pathname === ... && method === ...)` — reads fine at ten routes and
 * hides the eleventh somewhere in the middle of a function.
 *
 * Order does not matter here, and that is deliberate: the patterns are
 * anchored and disjoint, so no route can shadow another. `/api/noise/areas`
 * cannot be read as a job id because ids are sixteen hex characters.
 */
const ROUTES: Route[] = [
  // What the interface needs to know before anything has been calculated —
  // today just the radius, so the map can show what a click would cover. A copy
  // of that number in the frontend would drift from the one the result is
  // actually computed with.
  {
    method: 'GET',
    path: /^\/api\/config$/,
    handle: ({ res }) => sendJson(res, 200, { radius: JOB_PARAMS.radius }),
  },
  {
    method: 'POST',
    path: /^\/api\/noise$/,
    handle: ({ req, res, ip }) => handleCreate(req, res, ip),
  },
  {
    method: 'GET',
    path: /^\/api\/noise\/areas$/,
    handle: ({ res, url }) => handleAreas(res, url.searchParams),
  },
  {
    method: 'GET',
    path: /^\/api\/noise$/,
    handle: ({ res, url }) => handleProbe(res, url.searchParams),
  },
  {
    method: 'GET',
    path: /^\/api\/geocode$/,
    handle: ({ res, url, ip }) => handleGeocode(res, url.searchParams.get('q') ?? '', ip),
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/api/noise/${JOB_ID}$`),
    handle: ({ res, params: [id = ''] }) => handleCancel(res, id),
  },
  {
    method: 'GET',
    path: new RegExp(`^/api/noise/${JOB_ID}/events$`),
    handle: ({ res, ip, params: [id = ''] }) => handleEvents(res, id, ip),
  },
  {
    method: 'GET',
    path: new RegExp(`^/api/noise/${JOB_ID}/result$`),
    handle: ({ req, res, params: [id = ''] }) => handleResult(req, res, id),
  },
  {
    method: 'GET',
    path: new RegExp(`^/api/noise/${JOB_ID}/preview$`),
    handle: ({ req, res, params: [id = ''] }) => handlePreview(req, res, id),
  },
  {
    method: 'GET',
    path: new RegExp(`^/api/noise/${JOB_ID}/partial/(\\d{1,4})$`),
    handle: ({ req, res, params: [id = '', frame = ''] }) =>
      handlePartial(req, res, id, Number(frame)),
  },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    // Liveness probes come from the platform, not from users, and throttling
    // them would make the service look dead exactly when it is under load.
    if (url.pathname === '/api/health') {
      // `engine` is only ever absent from a normal server. It is reported so a
      // check running against the wrong process — a stub left over from a test
      // run — finds out from the first request rather than from the map.
      //
      // `params` is half of the cache key, so it is also the answer to "will
      // this batch land in a cache anyone can read". A prewarming plan is built
      // for one radius and is worthless against a server running another; the
      // probe route cannot say which, because for a covered point it reports the
      // covering result's radius rather than the configured one.
      return sendJson(res, 200, {
        ok: true,
        params: JOB_PARAMS,
        ...(ENGINE_IS_REAL ? {} : { engine: 'stub' }),
      });
    }

    const ip = clientIp(req);
    if (url.pathname.startsWith('/api/')) {
      const verdict = take('api', ip);
      if (!verdict.ok) {
        return sendTooMany(
          res,
          verdict,
          `слишком много запросов — повторите через ${verdict.retryAfter} с`,
        );
      }
      // Advisory headers on the way out too, so a client can slow down before it
      // is refused. setHeader rather than a writeHead argument: every handler
      // below writes its own head, including the SSE stream and the static
      // files, and Node merges what was set here into all of them.
      for (const [name, value] of Object.entries(limitHeaders(verdict))) {
        res.setHeader(name, value);
      }
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const match = route.path.exec(url.pathname);
      if (!match) continue;
      return await route.handle({ req, res, url, ip, params: match.slice(1) });
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return await serveStatic(res, url.pathname);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    // Once headers are out — an SSE stream, say — writing an error response
    // throws a second time and kills the process. Drop the socket instead.
    if (res.headersSent) {
      console.error('error after headers were sent:', err);
      return res.destroy();
    }
    return sendJson(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`noise-map api on http://localhost:${PORT}`);
  if (!ENGINE_IS_REAL) {
    console.warn(
      `ВНИМАНИЕ: расчёт подменён на ${RUN_JOB_SCRIPT} (RUN_JOB_SCRIPT). ` +
        'Карты будут выдуманными — это режим для проверки HTTP-слоя, не для людей.',
    );
  }
  // Said out loud because its absence is otherwise invisible until every job
  // fails: where Overpass is only reachable through a local proxy, a server
  // started without HTTPS_PROXY cannot fetch anything, and that surfaces as a
  // broken calculation rather than as a missing setting.
  console.log(
    PROXY_URL
      ? `исходящие запросы через прокси ${PROXY_URL}`
      : 'прокси не настроен (HTTPS_PROXY и HTTP_PROXY пусты) — если Overpass отсюда' +
          ' недоступен напрямую, ни один расчёт не запустится',
  );
});

// Pipelines run in their own process group so that cancelling can reach the JVM;
// the same isolation means they outlive this process unless they are stopped
// here. `docker stop` sends SIGTERM, Ctrl-C sends SIGINT — both land here.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const stopped = stopAll();
    if (stopped) console.log(`${signal}: остановлено расчётов — ${stopped}`);
    server.close();
    // Leaving immediately would cut short the SIGKILL escalation inside
    // killTree, orphaning a JVM that ignored the polite signal. Without a
    // pipeline to wait for there is nothing to wait for: held-open SSE streams
    // would otherwise keep the process alive indefinitely.
    setTimeout(() => process.exit(0), stopped ? KILL_GRACE_MS + 500 : 0);
  });
}
