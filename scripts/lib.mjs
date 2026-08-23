import { writeFile } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// The scripts read the same .env as the server, so a proxy has one place to be
// written down instead of having to be remembered on every command line. Values
// already in the environment win — Node does not overwrite them from the file.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  // Same rule as the server: a missing .env is ordinary, anything else is not.
  // A script that silently loses HTTPS_PROXY looks like Overpass being down.
  if (err.code !== 'ENOENT') throw err;
}

// Without this, resolution can hand back a AAAA record first and undici stalls
// for its full 10s connect timeout before ever trying IPv4.
setDefaultResultOrder('ipv4first');

// Node 22's fetch ignores HTTP(S)_PROXY, unlike curl or PowerShell. On a machine
// where Overpass is only reachable through a local proxy that looks like the
// endpoint being down, so honour the env vars explicitly.
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

/**
 * Overpass instances, tried in the order given. Every one of them is public and
 * shared with the rest of the world, which is exactly why there are several:
 * under load they answer 504 or 429 instead of data, and they do not do it at
 * the same moment.
 *
 * The list is a default, not a law — OVERPASS_ENDPOINTS in .env replaces it
 * outright. That is also the only real cure for depending on somebody else's
 * server: point this at an instance of your own and the retry loop below stops
 * being the thing standing between a click and an answer.
 */
const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Endpoint list out of a comma- or whitespace-separated string, keeping only
 * what is actually a URL.
 *
 * A typo in .env that silently leaves one instance standing is the kind of
 * fault that surfaces on the day the main one is down, so a rejected address is
 * said out loud rather than dropped quietly, and an entirely unusable list
 * falls back to the defaults instead of leaving the pipeline with nowhere to
 * ask.
 */
export function parseEndpoints(raw, fallback = DEFAULT_OVERPASS_ENDPOINTS) {
  const listed = (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const usable = [];
  const rejected = [];
  for (const url of listed) {
    let protocol = '';
    try {
      ({ protocol } = new URL(url));
    } catch {
      /* not a URL at all */
    }
    if (protocol === 'http:' || protocol === 'https:') usable.push(url);
    else rejected.push(url);
  }
  if (rejected.length) {
    console.warn(`OVERPASS_ENDPOINTS: not addresses, skipped — ${rejected.join(', ')}`);
  }
  return usable.length ? usable : fallback;
}

const OVERPASS_ENDPOINTS = parseEndpoints(process.env.OVERPASS_ENDPOINTS);

/**
 * Bounding box around a point. Latitude degrees are ~constant in length;
 * longitude degrees shrink with the cosine of the latitude.
 */
export function bboxAround(lat, lon, radiusMeters) {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - dLat,
    west: lon - dLon,
    north: lat + dLat,
    east: lon + dLon,
  };
}

/**
 * CNOSSOS propagation runs in metres, so the data has to land in a metric CRS.
 * UTM keeps distortion under ~1/1000 inside a zone, which is well below the
 * uncertainty of the traffic estimates feeding the model.
 */
export function utmSrid(lat, lon) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/**
 * Midpoint of an isophone band, in dB(A). ISOLABEL comes out of
 * `Create_Isosurface` as "-35", "35-40", ..., "80+", so the two open-ended
 * bands have no midpoint of their own: they are given the same 5 dB width as
 * every other band, which is what makes an area-weighted mean over all bands
 * comparable between two runs.
 */
export function bandMid(label) {
  if (label.startsWith('-')) return 32.5;
  if (label.endsWith('+')) return 82.5;
  const [a, b] = label.split('-').map(Number);
  return (a + b) / 2;
}

/**
 * EWKT rectangle in WGS84. A rectangle is not a simplification: `Delaunay_Grid`
 * reprojects the fence and then keeps only its envelope (`setMainEnvelope` in
 * the block's source), so any other shape would end up as this same rectangle.
 * The round display area is cut from the finished isophones instead.
 */
export function bboxEwkt({ south, west, north, east }) {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]
    .map(([x, y]) => `${x} ${y}`)
    .join(', ');
  return `SRID=4326;POLYGON((${ring}))`;
}

/**
 * The Overpass query behind every extract: roads to emit from, buildings to
 * screen with, and the land cover the ground absorption is read from.
 *
 * `out meta` is deliberate: the osmosis XML reader used by Import_OSM expects
 * the version attribute that only the meta output carries.
 */
export function overpassQuery({ south, west, north, east }) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:xml][timeout:180];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  relation["building"](${bbox});
  way["landuse"](${bbox});
  way["natural"](${bbox});
  way["leisure"](${bbox});
);
(._;>;);
out meta;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What an HTTP status from Overpass means for a retry loop.
 *
 * Worth separating, because the two possible mistakes cost differently. A
 * broken query retried across four mirrors three times over is minutes of
 * someone's life spent re-reading the same syntax error; a 504 given up on at
 * once is a click that failed for no reason at all. Overpass answers 400 for a
 * query it cannot parse, 429 when the caller has spent its quota, and 504 when
 * the server ran out of slots or out of time.
 */
