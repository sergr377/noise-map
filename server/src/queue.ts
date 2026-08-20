import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import {
  JOB_PARAMS,
  KILL_GRACE_MS,
  PARTIAL_INTERVAL_MS,
  PREVIEW_SRC_DIST,
  MAX_CONCURRENT_JOBS,
  RUN_JOB_SCRIPT,
  ROOT,
  STAGE_LABELS,
  TERMINAL_STAGES,
  failureMessage,
  type Stage,
} from './config.js';
import { cacheKey, quantize, writeCache } from './cache.js';

export interface JobState {
  id: string;
  stage: Stage;
  label: string;
  /** Overall completion, 0..1. */
  progress: number;
  elapsedMs: number;
  error?: string;
  bytes?: number;
  /**
   * How many partial maps the job has exported so far. The newest one is at
   * /api/noise/:id/partial/:n — sending the geometry itself down the event
   * stream would push megabytes through a channel meant for status lines.
   */
  partials?: number;
  /**
   * Whether the rough map of the whole area is ready at /api/noise/:id/preview.
   * One map rather than a series, so this is a flag and not a counter.
   */
  preview?: boolean;
}

/**
 * Where each stage sits on the overall bar. Propagation owns most of it because
 * it owns most of the wall clock — a bar that races to 90% and then stalls for a
 * minute is worse than no bar at all.
 */
const STAGE_SPAN: Partial<Record<Stage, [number, number]>> = {
  queued: [0, 0],
  overpass: [0, 0.1],
  import: [0.1, 0.15],
  grid: [0.15, 0.18],
  preview: [0.18, 0.28],
  propagation: [0.28, 0.92],
  isosurface: [0.92, 0.96],
  dissolve: [0.96, 0.98],
  export: [0.98, 1],
  done: [1, 1],
};

type Listener = (state: JobState) => void;

interface Job {
  id: string;
  lat: number;
  lon: number;
  stage: Stage;
  progress: number;
  startedAt: number;
  error?: string;
  bytes?: number;
  listeners: Set<Listener>;
  settled: Promise<void>;
  /**
   * How many callers are still waiting for this result. Requests to a location
   * already being computed join the run instead of starting a second one, so a
   * cancellation from one of them must not stop the work for the others.
   */
  waiters: number;
  cancelled: boolean;
  /** The pipeline process, while one is running. */
  child: ChildProcess | null;
  /** Exported partial maps, oldest first. Files live in the job directory. */
  partials: string[];
  /** The rough whole-area map, once the preview pass has written it. */
  preview: string | null;
  /**
   * Whether this job computes one at all. Off for work nobody is watching —
   * prewarming pays 12–22% for a map that would be deleted unseen.
   */
  wantsPreview: boolean;
  /**
   * Whether a repeat request should start over instead of being handed this
   * failure again. True when the job died of something that has nothing to do
   * with the place — Overpass being unreachable, say.
   */
  retryable: boolean;
}

const jobs = new Map<string, Job>();
const waiting: Array<() => void> = [];
let running = 0;

function snapshot(job: Job): JobState {
  return {
    id: job.id,
    stage: job.stage,
    label: STAGE_LABELS[job.stage],
    progress: job.progress,
    elapsedMs: Date.now() - job.startedAt,
    ...(job.error ? { error: job.error } : {}),
    ...(job.bytes ? { bytes: job.bytes } : {}),
    ...(job.partials.length ? { partials: job.partials.length } : {}),
    ...(job.preview ? { preview: true } : {}),
  };
}

function publish(job: Job) {
  const state = snapshot(job);
  for (const listener of job.listeners) listener(state);
}

function setStage(job: Job, stage: Stage) {
  job.stage = stage;
  job.progress = STAGE_SPAN[stage]?.[0] ?? job.progress;
  publish(job);
}

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_JOBS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
}

function releaseSlot() {
  running -= 1;
  waiting.shift()?.();
}

/**
 * Stops the whole pipeline, not just the process we spawned.
 *
 * The chain is server → `run-job.mjs` → ScriptRunner → JVM, and the expensive
 * part is the last link: it holds every core and up to 1.8 GB. Killing only the
 * Node process in the middle would leave that running and orphaned, which is the
 * opposite of what cancelling is for.
 */
function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    // Windows has no process groups to signal; taskkill /T walks the tree, and
    // /F is needed because the JVM is not a console app that answers politely.
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }).on('error', (err) => {
      console.error(`taskkill failed for pid ${pid}:`, err.message);
    });
    return;
  }

  // The child leads its own process group (see `detached` below), so a negative
  // pid reaches the launcher script and the JVM under it as well.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, KILL_GRACE_MS).unref();
}

