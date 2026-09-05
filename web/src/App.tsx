import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapStyle } from './mapTypes';
import { usePanelMargin } from './usePanelMargin';
import Legend from './Legend';
import PeriodSwitch from './PeriodSwitch';
import ProgressPanel from './ProgressPanel';
import SearchPanel from './SearchPanel';
import { DEFAULT_CENTER, DEFAULT_ZOOM, zoomForDisc } from './camera';
import { useElapsedSeconds, useSmoothProgress } from './progress';
import { useAddressSearch } from './useAddressSearch';
import { useComputedAreas, type Viewport } from './useComputedAreas';
import { useNoiseJob } from './useNoiseJob';
import { PERIODS, readLocationFromUrl, readPeriodFromUrl, usePeriodInUrl } from './urlState';
import { fetchConfig, type Centre, type Period, type Place } from './api';
import { isMapTimeout } from './mapErrors';

/**
 * Composition root: the map, the panel, and the wiring between them.
 *
 * Everything with a life of its own lives beside this file — the calculation in
 * useNoiseJob, the address box in useAddressSearch, the shaded areas in
 * useComputedAreas, the bar and the clock in progress.ts. What is left here is
 * what genuinely belongs to the page as a whole: which period is shown, where
 * the camera is, and the handful of rules that connect one part to another.
 */
