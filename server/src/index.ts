import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { CACHE_ONLY, PORT, STAGE_LABELS, WEB_DIST } from './config.js';
import { cacheKey, quantize, readCache, cacheSize } from './cache.js';
import { startJob, getJob, subscribe, snapshot } from './queue.js';
import { geocode, GeocoderError } from './geocode.js';

const gzipAsync = promisify(gzip);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** POST /api/noise — resolve a click to either a cached result or a running job. */
async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await readBody(req)) as { lat?: unknown; lon?: unknown } | null;
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, { error: 'lat and lon must be valid coordinates' });
  }

  const id = cacheKey(lat, lon);
  // Where the map is actually centred. Clicks snap to a grid, so this can sit
  // up to half a cell from the click and the UI should show it honestly.
  const centre = quantize(lat, lon);

  const bytes = await cacheSize(id);
  if (bytes !== null) {
    return sendJson(res, 200, { id, cached: true, bytes, centre });
  }

  if (CACHE_ONLY) {
    return sendJson(res, 503, {
      error:
        'здесь показаны только заранее посчитанные места — расчёт нового требует нескольких минут на всех ядрах',
      cacheOnly: true,
    });
  }

  const job = startJob(lat, lon);
  return sendJson(res, 202, { id: job.id, cached: false, centre, state: snapshot(job) });
}

/** GET /api/noise/:id/events — progress as server-sent events. */
function handleEvents(res: http.ServerResponse, id: string) {
  const job = getJob(id);
  if (!job) {
    return sendJson(res, 404, { error: 'unknown job — it may have finished; fetch the result' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS,
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
    if (!res.writableEnded) res.end();
  };

  unsubscribe = subscribe(job, (state) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    if (state.stage === 'done' || state.stage === 'error') close();
  });

  // The listener already fired and closed the stream; drop the now-known handle.
  if (finished) unsubscribe();

  res.on('close', () => {
    unsubscribe?.();
    clearInterval(heartbeat);
  });
}

/** GET /api/noise/:id/result — the isophone GeoJSON. */
async function handleResult(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const data = await readCache(id);
  if (!data) {
    const job = getJob(id);
    return sendJson(res, job ? 409 : 404, {
      error: job ? `not ready: ${STAGE_LABELS[job.stage]}` : 'no result for this id',
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/geo+json; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
    ...CORS,
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

/** GET /api/geocode?q= — address lookup, proxied so the key stays server-side. */
async function handleGeocode(res: http.ServerResponse, query: string) {
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    return sendJson(res, 400, { error: 'запрос слишком короткий' });
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
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/noise' && req.method === 'POST') {
      return await handleCreate(req, res);
    }
    if (url.pathname === '/api/geocode' && req.method === 'GET') {
      return await handleGeocode(res, url.searchParams.get('q') ?? '');
    }

    const match = url.pathname.match(/^\/api\/noise\/([a-f0-9]{16})\/(events|result)$/);
    if (match && req.method === 'GET') {
      const [, id, kind] = match as unknown as [string, string, string];
      return kind === 'events' ? handleEvents(res, id) : await handleResult(req, res, id);
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return await serveStatic(req, res, url.pathname);
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
});
