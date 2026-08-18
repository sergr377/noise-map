import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Ymaps from './ymaps';
import MapCanvas from './MapCanvas';
import { BANDS } from './palette';
import {
  fetchResult,
  followJob,
  requestNoise,
  type Centre,
  type IsophoneCollection,
  type JobState,
  type Period,
} from './api';

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

  const visible = useMemo(
    () => (data?.features ?? []).filter((f) => f.properties.PERIOD === period),
    [data, period],
  );

  const presentLevels = useMemo(() => new Set(visible.map((f) => f.properties.ISOLVL)), [visible]);

  return (
    <div className="app">
      {maps ? (
        <MapCanvas maps={maps} features={visible} centre={centre} onPick={handlePick} />
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

      <div className="panel">
        <h1>Карта шума</h1>
        <p className="lead">
          Кликните по карте — рассчитаем уровень шума от автотранспорта в радиусе 500 м по
          методу CNOSSOS-EU.
        </p>

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
              Первый расчёт для нового места занимает 2–5 минут: в плотной застройке дольше,
              на окраинах быстрее. Повторный клик рядом отдаётся из кэша мгновенно.
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
