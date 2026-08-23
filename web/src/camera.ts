import type { Margin } from '@yandex/ymaps3-types';

/** Where the map opens: the city, not a disc — nothing has been computed yet. */
export const DEFAULT_CENTER: [number, number] = [37.6173, 55.7558];
export const DEFAULT_ZOOM = 14.4;

/** Web Mercator ground resolution at the equator, metres per pixel at zoom 0. */
const EQUATOR_METRES_PER_PIXEL = 156543.03392;

/** How much of the free map area the disc is allowed to fill. */
const FIT_FILL = 0.92;

/**
 * Zoom at which the computed disc fills the part of the map the panel leaves
 * free.
 *
 * Framing is computed rather than fixed because both terms move: the radius is a
 * server-side calculation parameter, and the free area flips between a wide
 * column next to the panel and a short strip above a bottom sheet. A constant
 * that suits one of those crops the result in the other.
 */
export function zoomForDisc(radiusMetres: number, lat: number, margin: Margin): number {
  const [top, right, bottom, left] = margin;
  // Before the panel has been measured the margins are zero; the viewport is
  // still the right answer, just a slightly generous one.
  const free = Math.min(
    Math.max(160, window.innerWidth - left - right),
    Math.max(160, window.innerHeight - top - bottom),
  );
  const metresPerPixel = (2 * radiusMetres) / (free * FIT_FILL);
  const zoom = Math.log2(
    (EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / metresPerPixel,
  );
  // The map refuses nothing, but a disc framed at zoom 20 would mean the radius
  // arrived nonsensical; clamping keeps a bad number from losing the user.
  return Math.min(17, Math.max(10, Math.round(zoom * 100) / 100));
}
