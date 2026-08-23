/**
 * Shared between the map bootstrap and the screen that reports its failure.
 *
 * A separate file rather than an export from ymaps.ts: that module runs a
 * top-level await, so importing anything from it statically would load the
 * Yandex API eagerly — the very thing the lazy import exists to avoid.
 */

/** Marks a bootstrap that ran out of time rather than being refused. */
export const MAP_LOAD_TIMEOUT = 'MapLoadTimeout';

export function isMapTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === MAP_LOAD_TIMEOUT;
}
