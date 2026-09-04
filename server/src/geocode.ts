/**
 * Поиск по адресу через Nominatim — геокодер по данным OpenStreetMap.
 *
 * Почему не Яндекс. Во-первых, суточный лимит его бесплатного ключа
 * измеряется сотней запросов, то есть сотней посетителей, и это не лечится
 * оптимизацией. Во-вторых, его условия запрещают сохранять полученные данные,
 * так что кэш, который тут напрашивается сам, был бы нарушением. В-третьих —
 * и это важнее счётчика — искать имеет смысл ровно там, где потом можно
 * считать: адрес, которого нет в OSM, приведёт в место, где расчёту нечем
 * работать. Теперь поиск и модель смотрят в одни данные.
 *
 * ODbL хранение разрешает, требуя лишь атрибуции, — она есть и в интерфейсе,
 * и в стиле подложки.
 */
import { NOMINATIM_CONTACT, NOMINATIM_MIN_INTERVAL_MS, NOMINATIM_URL } from './config.js';

export interface Place {
  /** Короткое имя, например «Тверская улица, 12». */
  name: string;
  /** Полный адрес, как его разобрал геокодер. */
  description: string;
  lat: number;
  lon: number;
  /** Насколько точно попали: exact | street | area | other. */
  precision: string;
}

/** Только те поля, которые читаются; настоящий ответ заметно больше. */
interface NominatimPlace {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  address?: Record<string, string>;
}

export class GeocoderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Ответы на уже заданные вопросы.
 *
 * Кэш здесь не про экономию денег — запросы бесплатны, — а про вежливость и
 * скорость: у публичного Nominatim правило «не чаще запроса в секунду», и без
 * кэша каждый повтор того же адреса вставал бы в очередь за ним. Адреса не
 * переезжают, поэтому срока годности нет; карта живёт в памяти и теряется при
 * перезапуске, и это не беда — терять нечего, кроме первого повтора.
 */
const answers = new Map<string, Place[]>();
const CACHE_LIMIT = 2000;

/**
 * Ключ кэша. Регистр, лишние пробелы и запятые к делу не относятся: «Тверская
 * ул., 12» и «тверская ул 12» — один и тот же вопрос.
 */
function cacheKey(query: string, limit: number): string {
  const normal = query.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${limit}:${normal}`;
}

function remember(key: string, places: Place[]) {
  // Map хранит порядок вставки, так что первый ключ — самый давний. Простое
  // вытеснение по возрасту: держать здесь настоящий LRU значило бы обновлять
  // порядок на каждом чтении ради кэша, который и так почти всегда попадает.
  if (answers.size >= CACHE_LIMIT) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
  answers.set(key, places);
}

/**
 * Очередь к геокодеру.
 *
 * Публичный Nominatim просит не больше запроса в секунду и банит за нарушение,
 * поэтому запросы идут строго по одному и с паузой. Своя очередь, а не корзина
 * лимитера: та защищает нас от посетителя, а эта — чужой сервер от нас, и
 * посчитана она на весь процесс, а не на адрес.
 */
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = lastCall + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    return work();
  });
  // Хвост очереди не должен обрываться на первой же ошибке — иначе один
  // неудачный запрос запер бы поиск до перезапуска.
  queue = next.catch(() => {});
  return next;
}

/**
 * Насколько точно геокодер попал.
 *
 * Строки те же, что отдавались раньше, потому что это часть ответа API, а не
 * внутреннее дело сервера. Значения Nominatim к ним сводятся огрублением: он
 * различает больше видов объектов, чем интерфейсу есть смысл показывать.
 */
function precisionOf(place: NominatimPlace): string {
  const type = place.addresstype ?? '';
  if (place.address?.house_number || type === 'house' || type === 'building') return 'exact';
  if (type === 'road') return 'street';
  if (['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet'].includes(type))
    return 'area';
  return 'other';
}

/**
 * Короткое имя для списка результатов.
 *
 * Собирается из улицы и дома, а не берётся из поля `name`: у дома Nominatim
 * кладёт туда голый номер, и список превращался в «176, 176, 176» — три
 * одинаковых строки на три разных места. Улица и дом различают их так же, как
 * раньше это делал Яндекс, и ровно это набирает человек в поиске.
 */
function shortName(place: NominatimPlace): string {
  const road = place.address?.road;
  const house = place.address?.house_number;
  if (road && house) return `${road}, ${house}`;
  if (place.name) return place.name;
  const first = place.display_name?.split(',')[0]?.trim();
  return first || 'без названия';
}

export async function geocode(query: string, limit = 5): Promise<Place[]> {
  const key = cacheKey(query, limit);
  const known = answers.get(key);
  if (known) return known;

  // Склейка, а не new URL('/search', base): у своего инстанса база часто идёт
  // с путём («…/nominatim»), и абсолютный путь второго аргумента его срезал бы.
  const url = new URL(`${NOMINATIM_URL.replace(/\/+$/, '')}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  // Дом нужен отдельным полем: по нему отличается точное попадание от улицы.
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'ru');

  const res = await serialise(() =>
    fetch(url, {
      // Nominatim требует опознаваемый User-Agent с рабочим контактом и
      // отвечает 403 тем, кто представился чужим именем или никак.
      headers: { 'User-Agent': NOMINATIM_CONTACT },
      signal: AbortSignal.timeout(15_000),
    }),
  ).catch((err: unknown) => {
    throw new GeocoderError(`геокодер недоступен: ${(err as Error).message}`, 502);
  });

  if (!res.ok) {
    // 403 и 429 значат, что нас попросили умерить пыл или вовсе не пустили, —
    // это наша настройка, как и раньше был наш просроченный ключ, поэтому 503,
    // а не 502, оставленный чужому серверу, который сломался сам.
    const ours = res.status === 403 || res.status === 429;
    throw new GeocoderError(`геокодер ответил ${res.status}`, ours ? 503 : 502);
  }

  const found = (await res.json()) as NominatimPlace[];

  const places: Place[] = [];
  for (const place of Array.isArray(found) ? found : []) {
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    places.push({
      name: shortName(place),
      description: place.display_name ?? '',
      lat,
      lon,
      precision: precisionOf(place),
    });
  }

  remember(key, places);
  return places;
}
