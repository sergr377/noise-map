export type Stage =
  | 'queued'
  | 'overpass'
  | 'import'
  | 'grid'
  | 'preview'
  | 'propagation'
  | 'isosurface'
  | 'dissolve'
  | 'export'
  | 'done'
  | 'error'
  | 'cancelled';

export interface JobState {
  id: string;
  stage: Stage;
  label: string;
  progress: number;
  elapsedMs: number;
  error?: string;
  /**
   * How many intermediate maps the job has exported. The newest one is worth
   * fetching: it is the calculation as it stands right now.
   */
  partials?: number;
  /**
   * Whether the rough map of the whole area is ready. Unlike a frame it covers
   * everything from the start, and it is replaced only by the final result.
   */
  preview?: boolean;
}

export interface Centre {
  lat: number;
  lon: number;
}

export interface CreateResponse {
  id: string;
  cached: boolean;
  centre: Centre;
  /** Radius of the computed disc, metres. Comes from the server's job params. */
  radius: number;
  bytes?: number;
  /**
   * Set when the answer is a neighbouring calculation whose disc covers the
   * click rather than one centred on it. The map is valid at the clicked point
   * either way; what differs is where its centre sits.
   */
  covering?: boolean;
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

export interface ServiceConfig {
  /** Radius of the area a click covers, metres. */
  radius: number;
}

/** Settings the map needs before the first calculation. */
export async function fetchConfig(): Promise<ServiceConfig> {
  return asJson<ServiceConfig>(await fetch('/api/config'));
}

/**
 * Starts a calculation, or resolves instantly if the place is already computed.
 * Which of the two happened is in `cached`.
 */
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

/** A place that is already computed: a disc the map shades as ready. */
export interface ComputedArea {
  id: string;
  lat: number;
  lon: number;
  /** Metres. Comes with each area rather than from config: an older entry may
   *  have been computed with a different radius. */
  radius: number;
}

/**
 * Computed places reaching into the given box. Called as the viewport moves, so
 * it carries centres and radii rather than outlines — a disc is three numbers.
 */
export async function fetchAreas(bounds: {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}): Promise<ComputedArea[]> {
  const bbox = [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat]
    .map((n) => n.toFixed(5))
    .join(',');
  const { areas } = await asJson<{ areas: ComputedArea[] }>(
    await fetch(`/api/noise/areas?bbox=${bbox}`),
  );
  return areas;
}

export async function fetchResult(id: string): Promise<IsophoneCollection> {
  return asJson<IsophoneCollection>(await fetch(`/api/noise/${id}/result`));
}

/**
 * The map as it stood partway through the calculation. Same shape as the final
 * result, so it renders through exactly the same path.
 */
export async function fetchPartial(id: string, index: number): Promise<IsophoneCollection> {
  return asJson<IsophoneCollection>(await fetch(`/api/noise/${id}/partial/${index}`));
}

/**
 * The rough map of the whole area, ready minutes before the exact one. Same
 * shape again, so it renders through the same path — it differs in what it
 * says, not in how it is drawn.
 */
export async function fetchPreview(id: string): Promise<IsophoneCollection> {
  return asJson<IsophoneCollection>(await fetch(`/api/noise/${id}/preview`));
}

export interface CancelResponse {
  /** False when the calculation goes on because others are waiting for it. */
  cancelled: boolean;
  waiters: number;
}

/**
 * Says we are no longer waiting for a calculation. The server stops it once the
 * last interested client is gone — someone else who clicked the same block keeps
 * their run.
 */
export async function cancelJob(id: string): Promise<CancelResponse> {
  return asJson<CancelResponse>(await fetch(`/api/noise/${id}`, { method: 'DELETE' }));
}

/** A job that ended because it was cancelled, not because anything went wrong. */
export class JobCancelled extends Error {
  constructor() {
    super('расчёт отменён');
  }
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
      } else if (state.stage === 'cancelled') {
        source.close();
        reject(new JobCancelled());
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