export function overpassVerdict(status) {
  if (status >= 200 && status < 300) return 'ok';
  // Busy or broken, but this instance is still the right place to ask.
  if (status === 429 || status >= 500) return 'retry';
  // Our own request is wrong, and it will be just as wrong on every mirror.
  if (status === 400 || status === 414) return 'query-broken';
  // 403 for a blocked user agent, 404 for a moved path: something about this
  // instance, so the others are still worth trying.
  return 'endpoint-out';
}

/**
 * `Retry-After` in milliseconds, or null when there is nothing usable in it.
 * The header comes in two shapes — a count of seconds, or an HTTP date — and
 * instances sitting behind a CDN send both.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/**
 * How long to wait before round `round`, jittered.
 *
 * The jitter is not decoration. Instances that went down together come back
 * together, and a fixed 5 s, 10 s, 20 s ladder sends every waiting client at
 * them in the same instant — which is how a recovering server is knocked over
 * again by the very clients waiting for it. Half the window is fixed so the
 * back-off cannot collapse to no wait at all, half is spread out.
 */
export function backoffDelay(round, { base = 5000, cap = 60_000, random = Math.random } = {}) {
  if (round <= 0) return 0;
  const window = Math.min(cap, base * 2 ** (round - 1));
  return Math.round(window / 2 + (window / 2) * random());
}

/**
 * How long an instance is left alone after saying something about itself rather
 * than about the query. A 429 usually carries its own Retry-After and that wins;
 * these are the answers for the ones that do not.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/**
 * The least an attempt is ever given, however tight the remaining budget. Below
 * this the loop would be cutting off servers that were about to answer.
 */
const MIN_ATTEMPT_MS = 60_000;
const ENDPOINT_OUT_COOLDOWN_MS = 10 * 60_000;

/**
 * Total time one Overpass question may take, across every mirror and round.
 *
 * Without a ceiling the loop is unbounded in the direction that matters: four
 * endpoints times three rounds times a 240 s attempt is most of an hour spent
 * on a click whose whole calculation takes fifteen minutes. Five minutes is the
 * default because a job that has not got its OSM data by then is better off
 * failing while the person is still watching — that failure is retryable (see
 * `retryable` in queue.ts), so clicking again is the cheap move.
 */
// `||` rather than `??`: an empty or misspelt value in .env parses to NaN or to
// zero, and either would mean "give up before asking anyone".
const OVERPASS_BUDGET_MS = Number(process.env.OVERPASS_BUDGET_MS) || 300_000;

/**
 * Instances that have asked to be left alone, and until when.
 *
 * Module scope on purpose: one job asks Overpass twice — roads, then rail — and
 * an instance that has just said "come back in a minute" means it for the
 * second question too. It does not outlive the process, which is the honest
 * scope for it: run-job.mjs is spawned per job, so this is a memory of the last
 * few minutes rather than a health record.
 */
const cooldownUntil = new Map();

/**
 * One Overpass query, with the retries the public instances make necessary.
 *
 * Everything about talking to Overpass lives here rather than at the call
 * sites: the mirrors, the back-off between rounds, the fact that a rate limit
 * arrives as a 200 with an apology inside, and the diagnosis of a failure that
 * Node's fetch reduces to the words "fetch failed".
 *
 * `hasPayload` is the caller's job because only it knows what its own answer
 * should look like — road data comes back as XML, rail as JSON.
 */
