import { useCallback, useRef, useState } from 'react';
import {
  cancelJob,
  fetchPartial,
  fetchPreview,
  fetchResult,
  followJob,
  JobCancelled,
  requestNoise,
  type Centre,
  type IsophoneCollection,
  type JobState,
} from './api';
import { writeLocationToUrl } from './urlState';

/** Where a pick came from. The camera treats a map click differently. */
export type PickSource = 'map' | 'search' | 'link';

/** What the rough map on screen is, when there is one. */
export type PreviewKind = 'rough' | 'frame';

export interface NoiseJobHandlers {
  /**
   * The server has said where the disc actually is. A deep link or an address
   * search should frame it; a map click should be left alone.
   */
  onCentre?: (centre: Centre, radius: number, source: PickSource) => void;
  /** A finished result landed — the shaded areas on the map are now stale. */
  onResult?: () => void;
}

/**
 * The whole life of one calculation: asking for it, following it, showing what
 * arrives on the way, and giving up on it.
 *
 * The one rule that shapes everything here is that a pick can be superseded.
 * Clicking a new point while another calculation runs is legitimate and common
 * — the old request must simply never be able to write its result over the new
 * one when it finally lands, minutes later. Hence the token: every write is
 * guarded by it, and a superseded run falls silent instead of being cancelled.
 */
export function useNoiseJob(handlers: NoiseJobHandlers = {}) {
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
  const [previewKind, setPreviewKind] = useState<PreviewKind | null>(null);
  const [centre, setCentre] = useState<Centre | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  /** Whether the shown result is a neighbour's disc that covers the click. */
  const [covering, setCovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  /** The job the cancel button acts on; null until the server has accepted one. */
  const [runningId, setRunningId] = useState<string | null>(null);

  // Handlers are read through a ref so that `pick` can be created once. It is
  // handed to the map, and rebuilding it on every render would remount nothing
  // useful and invite stale-closure bugs of exactly the kind the token guards
  // against elsewhere.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Identifies the latest pick so a superseded one cannot write stale state.
  const pickToken = useRef(0);
  // Read inside the handler, which must not be recreated on every busy change.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Highest frame already fetched, so a repeated report does not refetch it.
  const shownFrame = useRef(0);
  // The rough map arrives once; this keeps a repeated report from refetching it.
  const shownRough = useRef(false);

  const pick = useCallback(async (lat: number, lon: number, source: PickSource = 'map') => {
    const token = ++pickToken.current;
    const isCurrent = () => pickToken.current === token;

    writeLocationToUrl(lat, lon);

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
      setCovering(created.covering === true);
      handlersRef.current.onCentre?.(created.centre, created.radius, source);

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
      handlersRef.current.onResult?.();
    } catch (err) {
      // Cancelling is not a failure, and the local handler has already said so.
      if (isCurrent() && !(err instanceof JobCancelled)) setError((err as Error).message);
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setRunningId(null);
      }
    }
  }, []);

  /**
   * Gives up on the running calculation. The server stops it only when nobody
   * else is waiting for the same place, so this is "I am no longer waiting"
   * rather than "kill it" — either way the wait here is over immediately, and
   * the button must not sit disabled while a DELETE travels.
   */
  const cancel = useCallback(() => {
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

  return {
    pick,
    cancel,
    data,
    preview,
    previewKind,
    centre,
    job,
    busy,
    fromCache,
    covering,
    error,
    superseded,
    cancelled,
    runningId,
  };
}
