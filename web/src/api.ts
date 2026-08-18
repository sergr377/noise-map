export type Stage =
  | 'queued'
  | 'overpass'
  | 'import'
  | 'grid'
  | 'propagation'
  | 'isosurface'
  | 'dissolve'
  | 'export'
  | 'done'
  | 'error';

export interface JobState {
  id: string;
  stage: Stage;
  label: string;
  progress: number;
  elapsedMs: number;
  error?: string;
}

export interface Centre {
  lat: number;
  lon: number;
}

export interface CreateResponse {
  id: string;
  cached: boolean;
  centre: Centre;
  bytes?: number;
}

export type Period = 'D' | 'E' | 'N' | 'DEN';

export interface IsophoneProperties {
  PERIOD: Period;
  ISOLVL: number;
  ISOLABEL: string;
}

export interface IsophoneCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    // Positions are [lon, lat] pairs, which is what both GeoJSON and the map's
    // LngLat expect — keeping the tuple width exact lets the geometry be handed
    // to YMapFeature without a cast.
    geometry:
      | { type: 'Polygon'; coordinates: [number, number][][] }
      | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
    properties: IsophoneProperties;
  }>;
}

export interface Place {
  name: string;
  description: string;
  lat: number;
  lon: number;
  /** Geocoder confidence: exact | number | near | street | other. */
  precision: string;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function requestNoise(lat: number, lon: number): Promise<CreateResponse> {
  return asJson<CreateResponse>(
    await fetch('/api/noise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    }),
  );
}

/**
 * Address lookup. Proxied through our own server: the geocoder key has no
 * referer restriction, so it must never reach the browser.
 */
export async function geocode(query: string): Promise<Place[]> {
  const { places } = await asJson<{ places: Place[] }>(
    await fetch(`/api/geocode?q=${encodeURIComponent(query)}`),
  );
  return places;
}

export async function fetchResult(id: string): Promise<IsophoneCollection> {
  return asJson<IsophoneCollection>(await fetch(`/api/noise/${id}/result`));
}

/**
 * Follows a running job to completion. Resolves once the pipeline reports done,
 * rejects on a reported error or a dropped connection.
 */
export function followJob(id: string, onState: (state: JobState) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/noise/${id}/events`);

    source.onmessage = (event) => {
      const state = JSON.parse(event.data) as JobState;
      onState(state);
      if (state.stage === 'done') {
        source.close();
        resolve();
      } else if (state.stage === 'error') {
        source.close();
        reject(new Error(state.error ?? 'расчёт завершился ошибкой'));
      }
    };

    source.onerror = () => {
      // EventSource retries silently; a closed stream here means the job is gone.
      if (source.readyState === EventSource.CLOSED) {
        reject(new Error('соединение с сервером потеряно'));
      }
    };
  });
}
