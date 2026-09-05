import { useEffect, useRef, useState } from 'react';
import { GeoJSONSource, Map as MapLibreMap, Marker, type MapMouseEvent } from 'maplibre-gl';
import polygonClipping, { type Polygon as ClipPolygon } from 'polygon-clipping';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bandFor } from './palette';
import type { Centre, ComputedArea, IsophoneCollection } from './api';
import type { Bounds, MapStyle, Margin } from './mapTypes';
import type { FeatureCollection } from 'geojson';

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
  /** Идёт ли расчёт — именно это делает кольцо сплошным. */
  running: boolean;
  onPick: (lat: number, lon: number) => void;
  onHover: (place: Centre | null) => void;
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

export default function MapCanvas({
  style,
  location,
  margin,
  features,
  centre,
  radius,
  hover,
  areas,
  running,
  onPick,
  onHover,
  onViewport,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  /** Слои появляются по событию `load`, до него источников ещё нет. */
  const [ready, setReady] = useState(false);

  // Обработчики подписываются один раз на всю жизнь карты, а меняются каждый
  // рендер. Через ref — иначе переподписка на каждое движение курсора.
  const handlers = useRef({ onPick, onHover, onViewport });
  handlers.current = { onPick, onHover, onViewport };
  // Отступ читается в момент постановки камеры, а не когда меняется сам, —
  // почему это не одно и то же, сказано у эффекта камеры ниже.
  const marginRef = useRef(margin);
  marginRef.current = margin;
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
    map.on('click', (e: MapMouseEvent) => handlers.current.onPick(e.lngLat.lat, e.lngLat.lng));
    map.on('mousemove', (e: MapMouseEvent) =>
      handlers.current.onHover({ lat: e.lngLat.lat, lon: e.lngLat.lng }),
    );
    map.on('mouseout', () => handlers.current.onHover(null));

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
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
    const points = !running && hover && radius ? ring(hover.lat, hover.lon, radius) : null;
    setData(mapRef.current, 'ring-preview', ringData(points));
  }, [hover, radius, running, ready]);

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
