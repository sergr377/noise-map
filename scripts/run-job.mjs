/**
 * End-to-end noise job: Overpass extract -> NoiseModelling -> GeoJSON isophones.
 *
 * Usage:
 *   node scripts/run-job.mjs --lat 55.7558 --lon 37.6173 --radius 1000
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, rm, readdir, utimes } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bboxAround, bboxEwkt, utmSrid, fetchOsm } from './lib.mjs';
import { writeDemAsc } from './dem.mjs';
import { fetchRail, NIGHT_SHARE, TRAIN_TYPE } from './rail.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM_HOME = path.join(ROOT, '.tools', 'nm', 'NoiseModelling_6.0.0');

/**
 * Machine-readable markers on stdout. The HTTP layer spawns this script rather
 * than reimplementing the pipeline, and parses these lines to drive its progress
 * stream. The `@@` prefix cannot collide with NoiseModelling's own log format.
 */
const emit = (kind, payload) => console.log(`@@${kind} ${payload}`);

/**
 * A job directory is named after the point, not after the run, and every file in
 * it — the H2 database above all — has a fixed name. Two runs of the same point
 * therefore share one database and interleave its tables: on 2026-08-19 that gave
 * two different maps for one point. The lock file makes the directory
 * single-writer.
 *
 * The holder touches the lock every LOCK_HEARTBEAT_MS, so a lock is abandoned
 * once it has gone quiet for LOCK_STALE_MS or once the process that wrote it is
 * gone — a run killed outright leaves one behind, under Windows `taskkill /F`
 * runs no cleanup at all. Both tests are needed: pids get reused, and a lock
 * written on another machine cannot be checked by pid at all.
 */
const LOCK_FILE = 'run.lock';
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

function pidAlive(pid) {
  try {
    // Signal 0 asks whether the process exists without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return err.code === 'EPERM';
  }
}

async function readLock(lockPath) {
  const [raw, info] = await Promise.all([
    readFile(lockPath, 'utf8').catch(() => ''),
    stat(lockPath).catch(() => null),
  ]);
  let held = {};
  try {
    held = JSON.parse(raw);
  } catch {
    // Caught mid-write, or written by an older version: unreadable is not the
    // same as absent, so the heartbeat alone decides.
  }
  const idleMs = info ? Date.now() - info.mtimeMs : Infinity;
  // A lock written on another machine can only be judged by its heartbeat.
  const pidGone = held.host === hostname() && Number.isInteger(held.pid) && !pidAlive(held.pid);
  return { ...held, idleMs, pidGone, alive: idleMs <= LOCK_STALE_MS && !pidGone };
}

let heldLock = null;

/**
 * Takes the job directory for this run, or fails saying who holds it.
 *
 * Queuing behind the other run would look friendlier but cannot be honest about
 * the wait: it is computing the same point and may be anywhere from seconds to
 * half an hour from the end.
 */
async function acquireLock(dir) {
  const lockPath = path.join(dir, LOCK_FILE);
  const mine = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  // Two attempts: the second is for losing the race to take over a stale lock,
  // and it can only end in EEXIST with a live holder, which is the error below.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, mine, { flag: 'wx' });
      heldLock = lockPath;
      const beat = setInterval(() => {
        const now = new Date();
        utimes(lockPath, now, now).catch(() => {
          /* released, or the directory went away under us */
        });
      }, LOCK_HEARTBEAT_MS);
      // The heartbeat must not be what keeps the process alive at the end.
      beat.unref();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = await readLock(lockPath);
      if (held.alive) {
        const busy = new Error(
          `job directory ${dir} is held by another run (pid ${held.pid ?? '?'} on ` +
            `${held.host ?? '?'}, started ${held.startedAt ?? '?'}). Both would write the same ` +
            `H2 database and mix up its tables, so this run stops. Wait for that one to ` +
            `finish, or stop it, and try again.`,
        );
        busy.busy = true;
        throw busy;
      }
      console.log(
        `  lock: снимаю осиротевший ${LOCK_FILE} (pid ${held.pid ?? '?'}: ` +
          `${held.pidGone ? 'процесса нет' : `молчит ${(held.idleMs / 1000).toFixed(0)} с`})`,
      );
      await rm(lockPath, { force: true });
    }
  }
  throw Object.assign(new Error(`job directory ${dir} is held by another run`), { busy: true });
}