function runPipeline(job: Job): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      RUN_JOB_SCRIPT,
      '--lat',
      String(job.lat),
      '--lon',
      String(job.lon),
      ...Object.entries(JOB_PARAMS).flatMap(([k, v]) => [`--${k}`, String(v)]),
      // Appended separately from JOB_PARAMS: those are hashed into the cache
      // key, and how often we draw an intermediate map is not a property of the
      // result.
      '--partialIntervalMs',
      String(PARTIAL_INTERVAL_MS),
      '--previewSrcDist',
      String(job.wantsPreview ? PREVIEW_SRC_DIST : 0),
    ];
    // detached: the child becomes its own process-group leader, which is what
    // makes killTree able to signal the JVM underneath it. The price is that it
    // no longer dies with the terminal on Ctrl-C, hence stopAll() on shutdown.
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: process.platform !== 'win32',
    });
    job.child = child;

    let resultPath: string | null = null;
    // What the pipeline says about its own failure, when it knows more than the
    // exit code does — a job directory still held by an orphaned run, say.
    let pipelineError: string | null = null;
    let stderrTail: string[] = [];

    const handleLine = (line: string) => {
      const marker = line.match(/^@@(\w+) (.*)$/);
      if (!marker) {
        if (line.trim()) stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        return;
      }
      const [, kind, payload] = marker as unknown as [string, string, string];

      if (kind === 'STAGE') {
        setStage(job, payload.trim() as Stage);
      } else if (kind === 'PROGRESS') {
        const [doneCells, totalCells] = payload.trim().split(/\s+/).map(Number);
        // Both propagation passes report cells, so the span is the one of the
        // stage that is running — otherwise the preview would drive the bar
        // through the whole propagation band and then start it over.
        const span = STAGE_SPAN[job.stage] ?? STAGE_SPAN.propagation!;
        if (totalCells && doneCells !== undefined) {
          job.progress = span[0] + (span[1] - span[0]) * (doneCells / totalCells);
          publish(job);
        }
      } else if (kind === 'RESULT') {
        resultPath = payload.trim();
      } else if (kind === 'ERROR') {
        pipelineError = payload.trim();
      } else if (kind === 'PREVIEW') {
        // The whole area at once, roughly. Announced like a frame, but it
        // arrives once and is not replaced by anything except the result.
        job.preview = payload.trim();
        publish(job);
      } else if (kind === 'PARTIAL') {
        // A map of everything computed so far. Publishing here is what tells a
        // watching client that a new frame is worth fetching.
        job.partials.push(payload.trim());
        publish(job);
      }
    };

    let buffer = '';
    const consume = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    child.on('close', async (code) => {
      job.child = null;
      if (buffer) handleLine(buffer);
      // A killed pipeline exits non-zero with a truncated log. That is not a
      // failure to report — the stage was already set when the kill was issued.
      if (job.cancelled) return resolve();
      if (code === 0 && resultPath) {
        try {
          job.bytes = await writeCache(job.id, resultPath);
          job.progress = 1;
          setStage(job, 'done');
        } catch (err) {
          job.error = `cache write failed: ${(err as Error).message}`;
          setStage(job, 'error');
        }
      } else {
        // The raw tail is a Java stack trace or a failed network call — useful
        // in the log, meaningless to whoever clicked the map. What the caller
        // is told instead comes from the stage the job died in, which has to be
        // read before setStage overwrites it.
        const failedAt = job.stage;
        console.error(
          `job ${job.id} at ${job.lat},${job.lon} failed (code ${code}) on stage ` +
            `${failedAt}:\n${stderrTail.join('\n')}`,
        );
        job.error = pipelineError ?? failureMessage(failedAt);
        // A failure before any OpenStreetMap data was in hand says nothing about
        // the location, so clicking again should try again rather than replay
        // the same message for ten minutes. A failure further along is about
        // this place and would only burn minutes to reproduce. The pipeline
        // speaks up only about conditions of the machine, which likewise pass.
        job.retryable = pipelineError !== null || failedAt === 'queued' || failedAt === 'overpass';
        setStage(job, 'error');
      }
      resolve();
    });
  });
}

/**
 * Returns the job for this location, starting one only if nothing equivalent is
 * already in flight. Two users clicking the same block share a single run.
 */
