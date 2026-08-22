/**
 * shared/stages.mjs carries hand-written declarations in stages.d.mts, and the
 * Stage type is derived from the tuple there rather than from the array here.
 * Nothing in the compiler ties the two together — that is what this file is
 * for, plus the third speaker of these names: the job script that emits them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STAGES, isStage } from '../shared/stages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the declared tuple matches the runtime array', async () => {
  const dts = await readFile(path.join(ROOT, 'shared', 'stages.d.mts'), 'utf8');
  const tuple = dts.slice(dts.indexOf('STAGES'), dts.indexOf('];'));
  const declared = [...tuple.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared, STAGES, 'stages.d.mts drifted from stages.mjs');
});

test('isStage accepts every stage and nothing else', () => {
  for (const stage of STAGES) assert.equal(isStage(stage), true, stage);
  for (const other of ['', 'Propagation', 'propagation ', 'finished', '__proto__']) {
    assert.equal(isStage(other), false, other);
  }
});

test('every stage the job script emits is a known stage', async () => {
  // The server used to cast the marker payload to Stage without looking. It
  // checks now, which turns a divergence into a stage that silently never
  // arrives — so the two lists are compared here instead.
  const script = await readFile(path.join(ROOT, 'scripts', 'run-job.mjs'), 'utf8');

  const direct = [...script.matchAll(/emit\('STAGE',\s*'([a-z]+)'\)/g)].map((m) => m[1]);
  // The rest come from the block-name -> stage table, whose values are the
  // stages reported as each NoiseModelling block finishes.
  // Keys in that table are bare identifiers (block names), so every quoted
  // lowercase word inside it is a stage — including the one behind a ternary.
  const table = script.slice(script.indexOf('const nextStage = {'));
  const mapped = [...table.slice(0, table.indexOf('};')).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  const emitted = [...new Set([...direct, ...mapped])];
  assert.ok(emitted.length >= 6, `expected to find the emitted stages, got ${emitted}`);
  for (const stage of emitted) {
    assert.ok(STAGES.includes(stage), `run-job.mjs emits "${stage}", which is not a stage`);
  }
});

test('the terminal stages are present, and last', () => {
  // The server closes a progress stream on these; the browser stops asking.
  assert.deepEqual(STAGES.slice(-3), ['done', 'error', 'cancelled']);
});
