import { GEOCODER_KEY } from './config.js';

export interface Place {
  /** Short name, e.g. "Тверская улица, 12". */
  name: string;
  /** Full address as the geocoder resolved it. */
  description: string;
  lat: number;
  lon: number;
  /** Geocoder's own confidence: exact | number | near | range | street | other. */
  precision: string;
}

/** Only the fields we read; the real response is far larger. */
interface YandexGeocoderResponse {
  response?: {
    GeoObjectCollection?: {
      featureMember?: Array<{
        GeoObject?: {
          name?: string;
          description?: string;
          Point?: { pos?: string };
          metaDataProperty?: {
            GeocoderMetaData?: { precision?: string; text?: string };
          };
        };
      }>;
    };
  };
}

export class GeocoderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function geocode(query: string, limit = 5): Promise<Place[]> {
  if (!GEOCODER_KEY) {
    throw new GeocoderError('поиск по адресу не настроен: нет YANDEX_GEOCODER_KEY', 503);
  }

  const url = new URL('https://geocode-maps.yandex.ru/1.x/');
  url.searchParams.set('apikey', GEOCODER_KEY);
  url.searchParams.set('geocode', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('results', String(limit));
  url.searchParams.set('lang', 'ru_RU');

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    // 403 here almost always means the key lost its quota or was revoked. That
    // is our own configuration failing, exactly like the missing key above, so
    // it answers 503 and not the 502 kept for an upstream that misbehaved.
    throw new GeocoderError(`геокодер ответил ${res.status}`, res.status === 403 ? 503 : 502);
  }

  const data = (await res.json()) as YandexGeocoderResponse;
  const members = data.response?.GeoObjectCollection?.featureMember ?? [];

  const places: Place[] = [];
  for (const member of members) {
    const object = member.GeoObject;
    const pos = object?.Point?.pos;
    if (!pos) continue;
    // Yandex writes "lon lat", the opposite order from most APIs.
    const [lon, lat] = pos.split(' ').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    places.push({
      name: object?.name ?? 'без названия',
      description: object?.description ?? object?.metaDataProperty?.GeocoderMetaData?.text ?? '',
      lat: lat as number,
      lon: lon as number,
      precision: object?.metaDataProperty?.GeocoderMetaData?.precision ?? 'other',
    });
  }
  return places;
}
