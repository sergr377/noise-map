import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type * as Ymaps from './ymaps';
import MapCanvas from './MapCanvas';
import { usePanelMargin } from './usePanelMargin';
import type { LngLatBounds, Margin } from '@yandex/ymaps3-types';
import { BANDS } from './palette';
import {
  cancelJob,
  fetchConfig,
  fetchAreas,
  fetchPartial,
  fetchPreview,
  fetchResult,
  followJob,
  geocode,
  JobCancelled,
  requestNoise,
  type Centre,
  type ComputedArea,
  type IsophoneCollection,
  type JobState,
  type Period,
  type Place,
} from './api';

const DEFAULT_CENTER: [number, number] = [37.6173, 55.7558];

/** Opening view, before anything has been computed: the city, not a disc. */
const DEFAULT_ZOOM = 14.4;

/** Web Mercator ground resolution at the equator, metres per pixel at zoom 0. */
/**
 * Below this zoom the computed areas are neither drawn nor asked for. A 750-metre
 * disc is about two pixels here, so the shading would be dust — and the request
 * would cover half a country to produce it.
 */
const MIN_AREA_ZOOM = 11;

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
function zoomForDisc(radiusMetres: number, lat: number, margin: Margin): number {
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

/**
 * A result is worth linking to, so the picked point lives in the URL. It also
 * makes the app reproducible from the outside — screenshots and bug reports can
 * name an exact location instead of "click roughly here".
 */
function readLocationFromUrl(): { lat: number; lon: number } | null {
  const params = new URLSearchParams(window.location.search);
  const rawLat = params.get('lat');
  const rawLon = params.get('lon');
  // Presence has to be checked before conversion: Number(null) and Number('')
  // are both 0, which is a real coordinate — the Gulf of Guinea — so a plain
  // URL would silently deep-link into the ocean.
  if (!rawLat || !rawLon) return null;

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Period boundaries are CNOSSOS-EU's, matching the LV_D / LV_E / LV_N traffic
// columns that Import_OSM fills in.
const PERIODS: Array<{ id: Period; label: string; hint: string }> = [
  { id: 'D', label: 'День', hint: '6–18' },
  { id: 'E', label: 'Вечер', hint: '18–22' },
  { id: 'N', label: 'Ночь', hint: '22–6' },
  { id: 'DEN', label: 'Lden', hint: 'сводный' },
];

/**
 * Period from the link. Sharing night noise and having the recipient open Lden
 * makes the link say something other than what was shown.
 */
function readPeriodFromUrl(): Period | null {
  const raw = new URLSearchParams(window.location.search).get('period');
  return PERIODS.some((p) => p.id === raw) ? (raw as Period) : null;
}

/** How far the bar may drift past the last confirmed value, and how fast. */
const DRIFT_LIMIT = 0.05;
const DRIFT_PER_SECOND = 0.004;

/**
 * How long the calculation has been running, in seconds.
 *
 * Counted locally because the server's own figure only arrives with an event,
 * and those are tens of seconds apart — a readout frozen between them looks
 * like a hang. But the local clock alone measures *our* wait, not the job's
 * age: joining a calculation someone else started, or simply reloading the
 * page, would restart it from zero and under-report by minutes. So every
 * reported figure re-anchors the count, and the ticking fills the silences —
 * including the long silence of a job sitting in the queue, where the server
 * has nothing new to say.
 */
function useElapsedSeconds(running: boolean, reported?: number): number {
  const [seconds, setSeconds] = useState(0);
  // Where the count is measured from, in local time. A reported elapsed of 90 s
  // means the job began 90 s before that report reached us.
  const originRef = useRef(Date.now());

  useEffect(() => {
    if (!running) originRef.current = Date.now();
  }, [running]);

  useEffect(() => {
    if (reported !== undefined) originRef.current = Date.now() - reported;
  }, [reported]);

  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - originRef.current) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, reported]);

  return seconds;
}

/**
 * The pipeline reports progress only about eight times across the ~80 s
 * propagation step, so the raw value arrives in large jumps with long silences
 * between them. Easing alone made the bar sprint and then freeze, which reads as
 * a hang.
 *
 * So the bar eases towards the reported value and then keeps creeping very
 * slowly, capped a few percent past it. The motion says "still working" without
 * claiming progress that has not been reported: the drift can never reach the
 * next milestone on its own, and a real report always overtakes it.
 */
