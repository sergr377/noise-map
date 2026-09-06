import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapStyle } from './mapTypes';
import { usePanelMargin } from './usePanelMargin';
import { useBottomSheet } from './useBottomSheet';
import Legend from './Legend';
import PeriodSwitch from './PeriodSwitch';
import ProgressPanel from './ProgressPanel';
import SearchPanel from './SearchPanel';
import { DEFAULT_CENTER, DEFAULT_ZOOM, zoomForDisc } from './camera';
import { useElapsedSeconds, useSmoothProgress } from './progress';
import { useAddressSearch } from './useAddressSearch';
import { useComputedAreas, type Viewport } from './useComputedAreas';
import { useNoiseJob } from './useNoiseJob';
import {
  PERIODS,
  readLocationFromUrl,
  readPeriodFromUrl,
  usePeriodInUrl,
  writeLocationToUrl,
} from './urlState';
import {
  fetchConfig,
  fetchNoiseTiles,
  type Centre,
  type NoiseTiles,
  type Period,
  type Place,
} from './api';
import type { Reading } from './MapCanvas';
import type { PickSource } from './useNoiseJob';
import { bandFor } from './palette';
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
  /**
   * Испечённый слой, если он собран. Пока (или если) его нет — карта работает
   * ровно как раньше: клик считает, результат рисуется поверх подложки.
   */
  const [noiseTiles, setNoiseTiles] = useState<NoiseTiles | null>(null);
  /**
   * Ответ слоя на последний вопрос: сколько здесь децибел. Взаимоисключающ с
   * результатом расчёта — там, где слой отвечает, считать нечего.
   */
  const [reading, setReading] = useState<Reading | null>(null);
  /** Точка, которую надо спросить у слоя: адрес или глубокая ссылка. */
  const [probe, setProbe] = useState<Centre | null>(null);
  // Откуда пришёл вопрос — камера кадрирует адрес и ссылку иначе, чем клик.
  const probeSource = useRef<PickSource>('search');
  /**
   * Спрашиваем ли ту же точку заново после смены периода. Тогда молчание слоя
   * значит «в эту секунду нечего показать», а не «здесь никто не считал», и
   * запускать расчёт по такому поводу нельзя: человек всего лишь нажал кнопку.
   */
  const probeIsReread = useRef(false);
  /** The camera, as the map last reported it. Null until the map has drawn. */
  const [view, setView] = useState<Viewport | null>(null);

  const [period, setPeriod] = useState<Period>(() => readPeriodFromUrl() ?? 'DEN');
  usePeriodInUrl(period);

  const panelRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
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
    (lat: number, lon: number, source: PickSource = 'map') => {
      if (source === 'map') search.clear();
      // Расчёт и считывание — два разных ответа на один вопрос, и показывать
      // их разом значило бы показывать одно место дважды.
      setReading(null);
      void pick(lat, lon, source);
    },
    [pick, search.clear],
  );

  /**
   * Спросить слой про точку, до того как заказывать расчёт.
   *
   * Ответить может только карта — queryRenderedFeatures смотрит на
   * нарисованное, — поэтому вопрос уезжает вниз, а ответ приходит в
   * handleProbeAnswer. По клику этот круг не нужен: там карта спрашивает себя
   * сама, в обработчике клика.
   */
  const askLayer = useCallback((lat: number, lon: number, source: PickSource, reread = false) => {
    probeSource.current = source;
    probeIsReread.current = reread;
    setProbe({ lat, lon });
  }, []);

  const handleProbeAnswer = useCallback(
    (centre: Centre, level: number | null) => {
      setProbe(null);
      if (level === null) {
        if (probeIsReread.current) return setReading(null);
        handlePick(centre.lat, centre.lon, probeSource.current);
        return;
      }
      setReading({ ...centre, level });
      writeLocationToUrl(centre.lat, centre.lon);
    },
    [handlePick],
  );

  const handleSelect = useCallback(
    (place: Place) => {
      search.accept(place);
      // The centre moves at once, so picking an address registers immediately;
      // the zoom waits for the radius the server sends back a moment later.
      // Doing both here and then refitting would be two camera jumps in a row.
      setLocation((prev) => ({ center: [place.lon, place.lat], zoom: prev.zoom }));
      askLayer(place.lat, place.lon, 'search');
    },
    [askLayer, search.accept],
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

  // Есть ли испечённый слой. Ответ «нет» — рабочий: тогда всё ведёт себя как до
  // его появления, поэтому запрос молчаливый.
  useEffect(() => {
    let dropped = false;
    void fetchNoiseTiles().then((meta) => {
      if (!dropped) setNoiseTiles(meta);
    });
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
    if (mapModule && deepLink) askLayer(deepLink.lat, deepLink.lon, 'link');
  }, [mapModule, deepLink, askLayer]);

  // Уровень зависит от периода, а показанное считывание — нет: после
  // переключения подпись говорила бы про ночь, а число осталось бы от Lden.
  // Спрашиваем ту же точку заново; probe сам дождётся новых тайлов.
  const readingRef = useRef(reading);
  readingRef.current = reading;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-asking on the period is the point
  useEffect(() => {
    const shown = readingRef.current;
    if (shown) askLayer(shown.lat, shown.lon, 'map', true);
  }, [period, askLayer]);

  // On a phone the panel is a sheet with three heights. A cache hit is
  // deliberately not a reason to raise it: it is over before it is read, and the
  // sheet would blink up and back for nothing.
  const sheet = useBottomSheet(panelRef, peekRef, handleRef, {
    raised: job.busy && !job.fromCache,
  });

  // Re-frame the result when the sheet settles at a new height. Same rule as the
  // resize above and for the same reason — the strip the panel covers has just
  // changed — and bound to the end of the animation rather than to the margin,
  // which also moves as progress and results grow the panel.
  useEffect(() => {
    const centre = job.centre;
    const panel = panelRef.current;
    if (!centre || !panel) return;
    const settled = (event: TransitionEvent) => {
      if (event.propertyName !== 'height' || event.target !== panel) return;
      setLocation((prev) => ({ center: [centre.lon, centre.lat], zoom: prev.zoom }));
    };
    panel.addEventListener('transitionend', settled);
    return () => panel.removeEventListener('transitionend', settled);
  }, [job.centre]);

  const smoothed = useSmoothProgress(job.job?.progress ?? 0, job.busy && !job.fromCache);
  const elapsed = useElapsedSeconds(job.busy && !job.fromCache, job.job?.elapsedMs);

  // The finished map wins; until it exists, the newest frame stands in for it.
  //
  // Ничего из этого не рисуется поверх испечённого слоя. Считывание означает,
  // что слой это место уже показывает; ответ из кэша — что показывает и его,
  // потому что пирамида печётся из того же кэша. Две полупрозрачные заливки
  // одного места дали бы круг темнее фона — ровно то пятно, от которого слой и
  // избавляет. Свежий расчёт рисуется: в пирамиде его ещё нет.
  const coveredByLayer = noiseTiles !== null && (reading !== null || job.fromCache);
  const shown = coveredByLayer ? null : (job.data ?? job.preview);
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
            noiseTiles={noiseTiles}
            period={period}
            running={job.busy && !job.fromCache}
            onPick={handlePick}
            onHover={setHover}
            onRead={setReading}
            probe={probe}
            onProbe={handleProbeAnswer}
            reading={reading}
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

      {/* Three regions, and on a phone the stylesheet reorders them: the handle
          and the peek stay on screen at every sheet height, the title shows only
          when the sheet is fully open, and the rest scrolls under them. On a wide
          screen none of that applies and the panel is the column it always was. */}
      <div
        className="panel"
        ref={panelRef}
        data-sheet={sheet.snap ?? undefined}
        style={sheet.height === null ? undefined : { height: `${sheet.height}px` }}
      >
        <button
          type="button"
          className="sheet-handle"
          ref={handleRef}
          aria-label={sheet.snap === 'collapsed' ? 'Развернуть панель' : 'Свернуть панель'}
          aria-expanded={sheet.snap === null ? undefined : sheet.snap !== 'collapsed'}
          {...sheet.handleProps}
        />

        <div className="sheet-title">
          <h1>Карта шума</h1>
          <p className="lead">
            Найдите адрес или кликните по карте — рассчитаем уровень шума от автотранспорта в
            радиусе 750 м по методу CNOSSOS-EU.
          </p>
        </div>

        <div className="sheet-peek" ref={peekRef}>
          <SearchPanel
            query={search.query}
            onQueryChange={search.setQuery}
            onSubmit={search.submit}
            searching={search.searching}
            error={search.error}
            places={search.places}
            onSelect={handleSelect}
          />

          {/* Слой сам по себе карта: пока он есть, период переключается всегда,
              а не только когда на экране лежит результат расчёта. */}
          <PeriodSwitch period={period} onChange={setPeriod} disabled={!shown && !noiseTiles} />
        </div>

        <div className="sheet-rest">
          {reading && (
            <p className="reading">
              Здесь <strong>{bandFor(reading.level)?.label ?? '—'} дБ</strong>, период{' '}
              {PERIODS.find((p) => p.id === period)?.label}. Значение взято с готовой карты —
              считать ничего не пришлось.
            </p>
          )}

          {noiseTiles && !reading && job.data && job.fromCache && !job.busy && (
            <p className="note">
              В этой самой точке уровня нет: приёмники не ставятся внутри зданий, и расчётная сетка
              оставляет разрывы. Вокруг карта закрашена — кликните рядом.
            </p>
          )}

          {noiseTiles && !reading && !job.busy && !job.data && (
            <p className="note">
              Шум показан прямо на карте, где он уже посчитан. Кликните по любому такому месту,
              чтобы узнать уровень; клик за краем закрашенного запустит расчёт.
            </p>
          )}

          {!noiseTiles && areas.length > 0 && !job.busy && !job.data && (
            <p className="note">
              Затенённые области уже посчитаны — они открываются сразу, без ожидания.
            </p>
          )}

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
              Если эту же точку ждал кто-то ещё, счёт продолжается — тогда результат всё равно
              попадёт в кэш.
            </p>
          )}

          {job.data && !job.busy && !coveredByLayer && (
            <p className="note">
              {job.fromCache ? 'Взято из кэша.' : 'Рассчитано.'} Показан период{' '}
              {PERIODS.find((p) => p.id === period)?.label}, {visible.length} контуров.
            </p>
          )}

          {/* Обе подписи ниже объясняют показанный круг. Когда его не показывают —
              место рисует слой — объяснять нечего. */}
          {job.covering && job.data && !job.busy && !coveredByLayer && (
            <p className="note">
              Готовый расчёт соседнего места — ваша точка внутри него, поэтому карта открылась
              сразу. Центр отмечен на карте: он в стороне от клика, но у края круга расчёт такой же
              полный, как в середине.
            </p>
          )}

          <Legend hasMap={shown !== null || noiseTiles !== null} presentLevels={presentLevels} />

          <p className="disclaimer">
            Расчётная оценка по типовым значениям трафика, а не результат измерений. Данные{' '}
            <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>, расчёт —{' '}
            <a href="https://github.com/Universite-Gustave-Eiffel/NoiseModelling">NoiseModelling</a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
