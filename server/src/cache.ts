import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR, CACHE_GRID_METERS, JOB_PARAMS } from './config.js';

/**
 * Snap a coordinate to a fixed grid so nearby clicks share a cache entry.
 *
 * Longitude degrees shrink with latitude, so the longitude step is derived from
 * the *snapped* latitude rather than the raw one. Using the raw latitude makes
 * the function non-idempotent: feeding a cell centre back in yields a slightly
 * different step, which near a cell boundary shifts the result into the
 * neighbouring cell. That would let one location carry two different cache keys.
 */
export function quantize(lat: number, lon: number, meters = CACHE_GRID_METERS) {
  const stepLat = meters / 111320;
  const snappedLat = Math.round(lat / stepLat) * stepLat;
  const stepLon = meters / (111320 * Math.cos((snappedLat * Math.PI) / 180));
  return {
    lat: snappedLat,
    lon: Math.round(lon / stepLon) * stepLon,
  };
}

/**
 * The key covers the calculation parameters too: changing the radius or the
 * diffraction settings has to invalidate everything computed before it.
 */
export function cacheKey(lat: number, lon: number): string {
  const q = quantize(lat, lon);
  const payload = JSON.stringify({
    lat: q.lat.toFixed(5),
    lon: q.lon.toFixed(5),
    ...JOB_PARAMS,
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

const cachePath = (key: string) => path.join(CACHE_DIR, `${key}.geojson`);

export async function readCache(key: string): Promise<Buffer | null> {
  try {
    return await readFile(cachePath(key));
  } catch {
    return null;
  }
}

export async function writeCache(
  key: string,
  sourcePath: string,
  area: Omit<CachedArea, 'id'>,
): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });
  const data = await readFile(sourcePath);
  await writeFile(cachePath(key), data);
  // The key is a hash, so nothing about the place can be read back out of it.
  // Where the result sits is written alongside, which is what lets the map show
  // computed areas without opening a single map file.
  await writeFile(metaPath(key), JSON.stringify(area), 'utf8');
  (await ensureIndex()).set(key, { id: key, ...area });
  return data.byteLength;
}

/** A computed place, as the map needs to draw it: a disc around a point. */
export interface CachedArea {
  id: string;
  lat: number;
  lon: number;
  /** Metres. Stored per entry because the parameter can change between runs. */
  radius: number;
}

const metaPath = (key: string) => path.join(CACHE_DIR, `${key}.json`);

/**
 * What the cache holds, in memory. A viewport query happens on every pan, and it
 * must not cost a directory scan — let alone opening two-megabyte maps.
 */
let index: Map<string, CachedArea> | null = null;
let building: Promise<Map<string, CachedArea>> | null = null;

async function readMeta(key: string): Promise<CachedArea | null> {
  try {
    const raw = JSON.parse(await readFile(metaPath(key), 'utf8')) as Partial<CachedArea>;
    if (Number.isFinite(raw.lat) && Number.isFinite(raw.lon) && Number.isFinite(raw.radius)) {
      return {
        id: key,
        lat: raw.lat as number,
        lon: raw.lon as number,
        radius: raw.radius as number,
      };
    }
  } catch {
    /* no sidecar, or an unreadable one */
  }
  return null;
}

/**
 * Recovers centre and radius from the map itself, for entries written before the
 * sidecars existed. The result is clipped to its disc, so the bounding box of its
 * geometry *is* that disc's bounding square. Written back as a sidecar, so this
 * costs one parse per entry ever rather than one per request.
 */
async function recoverMeta(key: string): Promise<CachedArea | null> {
  const data = await readCache(key);
  if (!data) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    } else if (Array.isArray(c)) {
      for (const part of c) walk(part);
    }
  };
  try {
    const gj = JSON.parse(data.toString('utf8')) as {
      features?: Array<{ geometry?: { coordinates?: unknown } }>;
    };
    for (const feature of gj.features ?? []) {
      if (feature.geometry?.coordinates) walk(feature.geometry.coordinates);
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(minLat) || minLat > maxLat) return null;

  const area: CachedArea = {
    id: key,
    lat: (minLat + maxLat) / 2,
    lon: (minLon + maxLon) / 2,
    radius: ((maxLat - minLat) / 2) * 111320,
  };
  const { id: _id, ...meta } = area;
  await writeFile(metaPath(key), JSON.stringify(meta), 'utf8').catch(() => {
    /* read-only cache is fine; the entry is just recovered again next time */
  });
  return area;
}

