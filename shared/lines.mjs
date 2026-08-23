/**
 * Splitting a byte stream into lines, across chunk boundaries.
 *
 * Plain ESM rather than TypeScript on purpose: the server compiles through tsc
 * with rootDir=src, the scripts run unbuilt, and this is the one piece of
 * runtime code both need. The declarations live next to it in lines.d.mts.
 */

/**
 * Collects chunks and calls `onLine` once per complete line.
 *
 * A `data` handler receives whatever the OS had ready, which is not a line: a
 * chunk can end mid-line, and the next one carries the rest. Code that matches
 * output against a pattern — the `@@MARKER` protocol, the `[TIMING] ... done`
 * lines of the pipeline — has to hold that tail until its continuation
 * arrives, or both halves match nothing and the marker is lost silently.
 *
 * **One splitter per stream.** Sharing a buffer between stdout and stderr is
 * the bug this exists to prevent: an unfinished line from one gets the head of
 * a line from the other appended to it, and the result never existed.
 */
export function lineSplitter(onLine) {
  // stream: true keeps a multi-byte character intact when a chunk splits it.
  // The pipeline reports its errors in Russian, so this is not hypothetical.
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      // Whatever follows the last newline has not been terminated yet — an
      // unfinished line, or an empty string when the chunk ended cleanly.
      // Either way it stays in the buffer instead of going downstream.
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },

    /**
     * Emits what the process left without a trailing newline. Call it on
     * close: a pipeline killed mid-write still has something to say.
     */
    flush() {
      buffer += decoder.decode();
      if (!buffer) return;
      const last = buffer;
      buffer = '';
      onLine(last);
    },
  };
}
