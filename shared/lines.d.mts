/**
 * Hand-written declarations for lines.mjs. Keep in sync with it: the module is
 * plain ESM so the scripts can import it unbuilt, which means tsc reads this
 * file rather than the implementation.
 */

export interface LineSplitter {
  /** Feeds one chunk; calls back for every complete line it now holds. */
  push(chunk: Uint8Array): void;
  /** Emits a trailing line that never got its newline. */
  flush(): void;
}

export declare function lineSplitter(onLine: (line: string) => void): LineSplitter;
