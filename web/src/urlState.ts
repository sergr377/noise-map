import { useEffect } from 'react';
import type { Period } from './api';

/**
 * The bits of application state that live in the address bar.
 *
 * A result is worth linking to, so the picked point and the period go into the
 * URL. It also makes the app reproducible from the outside: a screenshot or a
 * bug report can name an exact location instead of "click roughly here".
 */

// Period boundaries are CNOSSOS-EU's, matching the LV_D / LV_E / LV_N traffic
// columns that Import_OSM fills in.
export const PERIODS: Array<{ id: Period; label: string; hint: string }> = [
  { id: 'D', label: 'День', hint: '6–18' },
  { id: 'E', label: 'Вечер', hint: '18–22' },
  { id: 'N', label: 'Ночь', hint: '22–6' },
  { id: 'DEN', label: 'Lden', hint: 'сводный' },
];

export function readLocationFromUrl(): { lat: number; lon: number } | null {
  const params = new URLSearchParams(window.location.search);
  const rawLat = params.get('lat');
  const rawLon = params.get('lon');
  // Presence has to be checked before conversion: Number(null) and Number('')
  // are both 0, which is a real coordinate — the Gulf of Guinea — so a plain
  // URL would silently deep-link into the ocean.
  if (!rawLat || !rawLon) return null;

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Period from the link. Sharing night noise and having the recipient open Lden
 * makes the link say something other than what was shown.
 */
export function readPeriodFromUrl(): Period | null {
  const raw = new URLSearchParams(window.location.search).get('period');
  return PERIODS.some((p) => p.id === raw) ? (raw as Period) : null;
}

/** Records the picked point, replacing rather than stacking history entries. */
export function writeLocationToUrl(lat: number, lon: number) {
  const url = new URL(window.location.href);
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lon', lon.toFixed(5));
  window.history.replaceState(null, '', url);
}

/**
 * Keeps the period in the URL. A bare visit keeps its bare URL: the parameter
 * appears once there is a point to look at, or once the period stops being the
 * default one.
 */
export function usePeriodInUrl(period: Period) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lat') && period === 'DEN') return;
    url.searchParams.set('period', period);
    window.history.replaceState(null, '', url);
  }, [period]);
}
