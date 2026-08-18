import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
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

export async function writeCache(key: string, sourcePath: string): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });
  const data = await readFile(sourcePath);
  await writeFile(cachePath(key), data);
  return data.byteLength;
}

export async function cacheSize(key: string): Promise<number | null> {
  try {
    return (await stat(cachePath(key))).size;
  } catch {
    return null;
  }
}
