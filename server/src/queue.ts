import { spawn } from 'node:child_process';
import {
  JOB_PARAMS,
  MAX_CONCURRENT_JOBS,
  RUN_JOB_SCRIPT,
  ROOT,
  STAGE_LABELS,
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
  propagation: [0.18, 0.92],
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

function runPipeline(job: Job): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      RUN_JOB_SCRIPT,
      '--lat',
      String(job.lat),
      '--lon',
      String(job.lon),
      ...Object.entries(JOB_PARAMS).flatMap(([k, v]) => [`--${k}`, String(v)]),
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT });

    let resultPath: string | null = null;
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
        const span = STAGE_SPAN.propagation!;
        if (totalCells && doneCells !== undefined) {
          job.progress = span[0] + (span[1] - span[0]) * (doneCells / totalCells);
          publish(job);
        }
      } else if (kind === 'RESULT') {
        resultPath = payload.trim();
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
      if (buffer) handleLine(buffer);
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
        job.error =
          code === 0
            ? 'pipeline finished without producing a result'
            : `pipeline exited with code ${code}: ${stderrTail.slice(-6).join(' | ').slice(0, 500)}`;
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
export function startJob(lat: number, lon: number): Job {
  const id = cacheKey(lat, lon);
  const existing = jobs.get(id);
  if (existing) return existing;

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
  };
  jobs.set(id, job);

  job.settled = (async () => {
    await acquireSlot();
    try {
      await runPipeline(job);
    } finally {
      releaseSlot();
      // Keep the finished job around briefly so a slow client can still read its
      // final state; the result itself lives in the cache and outlives this.
      setTimeout(() => jobs.delete(job.id), 10 * 60_000).unref();
    }
  })();

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function subscribe(job: Job, listener: Listener): () => void {
  job.listeners.add(listener);
  listener(snapshot(job));
  return () => job.listeners.delete(listener);
}

export { snapshot };