function ensureIndex(): Promise<Map<string, CachedArea>> {
  if (index) return Promise.resolve(index);
  building ??= (async () => {
    const built = new Map<string, CachedArea>();
    let names: string[] = [];
    try {
      names = await readdir(CACHE_DIR);
    } catch {
      /* nothing cached yet */
    }
    for (const name of names) {
      if (!name.endsWith('.geojson')) continue;
      const key = name.slice(0, -'.geojson'.length);
      const area = (await readMeta(key)) ?? (await recoverMeta(key));
      if (!area) continue;
      // Only entries a click could actually be served from. The key covers the
      // calculation parameters, so a result from an earlier radius keeps lying
      // around under a key nothing will ask for again — shading it would promise
      // an instant answer where a click starts a quarter of an hour of work.
      // Recovered centres are metres-accurate and the grid cell is a hundred, so
      // a rare miss here drops an entry that is in fact serviceable: the click
      // still opens instantly, it simply was not advertised.
      if (cacheKey(area.lat, area.lon) !== key) continue;
      built.set(key, area);
    }
    index = built;
    building = null;
    return built;
  })();
  return building;
}

/**
 * The computed result covering this point, if there is one.
 *
 * A click is snapped to a ~100 m cell, but a result covers a disc of 750 — an
 * area 175 times larger. Without this, clicking anywhere in a shaded area except
 * the cell it was computed from started a fresh quarter of an hour, and the
 * shading promised something it did not deliver.
 *
 * Handing over a neighbour's map is honest here because the disc is uniformly
 * valid: receivers are bounded by it, while sources and buildings are extracted
 * to radius + maxSrcDist, so a receiver on the rim has every source that can
 * reach it. The map is not centred on the click, which the interface says.
 *
 * Of several covering areas the deepest-covering one wins — the click sits
 * furthest from its rim, and with equal radii that is simply the nearest centre.
 */
export async function coveringArea(lat: number, lon: number): Promise<CachedArea | null> {
  const all = await ensureIndex();
  let best: CachedArea | null = null;
  let bestDepth = Infinity;
  for (const area of all.values()) {
    const dx = (lon - area.lon) * 111320 * Math.cos((area.lat * Math.PI) / 180);
    const dy = (lat - area.lat) * 111320;
    const relative = Math.sqrt(dx * dx + dy * dy) / area.radius;
    if (relative <= 1 && relative < bestDepth) {
      bestDepth = relative;
      best = area;
    }
  }
  return best;
}

/**
 * Computed areas whose disc reaches into the given box.
 *
 * The test is the box grown by the disc radius against the centre — a circle
 * against a rectangle to the precision that matters when the answer only decides
 * whether to draw a shape that is itself approximate.
 */
export async function cachedAreas(
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  limit: number,
): Promise<{ areas: CachedArea[]; truncated: boolean }> {
  const all = await ensureIndex();
  const areas: CachedArea[] = [];
  let truncated = false;
  for (const area of all.values()) {
    const padLat = area.radius / 111320;
    const padLon = area.radius / (111320 * Math.cos((area.lat * Math.PI) / 180));
    if (
      area.lat < bounds.minLat - padLat ||
      area.lat > bounds.maxLat + padLat ||
      area.lon < bounds.minLon - padLon ||
      area.lon > bounds.maxLon + padLon
    ) {
      continue;
    }
    if (areas.length >= limit) {
      truncated = true;
      break;
    }
    areas.push(area);
  }
  return { areas, truncated };
}

export async function cacheSize(key: string): Promise<number | null> {
  try {
    return (await stat(cachePath(key))).size;
  } catch {
    return null;
  }
}
