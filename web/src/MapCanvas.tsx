import { useEffect, useRef, useState } from 'react';
import {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  VectorTileSource,
  type ExpressionSpecification,
  type MapMouseEvent,
} from 'maplibre-gl';
import polygonClipping, { type Polygon as ClipPolygon } from 'polygon-clipping';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bandFor, colourByLevel } from './palette';
import type { Centre, ComputedArea, IsophoneCollection, NoiseTiles, Period } from './api';
import type { Bounds, MapStyle, Margin } from './mapTypes';
import type { FeatureCollection } from 'geojson';

/** Слои испечённого слоя. Именованы, потому что по ним же идёт опрос под курсором. */
const NOISE_FILL = 'noise-fill';
const NOISE_LINE = 'noise-line';

/** Что показывает считывание: полоса под точкой и где эта точка. */
export interface Reading extends Centre {
  /** ISOLVL, как его записал Create_Isosurface. */
  level: number;
}

const tileUrl = (period: Period, built: number) =>
  `/api/noise/tiles/${period}/{z}/{x}/{y}.pbf?v=${built}`;

interface Props {
  /** Стиль подложки, уже загруженный — см. `basemap.ts`. */
  style: MapStyle;
  /**
   * Камера. Между обновлениями карта распоряжается ею сама: эффект ниже двигает
   * её, только когда меняется само значение, то есть по глубокой ссылке или по
   * найденному адресу, но никогда по обычному клику.
   */
  location: { center: [number, number]; zoom: number };
  /**
   * Часть карты, закрытая панелью. Обычный проп, а не начальное значение: он
   * следует за высотой панели, пока та растёт.
   */
  margin: Margin;
  features: IsophoneCollection['features'];
  centre: Centre | null;
  /** Радиус, который покрывает расчёт, м. Пока сервер не сказал — null. */
  radius: number | null;
  /** Где курсор, когда он над картой и ничего не считается. */
  hover: Centre | null;
  /** Уже посчитанные места, затенённые, чтобы их можно было найти глазами. */
  areas: ComputedArea[];
  /** Испечённый слой, если он есть. Пока не пришёл — карта как была. */
  noiseTiles: NoiseTiles | null;
  /** Какой период показывает слой; смена переключает тайлсет. */
  period: Period;
  /** Идёт ли расчёт — именно это делает кольцо сплошным. */
  running: boolean;
  onPick: (lat: number, lon: number) => void;
  onHover: (place: Centre | null) => void;
  /**
   * Что оказалось под точкой в испечённом слое, или null, если там ничего.
   * Клик по прогретому месту отвечает этим вместо того, чтобы открывать диск.
   */
  onRead: (reading: Reading | null) => void;
  /**
   * Точка, про которую спрашивают со стороны: адрес или глубокая ссылка. По
   * карте там не кликали, а ответить надо тем же самым — поэтому спрашивается
   * она здесь, где есть карта, и ответ приходит в onProbe.
   */
  probe: Centre | null;
  /** Ответ на probe: полоса под точкой или null, если слой там ничего не знает. */
  onProbe: (centre: Centre, level: number | null) => void;
  /** Показанное считывание — чтобы на карте было видно, о какой точке речь. */
  reading: Reading | null;
  /** Сообщает камеру, когда она остановилась, чтобы затенение поспевало. */
  onViewport: (view: { bounds: Bounds; zoom: number }) => void;
}

/**
 * Кольцо круга заданного радиуса, в том же плоском приближении, в каком сервер
 * считает свои рамки. Настоящий круг режется в метрической проекции; на этих
 * радиусах разница — сантиметры, много меньше толщины рисующей его линии.
 */
function ring(lat: number, lon: number, radiusMetres: number, segments = 72): [number, number][] {
  const dLat = radiusMetres / 111320;
  const dLon = radiusMetres / (111320 * Math.cos((lat * Math.PI) / 180));
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * 2 * Math.PI;
    points.push([lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  return points;
}

const ACCENT = '#cd463f';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Одно кольцо как коллекция из одного полигона — или пустая, когда его нет. */
function ringData(points: [number, number][] | null): FeatureCollection {
  if (!points) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [points] } },
    ],
  };
}

/** Кладёт данные в источник, если карта уже дожила до слоёв. */
function setData(map: MapLibreMap | null, id: string, data: FeatureCollection) {
  const source = map?.getSource(id);
  // instanceof, а не проверка поля type: у объединения источников оно не
  // дискриминирующее, и сужения по нему не происходит.
  if (source instanceof GeoJSONSource) source.setData(data);
}

