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
      if (state.label !== lastLabel) {
        console.log(
          `  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${state.label} ${(state.progress * 100).toFixed(0)}%`,
        );
        lastLabel = state.label;
      }
      if (state.stage === 'done' || state.stage === 'error') {
        console.log(`  final:`, state);
        console.log(`  progress events received: ${ticks}`);
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
