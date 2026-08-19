import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type * as Ymaps from './ymaps';
import MapCanvas from './MapCanvas';
import { usePanelMargin } from './usePanelMargin';
import { BANDS } from './palette';
import {
  fetchResult,
  followJob,
  geocode,
  requestNoise,
  type Centre,
  type IsophoneCollection,
  type JobState,
  type Period,
  type Place,
} from './api';

const DEFAULT_CENTER: [number, number] = [37.6173, 55.7558];

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

/** How far the bar may drift past the last confirmed value, and how fast. */
const DRIFT_LIMIT = 0.05;
const DRIFT_PER_SECOND = 0.004;

/**
 * Seconds since the calculation started, counted locally.
 *
 * The server's own elapsed figure only arrives with a progress event, and those
 * are tens of seconds apart — so the readout used to sit frozen on the same
 * number while the bar was also capped, and the whole thing looked hung. A
 * counter that keeps ticking is what tells the user the job is alive.
 */
function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

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

  const [period, setPeriod] = useState<Period>('DEN');
  const [data, setData] = useState<IsophoneCollection | null>(null);
  const [centre, setCentre] = useState<Centre | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const margin = usePanelMargin(panelRef);

  // Identifies the latest pick so a superseded one cannot write stale state.
  const pickToken = useRef(0);
  // Read inside the handler, which must not be recreated on every busy change.
  const busyRef = useRef(false);
  const [superseded, setSuperseded] = useState(false);

  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Read once: later picks rewrite the URL, and re-reading it would loop.
  const [deepLink] = useState(readLocationFromUrl);
  const [location, setLocation] = useState(() => ({
    center: deepLink ? ([deepLink.lon, deepLink.lat] as [number, number]) : DEFAULT_CENTER,
    zoom: 15,
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

  const smoothed = useSmoothProgress(job?.progress ?? 0, busy && !fromCache);
  const elapsed = useElapsedSeconds(busy && !fromCache);

  const handlePick = useCallback(
    async (lat: number, lon: number, source: 'map' | 'search' = 'map') => {
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
      setJob(null);
      try {
        const created = await requestNoise(lat, lon);
        if (!isCurrent()) return;
        setCentre(created.centre);
        setFromCache(created.cached);
        if (!created.cached) {
          await followJob(created.id, (state) => {
            if (isCurrent()) setJob(state);
          });
        }
        if (!isCurrent()) return;
        const result = await fetchResult(created.id);
        if (!isCurrent()) return;
        setData(result);
      } catch (err) {
        if (isCurrent()) setError((err as Error).message);
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [],
  );

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
      setLocation({ center: [place.lon, place.lat], zoom: 16 });
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
      void handlePick(deepLink.lat, deepLink.lon);
    }
  }, [maps, deepLink, handlePick]);

  const visible = useMemo(
    () => (data?.features ?? []).filter((f) => f.properties.PERIOD === period),
    [data, period],
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
          onPick={handlePick}
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
          в радиусе 500 м по методу CNOSSOS-EU.
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
              disabled={!data}
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
              <span>{elapsed} с</span>
            </div>
            {superseded && (
              <p className="note">
                Предыдущий расчёт продолжается на сервере и попадёт в кэш — вернётесь к
                той точке, откроется сразу.
              </p>
            )}
            <p className="note">
              Первый расчёт для нового места занимает 3–10 минут: в плотной застройке
              дольше, на окраинах быстрее. Повторный клик рядом отдаётся из кэша мгновенно.
            </p>
          </div>
        )}

        {error && <p className="error">Не получилось: {error}</p>}

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
                className={!data || presentLevels.has(band.level) ? '' : 'absent'}
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
