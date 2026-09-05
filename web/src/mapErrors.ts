/**
 * Общее между загрузкой подложки и экраном, который сообщает о её отказе.
 *
 * Отдельный файл, а не экспорт из basemap.ts: тот модуль тянет за собой
 * maplibre-gl, и статический импорт из App загрузил бы всю библиотеку сразу —
 * ровно то, ради чего карта и вынесена в отдельный чанк.
 */

/** Помечает загрузку, которая не дождалась ответа, а не была отвергнута. */
export const MAP_LOAD_TIMEOUT = 'MapLoadTimeout';

export function isMapTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === MAP_LOAD_TIMEOUT;
}
