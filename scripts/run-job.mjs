/**
 * End-to-end noise job: Overpass extract -> NoiseModelling -> GeoJSON isophones.
 *
 * Usage:
 *   node scripts/run-job.mjs --lat 55.7558 --lon 37.6173 --radius 1000
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bboxAround, bboxEwkt, utmSrid, fetchOsm } from './lib.mjs';
import { writeDemAsc } from './dem.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM_HOME = path.join(ROOT, '.tools', 'nm', 'NoiseModelling_6.0.0');

/**
 * Machine-readable markers on stdout. The HTTP layer spawns this script rather
 * than reimplementing the pipeline, and parses these lines to drive its progress
 * stream. The `@@` prefix cannot collide with NoiseModelling's own log format.
 */
const emit = (kind, payload) => console.log(`@@${kind} ${payload}`);

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
  const runner = path.join(NM_HOME, 'bin', 'ScriptRunner.bat');
  const script = path.join(ROOT, 'pipeline', 'noise_pipeline.groovy');
  return new Promise((resolve, reject) => {
    const child = spawn(runner, ['-w', jobDir, '-s', script], {
      cwd: NM_HOME,
      env: { ...process.env, NM_PARAMS: paramsPath },
      shell: true,
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

        if (/\[TIMING\]|ERROR|Exception|isosurface|Export/i.test(line)) {
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
      demFile: demInfo ? demFile : '',
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
