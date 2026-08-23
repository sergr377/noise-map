/**
 * The line splitter is the one place where "the code obviously works" was
 * wrong twice: the server shared one buffer between two streams, and the job
 * script kept no buffer at all. Both bugs are invisible until a chunk lands in
 * the wrong place, which is exactly what these cases arrange on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineSplitter } from '../shared/lines.mjs';

/** Feeds chunks and returns every line the splitter emitted. */
function collect(chunks, { flush = true } = {}) {
  const lines = [];
  const splitter = lineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.push(Buffer.from(chunk));
  if (flush) splitter.flush();
  return lines;
}

test('a line split across chunks arrives whole, once', () => {
  assert.deepEqual(collect(['@@STAGE prop', 'agation\n']), ['@@STAGE propagation']);
});

test('a line is not emitted before its newline', () => {
  const lines = [];
  const splitter = lineSplitter((line) => lines.push(line));
  splitter.push(Buffer.from('@@PROGRESS 3'));
  assert.deepEqual(lines, [], 'an unterminated line must wait for the rest');
  splitter.push(Buffer.from(' 10\n'));
  assert.deepEqual(lines, ['@@PROGRESS 3 10']);
});

test('several lines in one chunk come out in order', () => {
  assert.deepEqual(collect(['a\nb\nc\n']), ['a', 'b', 'c']);
});

test('CRLF is a line break too — the pipeline runs on Windows as well', () => {
  assert.deepEqual(collect(['a\r\nb\r\n']), ['a', 'b']);
});

test('a multi-byte character split between chunks survives', () => {
  // What chunk.toString() used to mangle: the pipeline reports its errors in
  // Russian, so a boundary inside a two-byte character is not hypothetical.
  const bytes = Buffer.from('@@ERROR каталог занят\n');
  const cut = 12; // lands in the middle of "каталог"
  assert.deepEqual(collect([bytes.subarray(0, cut), bytes.subarray(cut)]), [
    '@@ERROR каталог занят',
  ]);
});

test('flush emits a trailing line that never got its newline', () => {
  assert.deepEqual(collect(['@@RESULT /jobs/x.geojson']), ['@@RESULT /jobs/x.geojson']);
});

test('flush after a clean end emits nothing', () => {
  assert.deepEqual(collect(['done\n']), ['done']);
});

test('empty lines are preserved, not swallowed', () => {
  assert.deepEqual(collect(['a\n\nb\n']), ['a', '', 'b']);
});

test('two streams with their own splitters do not contaminate each other', () => {
  // The server bug: one buffer shared between stdout and stderr glued the tail
  // of an unfinished line onto the head of a line from the other stream.
  const out = [];
  const err = [];
  const stdout = lineSplitter((line) => out.push(line));
  const stderr = lineSplitter((line) => err.push(line));

  stdout.push(Buffer.from('@@RESULT /jobs/x/iso'));
  stderr.push(Buffer.from('WARNING: java noise\n'));
  stdout.push(Buffer.from('phones.geojson\n'));

  assert.deepEqual(out, ['@@RESULT /jobs/x/isophones.geojson']);
  assert.deepEqual(err, ['WARNING: java noise']);
});

test('a byte-at-a-time stream still yields the same lines', () => {
  const text = '@@STAGE grid\n@@PROGRESS 1 2\nBegin processing of cell 1/4\n';
  const bytes = Buffer.from(text);
  const chunks = [...bytes].map((b) => Buffer.from([b]));
  assert.deepEqual(collect(chunks), [
    '@@STAGE grid',
    '@@PROGRESS 1 2',
    'Begin processing of cell 1/4',
  ]);
});
