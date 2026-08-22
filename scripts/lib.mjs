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
} catch {
  /* no .env present */
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

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

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
 * Public Overpass instances routinely answer 504 or 429 under load, so a single
 * attempt is not a meaningful test of availability. Rounds alternate endpoints
 * and back off between passes.
 */
export async function fetchOsm(bbox, outPath, { rounds = 3 } = {}) {
  const query = overpassQuery(bbox);
  const errors = [];

  for (let round = 0; round < rounds; round++) {
    if (round > 0) await sleep(5000 * round);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'noise-map/0.1 (OSM road noise mapping)',
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const xml = await res.text();
        // Overpass reports rate limits and timeouts as a 200 with an error document.
        if (xml.includes('<remark>') && !xml.includes('<node')) {
          throw new Error(`remark: ${xml.slice(0, 300)}`);
        }
        await writeFile(outPath, xml, 'utf8');
        return { bytes: Buffer.byteLength(xml), path: outPath, endpoint };
      } catch (err) {
        // Node's fetch reports every network problem as a bare "fetch failed".
        // What distinguishes "the service is down" from "nothing leaves this
        // machine" sits one level deeper, in err.cause.
        const cause = err.cause?.code ?? err.cause?.message;
        errors.push(
          `round ${round} ${new URL(endpoint).host}: ${err.message}${cause ? ` (${cause})` : ''}`,
        );
      }
    }
  }
  // Worth saying out loud: where Overpass is only reachable through a local
  // proxy, a process started without these variables fails every fetch, and the
  // symptom reads as a dead service rather than as a missing setting.
  const proxyNote = proxyUrl
    ? `proxy: ${proxyUrl}`
    : 'no proxy configured (HTTPS_PROXY and HTTP_PROXY are empty)';
  throw new Error(`all Overpass endpoints failed, ${proxyNote}\n  ${errors.join('\n  ')}`);
}
