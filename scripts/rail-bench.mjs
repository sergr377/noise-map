/**
 * Runs pipeline/rail_bench.groovy: the railway propagation, timed variant by
 * variant on a synthetic scene.
 *
 * The point of a synthetic scene is that working on the rail branch otherwise
 * costs an Overpass query and tens of minutes per experiment. This one builds
 * its own buildings, track and receiver mesh, needs no network at all, and calls
 * the pipeline's own railEmission, buildRailSources and combineRoadRail rather
 * than copies of them — so what it measures is what a real job would do.
 *
 * Usage:
 *   node scripts/rail-bench.mjs
 *   node scripts/rail-bench.mjs --sections 30 --variants road,railProd,rail3
 *
 * Variants, cheapest first — see the header of the Groovy script for what each
 * one changes. `rail3` is the exact reference and is slow on purpose: put it
 * last in the list, because the others are compared against it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM_HOME = path.join(ROOT, '.tools', 'nm', 'NoiseModelling_6.0.0');

const OPTIONS = {
  // Half-side of the receiver square, in metres.
  half: 'BENCH_HALF',
  // Parallel rail lines. One is a plain double track; thirty is a station throat.
  sections: 'BENCH_SECTIONS',
  variants: 'BENCH_VARIANTS',
  maxSrcDist: 'BENCH_MAXSRCDIST',
  maxArea: 'BENCH_MAXAREA',
  // How far under the loudest row of a section a row may be before it is dropped.
  floor: 'BENCH_FLOOR',
};

const env = { ...process.env };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i].replace(/^--/, '');
  if (!(key in OPTIONS)) {
    throw new Error(`неизвестный ключ --${key}; известные: ${Object.keys(OPTIONS).join(', ')}`);
  }
  if (argv[i + 1] === undefined) throw new Error(`--${key} без значения`);
  env[OPTIONS[key]] = argv[i + 1];
}

// A workspace of its own every time: the benchmark leaves an H2 database behind,
// and reusing one would carry the previous run's tables into this one — the
// blocks append to whatever they find rather than replacing it.
const workDir = await mkdtemp(path.join(tmpdir(), 'rail-bench-'));
const runner = path.join(
  NM_HOME,
  'bin',
  process.platform === 'win32' ? 'ScriptRunner.bat' : 'ScriptRunner',
);

const code = await new Promise((resolve, reject) => {
  const child = spawn(
    runner,
    ['-w', workDir, '-s', path.join(ROOT, 'pipeline', 'rail_bench.groovy')],
    {
      cwd: NM_HOME,
      // The Groovy script reads pipeline/noise_pipeline.groovy by a path relative
      // to nothing it controls, because ScriptRunner runs from its own home.
      env: { ...env, BENCH_PIPELINE: path.join(ROOT, 'pipeline', 'noise_pipeline.groovy') },
      shell: process.platform === 'win32',
    },
  );
  const show = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (/\[BENCH\]|\[RAIL\]|ERROR|Exception/.test(line)) console.log(line.replace(/^.*?- /, ''));
    }
  };
  child.stdout.on('data', show);
  child.stderr.on('data', show);
  child.on('error', reject);
  child.on('close', resolve);
});

await rm(workDir, { recursive: true, force: true });
process.exit(code ?? 1);