export async function overpassFetch(
  query,
  {
    rounds = 3,
    userAgent = 'noise-map/0.1',
    hasPayload = () => true,
    endpoints = OVERPASS_ENDPOINTS,
    budgetMs = OVERPASS_BUDGET_MS,
    attemptTimeoutMs = 240_000,
    minAttemptMs = MIN_ATTEMPT_MS,
    // The injectable ones below exist so the retry loop can be tested without a
    // network and without a clock: which mirror is asked, in what order, and whether a
    // cooling instance is left alone is the part that has to keep working, and
    // it is untestable against the real thing by definition.
    now = Date.now,
    fetchImpl = fetch,
    sleepImpl = sleep,
    cooldowns = cooldownUntil,
  } = {},
) {
  const errors = [];
  const deadline = now() + budgetMs;
  let spent = false;

  // When a whole round goes by without a single request leaving — every
  // instance still inside a wait it asked for — the back-off ladder is not the
  // thing to wait on. The soonest of their own deadlines is.
  let idleUntil = 0;

  attempts: for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      const wait = Math.min(
        Math.max(backoffDelay(round), idleUntil - now()),
        Math.max(0, deadline - now()),
      );
      if (wait <= 0) {
        spent = true;
        break;
      }
      await sleepImpl(wait);
    }
    let attempted = 0;
    let soonest = Infinity;
    for (let i = 0; i < endpoints.length; i++) {
      // Rotate which instance leads the round. Without this the first entry in
      // the list takes every first attempt from every client, and the mirrors
      // below it see traffic only once it is already overloaded.
      const endpoint = endpoints[(round + i) % endpoints.length];
      const host = new URL(endpoint).host;
      const label = `round ${round} ${host}`;

      const remaining = deadline - now();
      if (remaining <= 0) {
        spent = true;
        break attempts;
      }
      // How many instances this round still has in reserve behind this one.
      const untried = endpoints.length - 1 - i;
      const cooling = (cooldowns.get(endpoint) ?? 0) - now();
      if (cooling > 0) {
        soonest = Math.min(soonest, cooldowns.get(endpoint));
        errors.push(
          `${label}: skipped, asked to be left alone for ${Math.ceil(cooling / 1000)}s more`,
        );
        continue;
      }
      attempted += 1;

      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent,
          },
          body: new URLSearchParams({ data: query }),
          // An attempt gets its share of what is left, not all of it. A mirror
          // that has stopped answering does not fail — it hangs, and on the old
          // ceiling one of those swallowed four minutes of a five-minute budget
          // while three untried instances sat there. The floor keeps the share
          // from shrinking to something no server could answer inside; an
          // extract normally takes seconds, so anything near either bound is
          // already a mirror worth abandoning.
          // Math.floor is not tidiness: AbortSignal.timeout throws on a
          // fractional delay, and a share of a budget is fractional almost
          // always.
          signal: AbortSignal.timeout(
            Math.floor(
              Math.min(attemptTimeoutMs, Math.max(minAttemptMs, remaining / (untried + 1))),
            ),
          ),
        });
        const verdict = overpassVerdict(res.status);

        if (verdict !== 'ok') {
          // An Overpass error page, not data, so it is small. Read it anyway:
          // the reason for a 400 is in there and nowhere else.
          const detail = await res.text().catch(() => '');
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());

          if (verdict === 'query-broken') {
            // Every mirror will say the same thing, so there is nothing to
            // retry and nothing to blame the network for.
            throw Object.assign(
              new Error(
                `Overpass refused the query: HTTP ${res.status} from ${host}\n  ${detail.slice(0, 500)}`,
              ),
              { fatal: true },
            );
          }
          // A cooldown outlives this call, so it is only taken from an
          // instance that said something durable about itself. Retry-After is
          // its own word for it; a 429 without one is still a refusal on
          // quota; a 403 or a 404 is this instance being wrong for us for a
          // while. A bare 504 is none of those — it means "busy this second",
          // which the back-off between rounds already answers. Cooling on it
          // would silence every mirror at once and leave the remaining rounds
          // skipping their way to the same failure.
          const cooldown =
            retryAfter ??
            (verdict === 'endpoint-out'
              ? ENDPOINT_OUT_COOLDOWN_MS
              : res.status === 429
                ? RATE_LIMIT_COOLDOWN_MS
                : 0);
          if (cooldown > 0) cooldowns.set(endpoint, now() + cooldown);
          throw new Error(
            `HTTP ${res.status} ${res.statusText}` +
              (retryAfter === null ? '' : `, Retry-After ${Math.ceil(retryAfter / 1000)}s`),
          );
        }

        const body = await res.text();
        // Overpass reports rate limits and timeouts as a 200 with an error
        // document: <remark> in XML, "remark" in JSON, and no data either way.
        // Which of the two it was is not worth parsing out of prose, so it is
        // read as the commoner one — the query timed out on a busy server —
        // and left to the next round rather than to a cooldown.
        if (!hasPayload(body)) {
          throw new Error(`empty answer: ${body.slice(0, 300)}`);
        }
        // It answered, so whatever we thought we knew about it is out of date.
        cooldowns.delete(endpoint);
        return { body, endpoint };
      } catch (err) {
        if (err.fatal) throw err;
        // Node's fetch reports every network problem as a bare "fetch failed".
        // What distinguishes "the service is down" from "nothing leaves this
        // machine" sits one level deeper, in err.cause.
        const cause = err.cause?.code ?? err.cause?.message;
        errors.push(`${label}: ${err.message}${cause ? ` (${cause})` : ''}`);
      }
    }
    idleUntil = attempted === 0 && soonest !== Infinity ? soonest : 0;
  }
  if (spent) {
    errors.push(`budget of ${Math.round(budgetMs / 1000)}s spent (OVERPASS_BUDGET_MS)`);
  }
  // Worth saying out loud: where Overpass is only reachable through a local
  // proxy, a process started without these variables fails every fetch, and the
  // symptom reads as a dead service rather than as a missing setting.
  const proxyNote = proxyUrl
    ? `proxy: ${proxyUrl}`
    : 'no proxy configured (HTTPS_PROXY and HTTP_PROXY are empty)';
  throw new Error(
    `all ${endpoints.length} Overpass endpoints failed, ${proxyNote}\n  ${errors.join('\n  ')}`,
  );
}

/** Road and building data for one bounding box, written out as OSM XML. */
export async function fetchOsm(bbox, outPath, { rounds = 3 } = {}) {
  const { body, endpoint } = await overpassFetch(overpassQuery(bbox), {
    rounds,
    userAgent: 'noise-map/0.1 (OSM road noise mapping)',
    hasPayload: (xml) => xml.includes('<node'),
  });
  await writeFile(outPath, body, 'utf8');
  return { bytes: Buffer.byteLength(body), path: outPath, endpoint };
}
