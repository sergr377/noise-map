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

/**
 * The pipeline reports progress only about eight times across the ~80 s
 * propagation step, so the raw value arrives in visible jumps. Easing towards it
 * keeps the bar moving without inventing progress that has not happened.
 */
function useSmoothProgress(target: number, active: boolean): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!active) {
      setShown(0);
      return;
    }
    const timer = setInterval(() => {
      setShown((prev) => (Math.abs(target - prev) < 0.002 ? target : prev + (target - prev) * 0.12));
    }, 80);
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

  const smoothed = useSmoothProgress(job?.progress ?? 0, busy && !fromCache);

  const handlePick = useCallback(async (lat: number, lon: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', lat.toFixed(5));
    url.searchParams.set('lon', lon.toFixed(5));
    window.history.replaceState(null, '', url);

    setBusy(true);
    setError(null);
    setData(null);
    setJob(null);
    try {
      const created = await requestNoise(lat, lon);
      setCentre(created.centre);
      setFromCache(created.cached);
      if (!created.cached) {
        await followJob(created.id, setJob);
      }
      setData(await fetchResult(created.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

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
      void handlePick(place.lat, place.lon);
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
                <button type="button" onClick={() => handleSelect(place)}>
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
              <span>{job ? `${Math.round(job.elapsedMs / 1000)} с` : ''}</span>
            </div>
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