export function startJob(lat: number, lon: number, wantsPreview = true): Job {
  const id = cacheKey(lat, lon);
  const existing = jobs.get(id);
  const spent = existing?.stage === 'cancelled' || (existing?.stage === 'error' && existing.retryable);
  if (existing && !spent) {
    existing.waiters += 1;
    return existing;
  }
  // A cancelled job, or one that failed for a reason unrelated to the place, is
  // a tombstone kept only so a slow client can read the final state. Joining it
  // would hand the caller a run that is not happening, or a stale complaint
  // about a network that may since have come back.
  if (existing) jobs.delete(id);

  // Compute at the cell centre, not at the raw click. The cache is keyed by cell,
  // so anything else means the map a caller gets back is centred on whoever
  // happened to click first — off by up to half a cell from their own point.
  const centre = quantize(lat, lon);

  const job: Job = {
    id,
    lat: centre.lat,
    lon: centre.lon,
    stage: 'queued',
    progress: 0,
    startedAt: Date.now(),
    listeners: new Set(),
    settled: Promise.resolve(),
    waiters: 1,
    cancelled: false,
    child: null,
    partials: [],
    preview: null,
    wantsPreview,
    retryable: false,
  };
  jobs.set(id, job);

  job.settled = (async () => {
    await acquireSlot();
    try {
      // Cancelled while queued: nothing was spawned, so there is nothing to
      // kill and the final stage is already published.
      if (!job.cancelled) await runPipeline(job);
    } finally {
      releaseSlot();
      // Keep the finished job around briefly so a slow client can still read its
      // final state; the result itself lives in the cache and outlives this.
      // The identity check matters after a cancellation: the same location may
      // already have a new job under this id, and it must not be evicted here.
      setTimeout(() => {
        if (jobs.get(job.id) === job) jobs.delete(job.id);
        removePartials(job);
      }, 10 * 60_000).unref();
    }
  })();

  return job;
}

export interface CancelOutcome {
  /** Whether the calculation was actually stopped. */
  cancelled: boolean;
  /** Callers still waiting for this result afterwards. */
  waiters: number;
  state: JobState;
}

/**
 * Withdraws one caller's interest in a job, stopping the calculation once the
 * last one is gone.
 *
 * Cancelling is deliberately "I am no longer waiting" rather than "kill this":
 * requests for the same cell share a single run, so a hard kill would let one
 * client abort a calculation someone else is still watching. The cost is that a
 * caller who leaves without cancelling — a closed tab — keeps the job alive to
 * the end, which is exactly the behaviour that existed before.
 */
export function cancelJob(id: string): CancelOutcome | null {
  const job = jobs.get(id);
  if (!job) return null;

  if (TERMINAL_STAGES.has(job.stage)) {
    return { cancelled: false, waiters: job.waiters, state: snapshot(job) };
  }

  job.waiters = Math.max(0, job.waiters - 1);
  if (job.waiters > 0) {
    return { cancelled: false, waiters: job.waiters, state: snapshot(job) };
  }

  job.cancelled = true;
  // Publish before killing: the stage is what closes the subscribers' streams,
  // and it should not depend on how long the JVM takes to die.
  setStage(job, 'cancelled');
  if (job.child) killTree(job.child);
  return { cancelled: true, waiters: 0, state: snapshot(job) };
}

/**
 * Stops every running pipeline. Spawning detached means the JVM survives its
 * parent, so an unhandled shutdown would leave it eating the machine — a
 * container restart under memory pressure is precisely when that hurts most.
 */
export function stopAll(): number {
  let stopped = 0;
  for (const job of jobs.values()) {
    if (TERMINAL_STAGES.has(job.stage)) continue;
    job.cancelled = true;
    if (job.child) {
      killTree(job.child);
      stopped += 1;
    }
  }
  return stopped;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Path of the rough whole-area map, while the job that made it is alive. */
export function previewPath(id: string): string | undefined {
  return jobs.get(id)?.preview ?? undefined;
}

/** Path of the n-th partial map (1-based), while the job that made it is alive. */
export function partialPath(id: string, index: number): string | undefined {
  return jobs.get(id)?.partials[index - 1];
}

/**
 * Frames are scratch: they live in the job directory and are only meaningful
 * while someone is watching that job. Dropping them when the job is forgotten
 * keeps a cancelled or finished run from leaving megabytes behind.
 */
function removePartials(job: Job) {
  const scratch = job.partials.splice(0);
  if (job.preview) {
    scratch.push(job.preview);
    job.preview = null;
  }
  for (const file of scratch) {
    void unlink(file).catch(() => {
      /* already gone, or never written */
    });
  }
}

export function subscribe(job: Job, listener: Listener): () => void {
  job.listeners.add(listener);
  listener(snapshot(job));
  return () => job.listeners.delete(listener);
}

export { snapshot };
