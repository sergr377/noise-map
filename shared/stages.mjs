/**
 * The stages a calculation reports, in one place because three parts speak them:
 * run-job.mjs emits them as `@@STAGE` markers, the server turns them into labels
 * and progress spans, and the browser switches on them.
 *
 * Two independent copies of the same union is precisely what TypeScript cannot
 * catch drifting apart — each is valid on its own, and only the running system
 * notices that one side has a stage the other has never heard of.
 */

export const STAGES = [
  // Working stages, in the order a job passes through them. `preview` is
  // skipped when the caller did not ask for the rough map.
  'queued',
  'overpass',
  'import',
  'grid',
  'preview',
  'propagation',
  'isosurface',
  'dissolve',
  'export',
  // Terminal: nothing is published after one of these and the stream closes.
  'done',
  'error',
  'cancelled',
];

/**
 * Whether a string names a stage. The pipeline reports its progress as text
 * through a marker protocol, so this is the boundary where that text becomes a
 * value the rest of the code can trust.
 */
export function isStage(value) {
  return STAGES.includes(value);
}
