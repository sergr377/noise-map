/**
 * The retry loop in front of the elevation tiles.
 *
 * It exists because of one measured failure: inside a container DNS blinks —
 * one `ENOTFOUND` in six consecutive lookups — and the tiles are gathered with
 * a single `Promise.all`, so one bad lookup used to fail a job that had already
 * spent Overpass's megabytes and half a minute. None of that is checkable
 * against the real bucket: a test that needs a resolver to fail on cue is not a
 * test. So the loop takes its `fetch`, its sleep and its randomness from the
 * caller, and what is verified here is the part that decides whether a click
 * survives — what gets retried, what does not, and how long the waiting costs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { fetchTile, tileVerdict } from '../scripts/dem.mjs';

/** A real one-pixel Terrarium tile, so the decode path is exercised for real. */
function tilePng() {
  const png = new PNG({ width: 1, height: 1 });
  // (R * 256 + G + B / 256) - 32768 → 128 * 256 - 32768 = 0 m above sea level.
  [png.data[0], png.data[1], png.data[2], png.data[3]] = [128, 0, 0, 255];
  return PNG.sync.write(png);
}

const TILE = tilePng();

/** A response with only the parts fetchTile actually looks at. */
function reply(status, body = TILE) {
  return {
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

/** The failure Node's fetch produces when a lookup fails: a bare message. */
function dnsFailure(code = 'EAI_AGAIN') {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(`getaddrinfo ${code} s3.amazonaws.com`), { code });
  return err;
}

/** Collects what the loop did, so a test can assert on it instead of on stdout. */
function harness(responses, { attempts = 4 } = {}) {
  const calls = [];
  const slept = [];
  const logged = [];
  return {
    calls,
    slept,
    logged,
    options: {
      attempts,
      timeoutMs: 50,
      random: () => 0,
      fetchImpl: async (url) => {
        calls.push(url);
        const next = responses[calls.length - 1] ?? responses[responses.length - 1];
        if (next instanceof Error) throw next;
        return next;
      },
      sleepImpl: async (ms) => slept.push(ms),
      log: (line) => logged.push(line),
    },
  };
}

test('tileVerdict separates "not now" from "not there"', () => {
  assert.equal(tileVerdict(200), 'ok');
  assert.equal(tileVerdict(299), 'ok');
  assert.equal(tileVerdict(429), 'retry');
  assert.equal(tileVerdict(500), 'retry');
  assert.equal(tileVerdict(503), 'retry');
  // Nowhere else to ask, and a second ask cannot conjure a tile that is absent.
  assert.equal(tileVerdict(404), 'gone');
  assert.equal(tileVerdict(403), 'gone');
});

test('a blinking resolver costs a retry, not the job', async () => {
  const h = harness([dnsFailure(), reply(200)]);
  const tile = await fetchTile(12, 2478, 1287, h.options);

  assert.equal(tile.width, 1);
  assert.equal(h.calls.length, 2, 'asked twice');
  assert.equal(h.slept.length, 1, 'waited once, between the two attempts');
  // The code that says which network problem it was is the only useful part of
  // "fetch failed", so it has to reach the log.
  assert.match(h.logged[0], /EAI_AGAIN/);
  assert.match(h.logged[0], /повтор 2\/4/);
});

test('the request carries the tile coordinates it was asked for', async () => {
  const h = harness([reply(200)]);
  await fetchTile(12, 2478, 1287, h.options);

  assert.equal(h.calls.length, 1, 'a tile that answers is fetched once');
  assert.match(h.calls[0], /\/12\/2478\/1287\.png$/);
});

test('giving up names the cause, not just "fetch failed"', async () => {
  const h = harness([dnsFailure('ENOTFOUND')]);

  await assert.rejects(() => fetchTile(12, 2478, 1287, h.options), {
    message: /тайл 12\/2478\/1287.*ENOTFOUND.*попыток 4/s,
  });
  assert.equal(h.calls.length, 4, 'spends every attempt');
  assert.equal(h.slept.length, 3, 'and waits between them, not after the last');
});

test('the ladder climbs, and half of every step is jitter', async () => {
  const h = harness([dnsFailure()]);
  await assert.rejects(() => fetchTile(12, 2478, 1287, h.options));

  // random() === 0 pins each wait to the fixed half of its window: 300, 600,
  // 1200 ms capped at 5 s. The other half is spread out so that clients waiting
  // on the same outage do not return in the same instant.
  assert.deepEqual(h.slept, [150, 300, 600]);
  assert.ok(
    h.slept.reduce((a, b) => a + b) < 2000,
    'the whole ladder is cheap against a job that costs minutes',
  );
});

test('a tile that is not there fails at once', async () => {
  const h = harness([reply(404, Buffer.alloc(0))]);

  await assert.rejects(() => fetchTile(12, 2478, 1287, h.options), {
    message: 'тайл 12/2478/1287: HTTP 404',
  });
  assert.equal(h.calls.length, 1, 'no ladder for an answer that cannot change');
  assert.deepEqual(h.slept, [], 'and no waiting');
});

test('a busy bucket is retried', async () => {
  const h = harness([reply(503, Buffer.alloc(0)), reply(429, Buffer.alloc(0)), reply(200)]);
  const tile = await fetchTile(12, 2478, 1287, h.options);

  assert.equal(tile.width, 1);
  assert.equal(h.calls.length, 3);
  assert.match(h.logged[0], /HTTP 503/);
  assert.match(h.logged[1], /HTTP 429/);
});

test('a truncated body is retried, because that is what a dropped download looks like', async () => {
  const h = harness([reply(200, TILE.subarray(0, 20)), reply(200)]);
  const tile = await fetchTile(12, 2478, 1287, h.options);

  assert.equal(tile.width, 1, 'the second, whole body decodes');
  assert.equal(h.calls.length, 2);
});