function useSmoothProgress(target: number, active: boolean): number {
  const [shown, setShown] = useState(0);
  const ceilingRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setShown(0);
      ceilingRef.current = 0;
      return;
    }

    const tick = 80;
    const timer = setInterval(() => {
      // The ceiling walks forward with time but never more than DRIFT_LIMIT
      // beyond what the server actually confirmed.
      ceilingRef.current = Math.min(
        target + DRIFT_LIMIT,
        Math.max(target, ceilingRef.current + (DRIFT_PER_SECOND * tick) / 1000),
      );
      setShown((prev) => {
        const goal = ceilingRef.current;
        return Math.abs(goal - prev) < 0.001 ? goal : prev + (goal - prev) * 0.12;
      });
    }, tick);
    return () => clearInterval(timer);
  }, [target, active]);

  return active ? shown : target;
}

export default function App() {
  // The map module is loaded lazily so that a rejected API key degrades to a
  // readable message instead of an empty page — the bootstrap throws, and a
  // throw during module evaluation would take the whole app down with it.
  const [maps, setMaps] = useState<typeof Ymaps | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  /**
   * Radius a click covers. Asked of the server rather than kept as a constant
   * here: it is a calculation parameter, and a second copy would eventually
   * describe a circle the results do not match.
   */
  const [radius, setRadius] = useState<number | null>(null);
  /** Where the cursor is over the map, for the ring that previews a click. */
  const [hover, setHover] = useState<Centre | null>(null);
  /** Computed places in view, shaded on the map. */
  const [areas, setAreas] = useState<ComputedArea[]>([]);
  /** The camera, as the map last reported it. Null until the map has drawn. */
  const [view, setView] = useState<{ bounds: LngLatBounds; zoom: number } | null>(null);
  // Box the shaded areas were last fetched for, grown beyond the viewport so
  // that ordinary panning does not send a request per frame.
  const askedFor = useRef<{ minLon: number; minLat: number; maxLon: number; maxLat: number } | null>(
    null,
  );

  const [period, setPeriod] = useState<Period>(() => readPeriodFromUrl() ?? 'DEN');
  const [data, setData] = useState<IsophoneCollection | null>(null);
  /**
   * The map shown while the calculation runs. Rendered exactly like the final
   * one — the pipeline exports both in the same shape — and dropped the moment
   * the real result lands.
   */
  const [preview, setPreview] = useState<IsophoneCollection | null>(null);
  /**
   * Which of the two it is: the rough map of the whole area, or an exact frame
   * covering part of it. They read very differently, so the note under the
   * progress bar has to say which one is on screen.
   */
  const [previewKind, setPreviewKind] = useState<'rough' | 'frame' | null>(null);
  const [centre, setCentre] = useState<Centre | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const margin = usePanelMargin(panelRef);
  // Read inside handlePick, which is created once and must not be rebuilt every
  // time the panel changes height.
  const marginRef = useRef(margin);
  marginRef.current = margin;

  // Identifies the latest pick so a superseded one cannot write stale state.
  const pickToken = useRef(0);
  // Read inside the handler, which must not be recreated on every busy change.
  const busyRef = useRef(false);
  const [superseded, setSuperseded] = useState(false);
  // The job the cancel button acts on; null until the server has accepted one.
  const [runningId, setRunningId] = useState<string | null>(null);
  // Highest frame already fetched, so a repeated report does not refetch it.
  const shownFrame = useRef(0);
  // The rough map arrives once; this keeps a repeated report from refetching it.
  const shownRough = useRef(false);
  const [cancelled, setCancelled] = useState(false);

  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Read once: later picks rewrite the URL, and re-reading it would loop.
  const [deepLink] = useState(readLocationFromUrl);
  const [location, setLocation] = useState(() => ({
    center: deepLink ? ([deepLink.lon, deepLink.lat] as [number, number]) : DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
  }));

  useEffect(() => {
    let cancelled = false;
    import('./ymaps')
      .then((module) => {
        if (!cancelled) setMaps(module);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMapError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // A bare visit keeps its bare URL: the parameter appears once there is a point
  // to look at, or once the period stops being the default one.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lat') && period === 'DEN') return;
    url.searchParams.set('period', period);
    window.history.replaceState(null, '', url);
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    // A failure here costs the preview ring and nothing else, so it stays
    // quiet: the map, the search and the calculation all work without it.
    void fetchConfig()
      .then((config) => {
        if (!cancelled) setRadius(config.radius);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Keeps the shaded areas in step with the viewport.
   *
   * Asking about the place under the cursor could only ever answer for the place
   * under the cursor — someone had to find a computed area by sweeping the mouse
   * across the map to learn it was there. This asks about everything in view
   * instead, once the camera has stopped.
   *
   * Two things keep the traffic down: the box asked for is half a screen wider
   * than the screen, so panning inside it costs nothing, and below MIN_AREA_ZOOM
   * nothing is asked at all — a 750-metre disc is a couple of pixels there, and
   * a country-wide view would drag the whole cache across the wire to draw dust.
   */
  useEffect(() => {
    if (!view) return;
    if (view.zoom < MIN_AREA_ZOOM) {
      askedFor.current = null;
      setAreas([]);
      return;
    }

    const [[left, top], [right, bottom]] = view.bounds;
    const inside =
      askedFor.current &&
      left >= askedFor.current.minLon &&
      right <= askedFor.current.maxLon &&
      bottom >= askedFor.current.minLat &&
      top <= askedFor.current.maxLat;
    if (inside) return;

    const padLon = (right - left) / 2;
    const padLat = (top - bottom) / 2;
    const box = {
      minLon: left - padLon,
      maxLon: right + padLon,
      minLat: bottom - padLat,
      maxLat: top + padLat,
    };

    let dropped = false;
    const timer = setTimeout(() => {
      void fetchAreas(box)
        .then((found) => {
          if (dropped) return;
          askedFor.current = box;
          setAreas(found);
        })
        .catch(() => {
          /* без подсветки карта работает как раньше */
        });
    }, 300);
    return () => {
      dropped = true;
      clearTimeout(timer);
    };
  }, [view]);

  const smoothed = useSmoothProgress(job?.progress ?? 0, busy && !fromCache);
  const elapsed = useElapsedSeconds(busy && !fromCache, job?.elapsedMs);

  const handlePick = useCallback(
    async (lat: number, lon: number, source: 'map' | 'search' | 'link' = 'map') => {
      // Picking a new point while one is running is legitimate, but the old
      // request must not be able to write its result over the new one when it
      // eventually lands. Everything below is guarded by this token.
      const token = ++pickToken.current;
      const isCurrent = () => pickToken.current === token;

      const url = new URL(window.location.href);
      url.searchParams.set('lat', lat.toFixed(5));
      url.searchParams.set('lon', lon.toFixed(5));
      window.history.replaceState(null, '', url);

      // A map click means the address in the box no longer describes what is
      // shown, so it goes away rather than sitting there contradicting the map.
      if (source === 'map') {
        setQuery('');
        setPlaces(null);
        setSearchError(null);
      }

      // Nothing is actually lost when a running calculation is replaced: the
      // server finishes it anyway and files it in the cache. Say so, instead of
      // letting the previous result vanish without explanation.
      setSuperseded(busyRef.current);

      setBusy(true);
      setError(null);
      setData(null);
      setPreview(null);
      setPreviewKind(null);
      setJob(null);
      setCancelled(false);
      setRunningId(null);
      shownFrame.current = 0;
      shownRough.current = false;
      try {
        const created = await requestNoise(lat, lon);
        if (!isCurrent()) return;
        setCentre(created.centre);
        setFromCache(created.cached);
        // A deep link or an address search moves the camera anyway, so framing
        // the disc that is about to appear is part of that same move. A map
        // click is deliberately left alone: the user chose that view, and
        // pulling it from under them is worse than a result they have to
        // zoom out to take in.
        if (source !== 'map') {
          setLocation({
            center: [created.centre.lon, created.centre.lat],
            zoom: zoomForDisc(created.radius, created.centre.lat, marginRef.current),
          });
        }
        if (!created.cached) {
          setRunningId(created.id);
          await followJob(created.id, (state) => {
            if (!isCurrent()) return;
            setJob(state);

            // The rough map of the whole area, minutes before the exact one.
            // Fetched alongside the stream rather than blocking it: it is a
            // convenience, and a slow or failed one must not disturb the
            // calculation being followed.
            if (state.preview && !shownRough.current) {
              shownRough.current = true;
              void fetchPreview(created.id)
                .then((collection) => {
                  if (!isCurrent()) return;
                  setPreview(collection);
                  setPreviewKind('rough');
                })
                .catch(() => {
                  /* предпросмотр не пришёл — расчёт от этого не страдает */
                });
            }

            // A new frame means the exact map has grown. It covers part of the
            // area, so it must never replace the rough map, which covers all of
            // it: on screen that would look like the map falling apart.
            const frame = state.partials ?? 0;
            if (frame > shownFrame.current && !shownRough.current) {
              shownFrame.current = frame;
              void fetchPartial(created.id, frame)
                .then((collection) => {
                  if (!isCurrent()) return;
                  setPreview(collection);
                  setPreviewKind('frame');
                })
                .catch(() => {
                  /* кадр не пришёл — расчёт от этого не страдает */
                });
            }
          });
        }
        if (!isCurrent()) return;
        const result = await fetchResult(created.id);
        if (!isCurrent()) return;
        setData(result);
        setPreview(null);
        setPreviewKind(null);
        // The place just computed is now one of the shaded ones, and the map is
        // standing still — nothing else would ask again until it moves.
        askedFor.current = null;
        setView((current) => (current ? { ...current } : current));
      } catch (err) {
        // Cancelling is not a failure, and the local handler has already said so.
        if (isCurrent() && !(err instanceof JobCancelled)) setError((err as Error).message);
      } finally {
        if (isCurrent()) {
          setBusy(false);
          setRunningId(null);
        }
      }
    },
    [],
  );

  /**
   * Gives up on the running calculation. The server stops it only when nobody
   * else is waiting for the same place, so this is "I am no longer waiting"
   * rather than "kill it" — either way the wait here is over immediately, and
   * the button must not sit disabled while a DELETE travels.
   */
  const handleCancel = useCallback(() => {
    if (!runningId) return;
    pickToken.current += 1;
    setBusy(false);
    setJob(null);
    setSuperseded(false);
    setCancelled(true);
    setRunningId(null);
    // A failed cancel changes nothing the user can act on: the calculation
    // simply finishes and lands in the cache, as it did before there was a
    // cancel button at all.
    void cancelJob(runningId).catch(() => {});
  }, [runningId]);

  const handleSearch = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length < 3) return;
      setSearching(true);
      setSearchError(null);
      setPlaces(null);
      try {
        setPlaces(await geocode(trimmed));
      } catch (err) {
        setSearchError((err as Error).message);
      } finally {
        setSearching(false);
      }
    },
    [query],
  );

  const handleSelect = useCallback(
    (place: Place) => {
      setPlaces(null);
      setQuery(place.name);
      // The centre moves at once, so picking an address registers immediately;
      // the zoom waits for the radius the server sends back a moment later.
      // Doing both here and then refitting would be two camera jumps in a row.
      setLocation((prev) => ({ center: [place.lon, place.lat], zoom: prev.zoom }));
      void handlePick(place.lat, place.lon, 'search');
    },
    [handlePick],
  );

  // Re-centre on the computed point when the window is resized. The map applies
  // the panel margin when a location is set, not when the margin itself changes,
  // so rotating a phone or flipping the layout breakpoint would otherwise leave
  // the result off-screen. Deliberately bound to resize rather than to the
  // margin value: the panel also grows and shrinks as progress and results
  // appear, and yanking the camera on every such change would be worse.
  useEffect(() => {
    if (!centre) return;
    const recentre = () =>
      setLocation((prev) => ({ center: [centre.lon, centre.lat], zoom: prev.zoom }));
    window.addEventListener('resize', recentre);
    return () => window.removeEventListener('resize', recentre);
  }, [centre]);

  // Kick off the deep-linked calculation once the map module is in place, so the
  // marker and isophones land on a map that already exists.
  useEffect(() => {
    if (maps && deepLink) {
      void handlePick(deepLink.lat, deepLink.lon, 'link');
    }
  }, [maps, deepLink, handlePick]);

  // The finished map wins; until it exists, the newest frame stands in for it.
  const shown = data ?? preview;
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
      {maps ? (
        <MapCanvas
          maps={maps}
          location={location}
          margin={margin}
          features={visible}
          centre={centre}
          radius={radius}
          hover={hover}
          areas={areas}
          running={busy && !fromCache}
          onPick={handlePick}
          onHover={setHover}
          onViewport={setView}
        />
      ) : (
        <div className="map-placeholder">
          {mapError ? (
            <div className="map-error">
              <strong>Карта не загрузилась</strong>
              <p>{mapError}</p>
              <p className="note">
                Яндекс отвечает <code>Invalid api key</code> в двух разных случаях, не различая
                их: к ключу не подключён JavaScript API, либо для него не заданы обязательные
                ограничения по HTTP Referer или IP — без них ключ JS API 3.0 не работает.
                Проверьте оба пункта в кабинете разработчика; для локальной разработки в поле
                Referer добавляется <code>localhost</code>, без протокола и порта.
              </p>
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
          Найдите адрес или кликните по карте — рассчитаем уровень шума от автотранспорта
          в радиусе 750 м по методу CNOSSOS-EU.
        </p>

        <form className="search" onSubmit={handleSearch}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Москва, Тверская улица, 12"
            aria-label="Адрес"
          />
          <button type="submit" disabled={searching || query.trim().length < 3}>
            {searching ? '…' : 'Найти'}
          </button>
        </form>

        {areas.length > 0 && !busy && !data && (
          <p className="note">
            Затенённые области уже посчитаны — они открываются сразу, без ожидания.
          </p>
        )}

        {searchError && <p className="error">Поиск не сработал: {searchError}</p>}

        {places?.length === 0 && <p className="note">Ничего не нашлось. Уточните адрес.</p>}

        {places && places.length > 0 && (
          <ul className="results">
            {places.map((place) => (
              <li key={`${place.lat},${place.lon}`}>
                {/* The visible text lives in two spans, which leaves the button
                    itself without an accessible name — screen readers would
                    announce a row of anonymous buttons. */}
                <button
                  type="button"
                  aria-label={
                    place.description ? `${place.name}, ${place.description}` : place.name
                  }
                  onClick={() => handleSelect(place)}
                >
                  <span className="result-name">{place.name}</span>
                  <span className="result-description">{place.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="periods" role="group" aria-label="Период суток">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === period ? 'active' : ''}
              onClick={() => setPeriod(p.id)}
              disabled={!shown}
            >
              {p.label}
              <span>{p.hint}</span>
            </button>
          ))}
        </div>

        {busy && (
          <div className="progress" role="status">
            <div className="bar">
              <div className="fill" style={{ width: `${Math.round(smoothed * 100)}%` }} />
            </div>
            <div className="progress-text">
              <span>{job?.label ?? 'Отправляю запрос'}</span>
              <span>
                {elapsed} с
                {!fromCache && (
                  <button
                    type="button"
                    className="cancel"
                    onClick={handleCancel}
                    disabled={!runningId}
                  >
                    Отменить
                  </button>
                )}
              </span>
            </div>
            {preview && previewKind === 'rough' && (
              <p className="note">
                Показана предварительная оценка: она учитывает только дороги
                ближе 75 м, поэтому уровни занижены на 2–3 дБ, а пятая часть
                площади попадёт в соседнюю полосу — во дворах сейчас тише, чем
                будет на точной карте. Точный расчёт заменит её целиком, не
                сдвигая контуров.
              </p>
            )}
            {preview && previewKind === 'frame' && (
              <p className="note">
                Показана карта на текущий момент расчёта: чем дальше, тем больше
                закрашено. Итоговая заменит её целиком.
              </p>
            )}
            {superseded && (
              <p className="note">
                Предыдущий расчёт продолжается на сервере и попадёт в кэш — вернётесь к
                той точке, откроется сразу.
              </p>
            )}
            <p className="note">
              Первый расчёт для нового места занимает 6–27 минут: в плотной застройке
              дольше, на окраинах быстрее. Повторный клик рядом отдаётся из кэша мгновенно.
            </p>
          </div>
        )}

        {error && <p className="error">Не получилось: {error}</p>}

        {cancelled && !busy && (
          <p className="note">
            Расчёт отменён
            {previewKind === 'rough' ? '; на карте осталась предварительная оценка' : ''}
            {previewKind === 'frame' ? '; на карте осталось то, что успело посчитаться' : ''}.
            Если эту же точку ждал кто-то ещё, счёт продолжается — тогда результат
            всё равно попадёт в кэш.
          </p>
        )}

        {data && !busy && (
          <p className="note">
            {fromCache ? 'Взято из кэша.' : 'Рассчитано.'} Показан период{' '}
            {PERIODS.find((p) => p.id === period)?.label}, {visible.length} контуров.
          </p>
        )}

        <div className="legend">
          <h2>Уровень, дБ(A)</h2>
          {/* Bands missing from a result are dimmed, but only once a result
              exists — before the first calculation nothing is "absent", and
              dimming the whole scale then just makes the legend look broken. */}
          <ul>
            {[...BANDS].reverse().map((band) => (
              <li
                key={band.level}
                className={!shown || presentLevels.has(band.level) ? '' : 'absent'}
              >
                <span className="swatch" style={{ background: band.color }} aria-hidden="true" />
                <span className="range">{band.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="disclaimer">
          Расчётная оценка по типовым значениям трафика, а не результат измерений. Данные{' '}
          <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>, расчёт —{' '}
          <a href="https://github.com/Universite-Gustave-Eiffel/NoiseModelling">NoiseModelling</a>.
        </p>
      </div>
    </div>
  );
}