const toPadding = ([top, right, bottom, left]: Margin) => ({ top, right, bottom, left });

/**
 * Насколько широко спрашивать, когда точно под точкой ничего нет, пикселей.
 *
 * Изофоны не покрывают плоскость сплошь: приёмников нет внутри зданий, и сетка
 * Делоне оставляет разрывы. Померено на прогретом Краснодаре — по сетке из 1802
 * точек ровно под курсором промахивается 47%, и коробка в шесть пикселей
 * закрывает 86% этих промахов. Единица именно пиксель, а не метр: попадание
 * задаёт рука, а не масштаб.
 */
const READ_RADIUS_PX = 6;

/**
 * Полоса испечённого слоя под точкой экрана, или null, если её там нет.
 *
 * Спрашивается у уже отрисованного тайла, поэтому не стоит ни запроса, ни
 * ожидания. Слоя может не быть вовсе — испечь его не обязательно, — и тогда
 * queryRenderedFeatures бросил бы на незнакомом id, отсюда проверка.
 *
 * Точное попадание главнее: оно отвечает про то самое место. Коробка идёт
 * следом и берёт самую частую полосу вокруг — при равенстве тихую, чтобы
 * промах не завышал уровень.
 */
function levelAt(map: MapLibreMap, x: number, y: number): number | null {
  if (!map.getLayer(NOISE_FILL)) return null;
  const exact = map.queryRenderedFeatures([x, y], { layers: [NOISE_FILL] })[0];
  const level = exact?.properties?.ISOLVL;
  if (typeof level === 'number') return level;

  const r = READ_RADIUS_PX;
  const around = map.queryRenderedFeatures(
    [
      [x - r, y - r],
      [x + r, y + r],
    ],
    { layers: [NOISE_FILL] },
  );
  const seen = new Map<number, number>();
  for (const feature of around) {
    const found = feature.properties?.ISOLVL;
    if (typeof found === 'number') seen.set(found, (seen.get(found) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [candidate, count] of seen) {
    if (count > bestCount || (count === bestCount && best !== null && candidate < best)) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Потолок ожидания слоя, мс. Не рабочий путь, а страховка: если слой так и не
 * нарисуется — его не испекли, точка вне прогретого — ответить всё равно надо.
 */
const SETTLE_TIMEOUT_MS = 8000;

/**
 * Выполняет действие, когда слой действительно что-то нарисовал — или когда
 * ждать перестало иметь смысл.
 *
 * Ждать `idle` тут нельзя: он про всю карту сразу, а подложка тянет свой
 * .pmtiles десятками секунд, и вопрос про шум простоял бы всё это время. Ждём
 * ровно то, от чего зависит ответ, и проверяем не «источник загружен» — это
 * становится правдой сразу, ещё до единого тайла, — а что на экране появились
 * объекты.
 */
function whenLayerDraws(map: MapLibreMap, run: () => void): () => void {
  const painted = () =>
    !!map.getLayer(NOISE_FILL) && map.queryRenderedFeatures({ layers: [NOISE_FILL] }).length > 0;
  if (painted()) {
    run();
    return () => {};
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    map.off('sourcedata', onData);
    map.off('idle', finish);
    clearTimeout(timer);
    run();
  };
  const onData = (event: { sourceId?: string }) => {
    if (event.sourceId === 'noise' && painted()) finish();
  };
  map.on('sourcedata', onData);
  // На случай, когда слоя не будет вовсе: карта успокоилась, рисовать нечего.
  map.once('idle', finish);
  const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
  return () => {
    done = true;
    map.off('sourcedata', onData);
    map.off('idle', finish);
    clearTimeout(timer);
  };
}

export default function MapCanvas({
  style,
  location,
  margin,
  features,
  centre,
  radius,
  hover,
  areas,
  noiseTiles,
  period,
  running,
  onPick,
  onHover,
  onRead,
  probe,
  onProbe,
  reading,
  onViewport,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const readingRef = useRef<Marker | null>(null);
  /** Слои появляются по событию `load`, до него источников ещё нет. */
  const [ready, setReady] = useState(false);

  // Обработчики подписываются один раз на всю жизнь карты, а меняются каждый
  // рендер. Через ref — иначе переподписка на каждое движение курсора.
  const handlers = useRef({ onPick, onHover, onRead, onProbe, onViewport });
  handlers.current = { onPick, onHover, onRead, onProbe, onViewport };
  // Отступ читается в момент постановки камеры, а не когда меняется сам, —
  // почему это не одно и то же, сказано у эффекта камеры ниже.
  const marginRef = useRef(margin);
  marginRef.current = margin;
  // Период читается при создании источника, а следует за ним отдельный эффект
  // ниже: в зависимостях создающего он пересобирал бы источник на каждое
  // переключение вместо того, чтобы поменять адрес тайлов.
  const periodRef = useRef(period);
  periodRef.current = period;
  // Ждать ли слоя вообще. Читается из обработчика клика, который подписан один
  // раз на всю жизнь карты, — отсюда ref, а не проп напрямую.
  const expectsLayer = useRef(noiseTiles !== null);
  expectsLayer.current = noiseTiles !== null;
  // Начальная камера. В зависимостях эффекта ей делать нечего: он создаёт
  // карту, а не следует за ней.
  const initial = useRef(location);

  // Зависимость одна — стиль: смена стиля означает другую карту, всё остальное
  // приезжает в источники и слои уже созданной.
  useEffect(() => {
    if (!container.current) return;

    const map = new MapLibreMap({
      container: container.current,
      style,
      center: initial.current.center,
      zoom: initial.current.zoom,
      // Наклон и поворот тут ничего не дают — карта плоская и читается по
      // северу, — а сбитый север сбивает и чтение изофон.
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: false },
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    const report = () => {
      const box = map.getBounds();
      handlers.current.onViewport({
        bounds: [
          [box.getWest(), box.getNorth()],
          [box.getEast(), box.getSouth()],
        ],
        zoom: map.getZoom(),
      });
    };

    map.on('load', () => {
      // Порядок добавления — он же порядок отрисовки: затенение снизу, изофоны
      // над ним, кольца поверх всего. Раньше ту же роль играл zIndex.
      map.addSource('computed', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'computed-fill',
        type: 'fill',
        source: 'computed',
        paint: { 'fill-color': ACCENT, 'fill-opacity': 0.1 },
      });
      map.addLayer({
        id: 'computed-line',
        type: 'line',
        source: 'computed',
        paint: { 'line-color': ACCENT, 'line-width': 1, 'line-opacity': 0.35 },
      });

      map.addSource('isophones', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'isophones-fill',
        type: 'fill',
        source: 'isophones',
        // Цвет приезжает в самом объекте, а не собирается выражением по ISOLVL:
        // палитра живёт в palette.ts, и её перевод в выражение стиля был бы
        // второй копией той же таблицы.
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 },
      });
      map.addLayer({
        id: 'isophones-line',
        type: 'line',
        source: 'isophones',
        // Тихие полосы бледны на подложке; обводка держит их границы там, где
        // одной заливки не хватает.
        paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.95 },
      });

      map.addSource('ring-preview', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'ring-preview-line',
        type: 'line',
        source: 'ring-preview',
        paint: {
          'line-color': ACCENT,
          'line-width': 2,
          'line-opacity': 0.75,
          // line-dasharray считается в толщинах линии, а не в пикселях: при
          // ширине 2 это те же 8 и 7 пикселей, что были у прежнего движка.
          'line-dasharray': [4, 3.5],
        },
      });

      map.addSource('ring-active', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'ring-active-line',
        type: 'line',
        source: 'ring-active',
        paint: { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.9 },
      });

      setReady(true);
      // Камера сообщает о себе по `moveend`, а карта, которую не тронули, его
      // не дождётся. У прежнего движка ради этого крутился цикл ретраев вокруг
      // ещё не подключённой сущности; здесь хватает одного вопроса по `load`.
      report();
    });

    // Наверх идёт только остановившаяся камера: `move` срабатывает на каждом
    // кадре перетаскивания, и передавать их значило бы перерисовывать дерево
    // шестьдесят раз в секунду ради ответа, который нужен один раз.
    map.on('moveend', report);
    // Клик по месту, которое слой уже показывает, отвечает на вопрос «сколько
    // тут?» и ничего не запрашивает: карта под курсором и есть ответ. Расчёт
    // остаётся тем, чем был, — но только там, где показывать нечего.
    map.on('click', (e: MapMouseEvent) => {
      const answer = () => {
        const level = levelAt(map, e.point.x, e.point.y);
        if (level !== null) {
          return handlers.current.onRead({ lat: e.lngLat.lat, lon: e.lngLat.lng, level });
        }
        handlers.current.onRead(null);
        handlers.current.onPick(e.lngLat.lat, e.lngLat.lng);
      };
      // Слой ждут, но он ещё ничего не нарисовал — а бывает, что его ещё и нет:
      // слои создаются по `load`, который ждёт первой полной отрисовки. Тогда
      // «здесь пусто» означает «я не успел посмотреть», и клик ушёл бы считать
      // то, что и так появится через секунду. Ждём — но не бесконечно.
      const painted =
        !!map.getLayer(NOISE_FILL) &&
        map.queryRenderedFeatures({ layers: [NOISE_FILL] }).length > 0;
      if (expectsLayer.current && !painted) return void whenLayerDraws(map, answer);
      answer();
    });
    map.on('mousemove', (e: MapMouseEvent) =>
      handlers.current.onHover({ lat: e.lngLat.lat, lon: e.lngLat.lng }),
    );
    map.on('mouseout', () => handlers.current.onHover(null));

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      readingRef.current?.remove();
      readingRef.current = null;
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [style]);

  // Камера. Двигается по смене `location` и намеренно не реагирует на изменение
  // отступа: панель растёт и сжимается по ходу расчёта, и дёргать карту на
  // каждое такое изменение хуже, чем оставить её там, куда её поставили.
  useEffect(() => {
    mapRef.current?.easeTo({
      center: location.center,
      zoom: location.zoom,
      padding: toPadding(marginRef.current),
      duration: 400,
    });
  }, [location]);

  // Испечённый слой. Появляется отдельным эффектом, а не в `load`: его рамка
  // приезжает с сервера и может прийти позже, чем карта нарисуется, — а может
  // не прийти вовсе, и тогда всё остальное работает как работало.
  //
  // Порядок отрисовки внутри слоя не важен, в отличие от изофон одного расчёта:
  // полосы внутри диска не пересекаются по построению, ячейки Вороного не
  // пересекаются между собой, так что мозаика — разбиение, а не стопка.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !noiseTiles) return;

    map.addSource('noise', {
      type: 'vector',
      tiles: [tileUrl(periodRef.current, noiseTiles.built)],
      minzoom: noiseTiles.minzoom,
      maxzoom: noiseTiles.maxzoom,
      bounds: noiseTiles.bounds,
    });
    // Под затенением и под изофонами: свежепосчитанный диск ложится поверх
    // испечённого слоя, потому что в пирамиде его ещё нет.
    map.addLayer(
      {
        id: NOISE_FILL,
        type: 'fill',
        source: 'noise',
        'source-layer': 'noise',
        paint: {
          'fill-color': colourByLevel() as ExpressionSpecification,
          'fill-opacity': 0.55,
        },
      },
      'computed-fill',
    );
    // Обводка держит границы тихих полос на подложке — та же причина, что у
    // изофон расчёта. Внизу она гаснет: там полоса уже меньше своей же линии.
    map.addLayer(
      {
        id: NOISE_LINE,
        type: 'line',
        source: 'noise',
        'source-layer': 'noise',
        paint: {
          'line-color': colourByLevel() as ExpressionSpecification,
          'line-width': 1,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 0.9],
        },
      },
      'computed-fill',
    );

    // Затенение говорило «тут посчитано» там, где показать было нечего. Где
    // слой рисует, оно избыточно: заливка уходит, а обводка остаётся и читается
    // уже как граница расчёта — union кругов и есть внешний край мозаики.
    const edge = noiseTiles.minzoom;
    map.setPaintProperty('computed-fill', 'fill-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      edge - 0.5,
      0.1,
      edge + 0.5,
      0,
    ]);
    map.setPaintProperty('computed-line', 'line-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      edge - 0.5,
      0.35,
      edge + 0.5,
      0.75,
    ]);

    return () => {
      // Стиль переживает этот эффект: снимаем ровно то, что добавили.
      if (map.getLayer(NOISE_LINE)) map.removeLayer(NOISE_LINE);
      if (map.getLayer(NOISE_FILL)) map.removeLayer(NOISE_FILL);
      if (map.getSource('noise')) map.removeSource('noise');
    };
  }, [ready, noiseTiles]);

  // Смена периода — это другой тайлсет, а не другой фильтр: четыре периода в
  // одном тайле весили бы вчетверо больше ради того, на что почти не смотрят.
  useEffect(() => {
    const source = mapRef.current?.getSource('noise');
    if (source instanceof VectorTileSource && noiseTiles) {
      source.setTiles([tileUrl(period, noiseTiles.built)]);
    }
  }, [period, noiseTiles]);

  // Спрошенная снаружи точка. Ждёт `idle`, потому что queryRenderedFeatures
  // отвечает только по нарисованному: камера туда ещё едет, а тайлы ещё
  // грузятся. Пока слой не испечён, ответ всегда null — и вызывающая сторона
  // уходит считать, как делала всегда.
  // Слой может приехать позже вопроса — глубокая ссылка успевает раньше, — и
  // тогда спросить надо заново, поэтому он в зависимостях.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-asking is what the dependency is for
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !probe) return;
    return whenLayerDraws(map, () => {
      const point = map.project([probe.lon, probe.lat]);
      handlers.current.onProbe(probe, levelAt(map, point.x, point.y));
    });
  }, [probe, ready, noiseTiles]);

  // Изофоны. Один источник вместо объекта на полосу: цвет уезжает в свойство,
  // порядок полос — в порядок объектов внутри коллекции.
  useEffect(() => {
    if (!ready) return;
    const drawn = features
      .map((feature) => {
        const band = bandFor(feature.properties.ISOLVL);
        if (!band) return null;
        return {
          type: 'Feature' as const,
          geometry: feature.geometry,
          properties: { color: band.color, level: band.level },
        };
      })
      .filter((feature) => feature !== null)
      // Внутри слоя рисуется в порядке следования, так что сортировка по полосе
      // и есть прежний zIndex: громкое ложится поверх тихого.
      .sort((a, b) => a.properties.level - b.properties.level);
    setData(mapRef.current, 'isophones', { type: 'FeatureCollection', features: drawn });
  }, [features, ready]);

  // Всё уже посчитанное, слитое в одну фигуру до отрисовки.
  //
  // Отдать круги как MultiPolygon мало: заливка считается по каждому полигону
  // отдельно, поэтому перекрытия складывают прозрачность в пятно потемнее, и у
  // каждого круга остаётся своя обводка — скопление посчитанных мест читается
  // тогда как куча кружков, а не как одна область. После объединения швов
  // просто нет, а дырки между кругами остаются внутренними кольцами.
  //
  // Склейка геометрическая, а не через стиль, потому что через стиль её нет: у
  // слоя заливки нет режима наложения, а непрозрачная заливка похоронила бы
  // улицы, ради которых затенение и сделано полупрозрачным.
  useEffect(() => {
    if (!ready) return;
    if (areas.length === 0) {
      setData(mapRef.current, 'computed', EMPTY);
      return;
    }
    const discs: ClipPolygon[] = areas.map((area) => [ring(area.lat, area.lon, area.radius, 64)]);
    const [first, ...rest] = discs;
    if (!first) return;
    // union() хочет первую фигуру и остальные отдельными аргументами.
    const merged = polygonClipping.union(first, ...rest);
    setData(mapRef.current, 'computed', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiPolygon', coordinates: merged },
        },
      ],
    });
  }, [areas, ready]);

  // Что накроет клик — следует за курсором. Пунктиром, потому что это
  // предложение, а не результат; на время расчёта уступает место сплошному.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    // Кольцо обещает, что накроет клик. Там, где слой уже отвечает, клик ничего
    // не накрывает — он считывает, — и обещать нечего.
    const at = map && hover ? map.project([hover.lon, hover.lat]) : null;
    const covered = map && at ? levelAt(map, at.x, at.y) !== null : false;
    const points =
      !running && hover && radius && !covered ? ring(hover.lat, hover.lon, radius) : null;
    setData(map, 'ring-preview', ringData(points));
  }, [hover, radius, running, ready]);

  // Точка считывания. Отдельный маркер, а не тот же, что у центра расчёта: это
  // разные вещи — «вот место, про которое я ответил» и «вот центр круга».
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!reading) {
      readingRef.current?.remove();
      readingRef.current = null;
      return;
    }
    if (!readingRef.current) {
      const dot = document.createElement('div');
      dot.className = 'reading-dot';
      dot.title = 'Точка, для которой показан уровень';
      readingRef.current = new Marker({ element: dot });
    }
    readingRef.current.setLngLat([reading.lon, reading.lat]).addTo(map);
  }, [reading, ready]);

  useEffect(() => {
    if (!ready) return;
    const points = running && centre && radius ? ring(centre.lat, centre.lon, radius) : null;
    setData(mapRef.current, 'ring-active', ringData(points));
  }, [centre, radius, running, ready]);

  // Центр расчёта. Маркер, а не слой: это кусок вёрстки со своим CSS.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!centre) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const dot = document.createElement('div');
      dot.className = 'centre-dot';
      dot.title = 'Центр расчёта';
      markerRef.current = new Marker({ element: dot });
    }
    markerRef.current.setLngLat([centre.lon, centre.lat]).addTo(map);
  }, [centre, ready]);

  return <div className="map-canvas" ref={container} />;
}