function releaseLock() {
  if (!heldLock) return;
  const lockPath = heldLock;
  heldLock = null;
  try {
    // Synchronous on purpose: this also runs from the exit handler, where
    // nothing asynchronous would get a chance to finish.
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  // Default handling ends the process without running the exit handler, so
  // every cancelled run would leave its lock for the next one to clear.
  process.on(signal, () => {
    releaseLock();
    process.exit(1);
  });
}

function parseArgs(argv) {
  const out = {
    radius: 1000,
    maxArea: 2500,
    maxSrcDist: 500,
    diffVertical: 1,
    diffHorizontal: 0,
    reflOrder: 1,
    simplifyTolerance: 1.0,
    coordDecimals: 6,
    dem: 1,
    demCellsize: 0.00025,
    // Railways are opt-in: their traffic is supplied by the caller rather than
    // derived from data, so they are never switched on silently.
    rail: 0,
    trainsPerHour: 4,
    // How often the pipeline exports a partial map while it is still computing.
    // Off by default: a direct CLI run wants the result, not frames — the server
    // switches this on because there someone is watching an empty map.
    partialIntervalMs: 0,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = Number(argv[i + 1]);
  }
  if (!Number.isFinite(out.lat) || !Number.isFinite(out.lon)) {
    throw new Error('--lat and --lon are required');
  }
  return out;
}

function runScriptRunner(jobDir, paramsPath) {
  // The distribution ships both launchers; the .bat one does not exist in a
  // Linux container, where the deployment runs.
  const runner = path.join(
    NM_HOME,
    'bin',
    process.platform === 'win32' ? 'ScriptRunner.bat' : 'ScriptRunner',
  );
  const script = path.join(ROOT, 'pipeline', 'noise_pipeline.groovy');
  return new Promise((resolve, reject) => {
    const child = spawn(runner, ['-w', jobDir, '-s', script], {
      cwd: NM_HOME,
      env: { ...process.env, NM_PARAMS: paramsPath },
      // .bat files need a shell interpreter; the Unix script has a shebang and
      // runs directly, which also avoids shell quoting of the paths.
      shell: process.platform === 'win32',
    });
    // Which stage begins once a given block reports completion.
    const nextStage = {
      Import_OSM: 'grid',
      Delaunay_Grid: 'propagation',
      Noise_level_from_traffic: 'isosurface',
      Create_Isosurface: 'dissolve',
      Dissolve: 'export',
    };
    let tail = [];
    const capture = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;

        const done = line.match(/\[TIMING\] (\w+) done/);
        if (done && nextStage[done[1]]) emit('STAGE', nextStage[done[1]]);

        // Propagation is ~90% of the runtime and NoiseModelling reports it as
        // cells, which is the only real progress signal the pipeline exposes.
        const cell = line.match(/Begin processing of cell (\d+)\/(\d+)/);
        if (cell) emit('PROGRESS', `${cell[1]} ${cell[2]}`);

        // A map of everything computed so far, exported mid-run. Only the file
        // name is taken from the log line and the path is rebuilt here: the
        // JVM writes its console output in the OS encoding, so a job directory
        // with non-ASCII characters — a Cyrillic user name, say — comes back
        // mangled and unopenable. The name itself is always ASCII.
        const partial = line.match(/\[PARTIAL\].*?(partial-\d+\.geojson)/);
        if (partial) emit('PARTIAL', path.join(jobDir, partial[1]));

        if (/\[TIMING\]|\[PARTIAL\]|ERROR|Exception|isosurface|Export/i.test(line)) {
          console.log('  ' + line.slice(0, 200));
        }
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ScriptRunner exited ${code}\n${tail.join('\n')}`));
    });
  });
}

const args = parseArgs(process.argv.slice(2));
// A source beyond maxSrcDist of every receiver cannot contribute, so the extract
// only has to reach one propagation distance past the displayed disc.
const srcRadius = args.srcRadius ?? args.radius + args.maxSrcDist;
const jobId = `${args.lat.toFixed(4)}_${args.lon.toFixed(4)}_r${args.radius}s${srcRadius}`;
const jobDir = path.join(ROOT, 'jobs', jobId);
await mkdir(jobDir, { recursive: true });
try {
  await acquireLock(jobDir);
} catch (err) {
  // A busy directory is about the machine, not about the place that was clicked,
  // so the caller is told that rather than being left with a stage name.
  if (err.busy) emit('ERROR', 'эта точка уже считается — подождите и попробуйте снова');
  throw err;
}

const bbox = bboxAround(args.lat, args.lon, srcRadius);
const fenceWkt = bboxEwkt(bboxAround(args.lat, args.lon, args.radius));
const srid = utmSrid(args.lat, args.lon);
const osmFile = path.join(jobDir, 'extract.osm');
const outFile = path.join(jobDir, 'isophones.geojson');

console.log(
  `job ${jobId}  srid EPSG:${srid}  receivers r=${args.radius}m  sources r=${srcRadius}m  maxSrcDist=${args.maxSrcDist}m`,
);

const t0 = Date.now();
emit('STAGE', 'overpass');
// Overpass is the slowest and least reliable step; reuse an extract when the
// same job directory already has one so tuning runs don't re-hammer the API.
const cached = await stat(osmFile).catch(() => null);
if (cached && cached.size > 0) {
  console.log(`  overpass: reusing cached extract (${(cached.size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  const { bytes, endpoint } = await fetchOsm(bbox, osmFile);
  console.log(
    `  overpass: ${(bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s via ${new URL(endpoint).host}`,
  );
}
// Terrain is optional: it costs a little time and a few tile downloads, and on
// genuinely flat ground it changes nothing.
const demFile = path.join(jobDir, `dem_${args.demCellsize}.asc`);
let demInfo = null;
if (args.dem) {
  const cachedDem = await stat(demFile).catch(() => null);
  if (cachedDem && cachedDem.size > 0) {
    console.log('  dem: reusing cached raster');
    demInfo = { cached: true };
  } else {
    demInfo = await writeDemAsc(bbox, demFile, { cellsize: args.demCellsize });
    console.log(
      `  dem: ${demInfo.points} points from ${demInfo.tiles} tiles, ` +
        `${demInfo.min.toFixed(0)}–${demInfo.max.toFixed(0)} m (перепад ${(demInfo.max - demInfo.min).toFixed(0)} m)`,
    );
  }
}

const railFile = path.join(jobDir, 'rail.geojson');
let railInfo = null;
if (args.rail) {
  const cachedRail = await stat(railFile).catch(() => null);
  if (cachedRail && cachedRail.size > 0) {
    console.log('  rail: reusing cached geometry');
    railInfo = { cached: true };
  } else {
    railInfo = await fetchRail(bbox, railFile);
    console.log(
      `  rail: ${railInfo.sections} участков пути, скорость из OSM у ${railInfo.speedFromOsm}`,
    );
    if (railInfo.sections === 0) {
      console.log('  rail: поверхностных путей нет — слой не даст вклада');
    }
  }
}

const tOsm = Date.now();
emit('STAGE', 'import');

// Import_OSM writes into fixed table names, so a leftover H2 file from a previous
// run would be appended to rather than replaced. Drop it, keeping the OSM extract.
for (const entry of await readdir(jobDir)) {
  if (entry.startsWith('h2gisdb')) {
    await rm(path.join(jobDir, entry), { force: true });
  }
}

const paramsPath = path.join(jobDir, 'params.json');
await writeFile(
  paramsPath,
  JSON.stringify(
    {
      osmFile,
      outFile,
      srid,
      fenceWkt,
      // The shown area is a disc around the requested point, cut at the end of
      // the pipeline: the receiver grid can only be bounded by a rectangle.
      centreLat: args.lat,
      centreLon: args.lon,
      radius: args.radius,
      partialIntervalMs: args.partialIntervalMs,
      demFile: demInfo ? demFile : '',
      // An empty geometry file would make the rail pass do a full propagation
      // run for nothing, so a location without surface track skips it entirely.
      railFile: railInfo && railInfo.sections !== 0 ? railFile : '',
      trainType: TRAIN_TYPE,
      trainsDay: args.trainsPerHour,
      trainsEvening: args.trainsPerHour,
      trainsNight: Math.max(0, Math.round(args.trainsPerHour * NIGHT_SHARE)),
      maxArea: args.maxArea,
      maxSrcDist: args.maxSrcDist,
      simplifyTolerance: args.simplifyTolerance,
      diffVertical: Boolean(args.diffVertical),
      diffHorizontal: Boolean(args.diffHorizontal),
      reflOrder: args.reflOrder,
      isoClass: '35.0,40.0,45.0,50.0,55.0,60.0,65.0,70.0,75.0,80.0,200.0',
    },
    null,
    2,
  ),
  'utf8',
);

await runScriptRunner(jobDir, paramsPath);
const tNm = Date.now();

console.log(`  noisemodelling: ${((tNm - tOsm) / 1000).toFixed(1)}s`);

// The exporter writes full double precision — 14 decimal places, i.e. nanometres.
// Six decimals is ~0.1 m at this latitude, far finer than the model's accuracy,
// and drops roughly half the bytes on its own.
const rawSize = (await stat(outFile)).size;
const gj = JSON.parse(await readFile(outFile, 'utf8'));
const factor = 10 ** args.coordDecimals;
const roundCoords = (c) => {
  if (typeof c[0] === 'number') {
    c[0] = Math.round(c[0] * factor) / factor;
    c[1] = Math.round(c[1] * factor) / factor;
    if (c.length > 2) c.length = 2;
  } else {
    c.forEach(roundCoords);
  }
};
for (const feat of gj.features) {
  if (feat.geometry) roundCoords(feat.geometry.coordinates);
}
await writeFile(outFile, JSON.stringify(gj), 'utf8');
const finalSize = (await stat(outFile)).size;

console.log(
  `  output: ${(rawSize / 1024).toFixed(0)} KB -> ${(finalSize / 1024).toFixed(0)} KB ` +
    `after rounding (${gj.features.length} features)`,
);
console.log(`  ${outFile}`);
console.log(`TOTAL ${((Date.now() - t0) / 1000).toFixed(1)}s`);
emit('RESULT', outFile);
