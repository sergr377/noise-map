/**
 * A pipeline that computes nothing, so the HTTP layer around it can be checked
 * by a machine.
 *
 * `smoke-api.mjs` is the only end-to-end test of the server — job creation, the
 * SSE progress stream, cancellation, the rate limiter, the cache and its
 * covering-area rule — and it could never run in CI, because the thing it drove
 * needed Java, a 148 MB engine that is not in git, live Overpass and minutes of
 * every core. None of that is what the HTTP layer is made of. So this stands in
 * for the engine: same command line as `run-job.mjs`, same `@@` marker
 * protocol, same files in the same places, and a result that is a real
 * FeatureCollection of real rings around the requested point.
 *
 * What it does NOT check is equally worth knowing: nothing here says anything
 * about acoustics, about NoiseModelling, or about whether the numbers on a real
 * map are right. `sanity-check.mjs` and `compare-runs.mjs` remain the way to
 * ask that, and they need a human reading the figures.
 *
 * Switched on with RUN_JOB_SCRIPT=scripts/fake-job.mjs. Never a default: a
 * server that quietly served invented maps would be worse than one that is
 * plainly down.
 *
 * Usage: same as run-job.mjs, plus FAKE_JOB_MS for how long to pretend.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emit = (kind, payload) => console.log(`@@${kind} ${payload}`);

/**
 * How long the whole pretend run takes. Not zero, and not a token 100 ms: the
 * smoke test starts a job, opens progress streams against it and then cancels
 * it, and every one of those steps needs the job to still be running. Six
 * seconds is comfortably longer than that sequence and short enough that a CI
 * run does not notice it.
 */
const TOTAL_MS = Number(process.env.FAKE_JOB_MS) || 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { radius: 1000, maxSrcDist: 500, previewSrcDist: 0, partialIntervalMs: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = Number(argv[i + 1]);
  }
  if (!Number.isFinite(out.lat) || !Number.isFinite(out.lon)) {
    throw new Error('--lat and --lon are required');
  }
  return out;
}

/**
 * Concentric rings around the point, labelled like the real bands.
 *
 * Shaped after the genuine output rather than filled with placeholder squares,
 * because the smoke test and the client both read it: `ISOLABEL` is what the
 * map colours by, and a ring per band is what makes the answer compressible
 * enough for the gzip check to mean anything.
 */
function isophones({ lat, lon, radius }) {
  const bands = ['80+', '75-80', '70-75', '65-70', '60-65', '55-60', '50-55', '-35'];
  const features = bands.map((label, band) => {
    // Outermost band first would draw the quiet ring over the loud ones; the
    // real exporter emits them in this order for the same reason.
    const r = (radius * (band + 1)) / bands.length;
    const ring = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ring.push([
        Number((lon + ((r * Math.cos(a)) / 111320) * Math.cos((lat * Math.PI) / 180)).toFixed(6)),
        Number((lat + (r * Math.sin(a)) / 111320).toFixed(6)),
      ]);
    }
    return {
      type: 'Feature',
      properties: { ISOLABEL: label },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  });
  return { type: 'FeatureCollection', features };
}

const args = parseArgs(process.argv.slice(2));
const srcRadius = args.srcRadius ?? args.radius + args.maxSrcDist;
const jobId = `${args.lat.toFixed(4)}_${args.lon.toFixed(4)}_r${args.radius}s${srcRadius}`;
// `stub_` in front of the name on purpose: a job directory is named after the
// point and holds the real extract and the real result for it. Writing here
// under the real name would overwrite a genuine map with an invented one.
const jobDir = path.join(ROOT, 'jobs', `stub_${jobId}`);
await mkdir(jobDir, { recursive: true });

const outFile = path.join(jobDir, 'isophones.geojson');
const previewFile = path.join(jobDir, 'preview.geojson');
const map = isophones(args);

let frames = 0;

console.log(`fake job ${jobId} — no calculation, ${TOTAL_MS} ms of pretending`);

// The same stages in the same order, so the progress bar, the labels and the
// client's switch statement are all exercised by the names they will really see.
// Propagation owns most of the wall clock here as it does in the real pipeline.
const script = [
  ['overpass', 0.08],
  ['import', 0.06],
  ['grid', 0.04],
  ['preview', 0.12],
  ['propagation', 0.55],
  ['isosurface', 0.07],
  ['dissolve', 0.04],
  ['export', 0.04],
];

for (const [stage, share] of script) {
  if (stage === 'preview' && !(args.previewSrcDist > 0)) continue;
  emit('STAGE', stage);
  const ms = Math.round(TOTAL_MS * share);
  if (stage === 'propagation') {
    // Cell counts, the way the real pass reports them — this is what drives the
    // bar between stage changes, and a stream that only ever reports stages
    // would let a broken progress calculation through unnoticed.
    const steps = 10;
    let lastFrame = Date.now();
    for (let i = 1; i <= steps; i++) {
      await sleep(Math.round(ms / steps));
      emit('PROGRESS', `${i * 100} ${steps * 100}`);
      // Frames are off by default here as they are in the real pipeline, and
      // for the same reason — but the route that serves them is part of the
      // HTTP layer, so it has to be reachable when a check asks for it.
      if (args.partialIntervalMs > 0 && Date.now() - lastFrame >= args.partialIntervalMs) {
        lastFrame = Date.now();
        const file = path.join(jobDir, `partial-${++frames}.geojson`);
        await writeFile(file, JSON.stringify(map), 'utf8');
        emit('PARTIAL', file);
      }
    }
  } else {
    await sleep(ms);
  }
  if (stage === 'preview') {
    await writeFile(previewFile, JSON.stringify(map), 'utf8');
    emit('PREVIEW', previewFile);
  }
}

await writeFile(outFile, JSON.stringify(map), 'utf8');
console.log(`  ${outFile}`);
emit('RESULT', outFile);
