/**
 * Подложка: регистрация протокола PMTiles и загрузка стиля.
 *
 * Стиль забирается своим `fetch`, а не отдаётся MapLibre по URL, ровно ради
 * диагностики: карте с недоступным стилем нечего рисовать, но она об этом молчит
 * и остаётся пустым серым полем. Своя загрузка превращает это в отклонённый
 * промис — и в тот же экран ошибки, который раньше объяснял отказ ключа.
 */
import { addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import type { MapStyle } from './mapTypes';
import { MAP_LOAD_TIMEOUT } from './mapErrors';

/**
 * Откуда берётся карта. Раздаётся своим же сервером — см. `serveTiles` в
 * server/src/index.ts; в разработке Vite проксирует /tiles туда же, куда /api.
 */
export const STYLE_URL = '/tiles/style.json';

/**
 * Потолок на загрузку стиля. Ни ошибка, ни успех не приходят на подвисшем
 * соединении — запрос просто висит, и интерфейсу нечего показать, кроме
 * «Загружаю карту…» навсегда. У всех остальных сетевых вызовов проекта срок
 * есть, у этого не было.
 */
const LOAD_TIMEOUT_MS = 20_000;

// Адрес воркера MapLibre вычисляет в рантайме из import.meta.url, поэтому
// статически его не видит ни один сборщик: файл не попадает в сборку, а карта
// на живом сервере просит /assets/maplibre-gl-worker.mjs, получает index.html и
// падает на проверке MIME-типа. Молча — карта просто остаётся пустой. Импорт
// через ?worker&url заставляет Vite собрать воркер (у него свой импорт общего
// чанка) и вернуть настоящий адрес.
setWorkerUrl(workerUrl);

// Один раз на модуль: MapLibre держит протоколы глобально, и повторная
// регистрация того же имени — ошибка, а не безобидный повтор.
addProtocol('pmtiles', new Protocol().tile);

export async function loadStyle(): Promise<MapStyle> {
  const res = await fetch(STYLE_URL, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) }).catch(
    (err: unknown) => {
      // AbortSignal.timeout отклоняет TimeoutError. Отличать его важно: совет
      // про недособранные тайлы к оборванной сети не относится.
      if (err instanceof Error && err.name === 'TimeoutError') {
        const timeout = new Error(
          `стиль карты не ответил за ${LOAD_TIMEOUT_MS / 1000} с — похоже на проблему с сетью`,
        );
        timeout.name = MAP_LOAD_TIMEOUT;
        throw timeout;
      }
      throw new Error('не удалось запросить стиль карты — проверьте сеть');
    },
  );

  if (!res.ok) {
    throw new Error(
      `стиль карты не отдался (HTTP ${res.status}). Обычно это значит, что тайлы ещё ` +
        'не собраны или каталог с ними не подключён — см. README, раздел про подложку',
    );
  }

  return (await res.json()) as MapStyle;
}
