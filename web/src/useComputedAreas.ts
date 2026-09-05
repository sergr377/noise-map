import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bounds } from './mapTypes';
import { fetchAreas, type ComputedArea } from './api';

/**
 * Below this zoom the computed areas are neither drawn nor asked for. A
 * 750-metre disc is about two pixels here, so the shading would be dust — and
 * the request would cover half a country to produce it.
 */
const MIN_AREA_ZOOM = 11;

export interface Viewport {
  bounds: Bounds;
  zoom: number;
}

/**
 * Keeps the shaded areas in step with the viewport.
 *
 * Asking about the place under the cursor could only ever answer for the place
 * under the cursor — someone had to find a computed area by sweeping the mouse
 * across the map to learn it was there. This asks about everything in view
 * instead, once the camera has stopped.
 *
 * Two things keep the traffic down: the box asked for is half a screen wider
 * than the screen, so panning inside it costs nothing, and below MIN_AREA_ZOOM
 * nothing is asked at all.
 *
 * `invalidate` is for the moment a calculation finishes: the place just computed
 * is now one of the shaded ones, and the camera is standing still, so nothing
 * else would ask again until it moves.
 */
export function useComputedAreas(view: Viewport | null) {
  const [areas, setAreas] = useState<ComputedArea[]>([]);
  // Box the areas were last fetched for, grown beyond the viewport so that
  // ordinary panning does not send a request per frame.
  const askedFor = useRef<{
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  } | null>(null);
  // Bumped by invalidate(); the effect below watches it so that a forced
  // refresh goes through exactly the same path as a camera move.
  const [refreshes, setRefreshes] = useState(0);

  // The body never reads `refreshes` — it is the way to re-run this: after a
  // calculation the camera is standing still, so nothing else would ask again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-running is what the dependency is for
  useEffect(() => {
    if (!view) return;
    if (view.zoom < MIN_AREA_ZOOM) {
      askedFor.current = null;
      setAreas([]);
      return;
    }

    const [[left, top], [right, bottom]] = view.bounds;
    const inside =
      askedFor.current &&
      left >= askedFor.current.minLon &&
      right <= askedFor.current.maxLon &&
      bottom >= askedFor.current.minLat &&
      top <= askedFor.current.maxLat;
    if (inside) return;

    const padLon = (right - left) / 2;
    const padLat = (top - bottom) / 2;
    const box = {
      minLon: left - padLon,
      maxLon: right + padLon,
      minLat: bottom - padLat,
      maxLat: top + padLat,
    };

    let dropped = false;
    const timer = setTimeout(() => {
      void fetchAreas(box)
        .then((found) => {
          if (dropped) return;
          askedFor.current = box;
          setAreas(found);
        })
        .catch(() => {
          /* без подсветки карта работает как раньше */
        });
    }, 300);
    return () => {
      dropped = true;
      clearTimeout(timer);
    };
  }, [view, refreshes]);

  const invalidate = useCallback(() => {
    askedFor.current = null;
    setRefreshes((n) => n + 1);
  }, []);

  return { areas, invalidate };
}
