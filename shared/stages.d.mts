/**
 * Hand-written declarations for stages.mjs. Keep the tuple identical to the
 * array there: `Stage` is derived from it, so an entry missing here is a stage
 * the type system will reject even though the code emits it.
 */

export declare const STAGES: readonly [
  'queued',
  'overpass',
  'import',
  'grid',
  'preview',
  'propagation',
  'isosurface',
  'dissolve',
  'export',
  'done',
  'error',
  'cancelled',
];

/** One of the stages above. */
export type Stage = (typeof STAGES)[number];

export declare function isStage(value: string): value is Stage;