export default function App() {
  /**
   * Карта и её стиль, загруженные вместе.
   *
   * Лениво — по двум причинам сразу. Во-первых, maplibre-gl весит больше всего
   * остального бандла, и держать его в первом чанке значит платить за карту до
   * того, как станет ясно, откроется ли она. Во-вторых, отказ стиля должен
   * превращаться в читаемое сообщение, а не в пустую страницу: бросок при
   * вычислении модуля унёс бы с собой всё приложение.
   */
  const [mapModule, setMapModule] = useState<{
    MapCanvas: typeof import('./MapCanvas').default;
    style: MapStyle;
  } | null>(null);
  const [mapError, setMapError] = useState<{ message: string; timedOut: boolean } | null>(null);
  /**
   * Radius a click covers. Asked of the server rather than kept as a constant
   * here: it is a calculation parameter, and a second copy would eventually
   * describe a circle the results do not match.
   */
  const [radius, setRadius] = useState<number | null>(null);
  /** Where the cursor is over the map, for the ring that previews a click. */
  const [hover, setHover] = useState<Centre | null>(null);
  /** The camera, as the map last reported it. Null until the map has drawn. */
  const [view, setView] = useState<Viewport | null>(null);

  const [period, setPeriod] = useState<Period>(() => readPeriodFromUrl() ?? 'DEN');
  usePeriodInUrl(period);

  const panelRef = useRef<HTMLDivElement>(null);
  const margin = usePanelMargin(panelRef);
  // Read inside the job handlers, which are created once and must not be
  // rebuilt every time the panel changes height.
  const marginRef = useRef(margin);
  marginRef.current = margin;

  // Read once: later picks rewrite the URL, and re-reading it would loop.
  const [deepLink] = useState(readLocationFromUrl);
  const [location, setLocation] = useState(() => ({
    center: deepLink ? ([deepLink.lon, deepLink.lat] as [number, number]) : DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
  }));

  const { areas, invalidate: refreshAreas } = useComputedAreas(view);
  const search = useAddressSearch();

  const job = useNoiseJob({
    // A deep link or an address search moves the camera anyway, so framing the
    // disc that is about to appear is part of that same move. A map click is
    // deliberately left alone: the user chose that view, and pulling it from
    // under them is worse than a result they have to zoom out to take in.
    onCentre: (centre, discRadius, source) => {
      if (source === 'map') return;
      setLocation({
        center: [centre.lon, centre.lat],
        zoom: zoomForDisc(discRadius, centre.lat, marginRef.current),
      });
    },
    onResult: refreshAreas,
  });

  const { pick } = job;

  /**
   * Every pick goes through here. A map click also means the address in the box
   * no longer describes what is shown, so it goes away rather than sitting
   * there contradicting the map.
   */
  const handlePick = useCallback(
    (lat: number, lon: number, source: 'map' | 'search' | 'link' = 'map') => {
      if (source === 'map') search.clear();
      void pick(lat, lon, source);
    },
    [pick, search.clear],
  );

  const handleSelect = useCallback(
    (place: Place) => {
      search.accept(place);
      // The centre moves at once, so picking an address registers immediately;
      // the zoom waits for the radius the server sends back a moment later.
      // Doing both here and then refitting would be two camera jumps in a row.
      setLocation((prev) => ({ center: [place.lon, place.lat], zoom: prev.zoom }));
      handlePick(place.lat, place.lon, 'search');
    },
    [handlePick, search.accept],
  );

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        // Код карты и её стиль запрашиваются разом: ждать один после другого
        // значило бы сложить две задержки там, где они независимы.
        const [{ default: MapCanvas }, { loadStyle }] = await Promise.all([
          import('./MapCanvas'),
          import('./basemap'),
        ]);
        const style = await loadStyle();
        if (!dropped) setMapModule({ MapCanvas, style });
      } catch (err) {
        if (!dropped) {
          setMapError({ message: (err as Error).message, timedOut: isMapTimeout(err) });
        }
      }
    })();
    return () => {
      dropped = true;
    };
  }, []);

  useEffect(() => {
    let dropped = false;
    // A failure here costs the preview ring and nothing else, so it stays
    // quiet: the map, the search and the calculation all work without it.
    void fetchConfig()
      .then((config) => {
        if (!dropped) setRadius(config.radius);
      })
      .catch(() => {});
    return () => {
      dropped = true;
    };
  }, []);

  // Re-centre on the computed point when the window is resized. The map applies
  // the panel margin when a location is set, not when the margin itself changes,
  // so rotating a phone or flipping the layout breakpoint would otherwise leave
  // the result off-screen. Deliberately bound to resize rather than to the
  // margin value: the panel also grows and shrinks as progress and results
  // appear, and yanking the camera on every such change would be worse.
  useEffect(() => {
    const centre = job.centre;
    if (!centre) return;
    const recentre = () =>
      setLocation((prev) => ({ center: [centre.lon, centre.lat], zoom: prev.zoom }));
    window.addEventListener('resize', recentre);
    return () => window.removeEventListener('resize', recentre);
  }, [job.centre]);

  // Kick off the deep-linked calculation once the map module is in place, so the
  // marker and isophones land on a map that already exists.
  useEffect(() => {
    if (mapModule && deepLink) handlePick(deepLink.lat, deepLink.lon, 'link');
  }, [mapModule, deepLink, handlePick]);

  const smoothed = useSmoothProgress(job.job?.progress ?? 0, job.busy && !job.fromCache);
  const elapsed = useElapsedSeconds(job.busy && !job.fromCache, job.job?.elapsedMs);

  // The finished map wins; until it exists, the newest frame stands in for it.
  const shown = job.data ?? job.preview;
  const visible = useMemo(
    () => (shown?.features ?? []).filter((f) => f.properties.PERIOD === period),
    [shown, period],
  );

  const presentLevels = useMemo(() => new Set(visible.map((f) => f.properties.ISOLVL)), [visible]);

  return (
    <div className="app">
      {/* The map fills the app; the panel floats over it and must be free to
          size itself to its content. */}
      <div className="map">
        {mapModule ? (
          <mapModule.MapCanvas
            style={mapModule.style}
            location={location}
            margin={margin}
            features={visible}
            centre={job.centre}
            radius={radius}
            hover={hover}
            areas={areas}
            running={job.busy && !job.fromCache}
            onPick={handlePick}
            onHover={setHover}
            onViewport={setView}
          />
        ) : (
          <div className="map-placeholder">
            {mapError ? (
              <div className="map-error">
                <strong>Карта не загрузилась</strong>
                <p>{mapError.message}</p>
                {mapError.timedOut ? (
                  <p className="note">
                    Настройки тут ни при чём: ответа просто не дождались. Проверьте сеть и
                    перезагрузите страницу — остальное на ней работает и без карты.
                  </p>
                ) : (
                  <p className="note">
                    Подложка своя и лежит рядом с сервисом. Чаще всего это значит, что тайлы ещё не
                    собраны или каталог с ними не подключён к серверу — как их собрать, написано в
                    README, раздел «Подложка». Расчёт и поиск при этом работают: карта нужна только
                    чтобы посмотреть на результат.
                  </p>
                )}
              </div>
            ) : (
              <span className="note">Загружаю карту…</span>
            )}
          </div>
        )}
      </div>

      <div className="panel" ref={panelRef}>
        <h1>Карта шума</h1>
        <p className="lead">
          Найдите адрес или кликните по карте — рассчитаем уровень шума от автотранспорта в радиусе
          750 м по методу CNOSSOS-EU.
        </p>

        <SearchPanel
          query={search.query}
          onQueryChange={search.setQuery}
          onSubmit={search.submit}
          searching={search.searching}
          error={search.error}
          places={search.places}
          onSelect={handleSelect}
        />

        {areas.length > 0 && !job.busy && !job.data && (
          <p className="note">
            Затенённые области уже посчитаны — они открываются сразу, без ожидания.
          </p>
        )}

        <PeriodSwitch period={period} onChange={setPeriod} disabled={!shown} />

        {job.busy && (
          <ProgressPanel
            progress={smoothed}
            label={job.job?.label ?? 'Отправляю запрос'}
            seconds={elapsed}
            fromCache={job.fromCache}
            canCancel={job.runningId !== null}
            onCancel={job.cancel}
            previewKind={job.preview ? job.previewKind : null}
            superseded={job.superseded}
          />
        )}

        {job.error && <p className="error">Не получилось: {job.error}</p>}

        {job.cancelled && !job.busy && (
          <p className="note">
            Расчёт отменён
            {job.previewKind === 'rough' ? '; на карте осталась предварительная оценка' : ''}
            {job.previewKind === 'frame' ? '; на карте осталось то, что успело посчитаться' : ''}.
            Если эту же точку ждал кто-то ещё, счёт продолжается — тогда результат всё равно попадёт
            в кэш.
          </p>
        )}

        {job.data && !job.busy && (
          <p className="note">
            {job.fromCache ? 'Взято из кэша.' : 'Рассчитано.'} Показан период{' '}
            {PERIODS.find((p) => p.id === period)?.label}, {visible.length} контуров.
          </p>
        )}

        {job.covering && job.data && !job.busy && (
          <p className="note">
            Готовый расчёт соседнего места — ваша точка внутри него, поэтому карта открылась сразу.
            Центр отмечен на карте: он в стороне от клика, но у края круга расчёт такой же полный,
            как в середине.
          </p>
        )}

        <Legend hasMap={shown !== null} presentLevels={presentLevels} />

        <p className="disclaimer">
          Расчётная оценка по типовым значениям трафика, а не результат измерений. Данные{' '}
          <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>, расчёт —{' '}
          <a href="https://github.com/Universite-Gustave-Eiffel/NoiseModelling">NoiseModelling</a>.
        </p>
      </div>
    </div>
  );
}
