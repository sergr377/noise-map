/**
 * The retry loop in front of Overpass — the one thing between a click and a
 * public instance having a bad afternoon.
 *
 * None of this can be checked against the real thing: a test that needs
 * overpass-api.de to answer 504 on cue is not a test. So the loop takes its
 * clock, its `fetch`, its sleep and its cooldown map from the caller, and what
 * is verified here is the behaviour that decides whether a click survives —
 * which mirror is asked, in what order, when one is left alone, and when the
 * loop gives up instead of holding the user for the better part of an hour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelay,
  overpassFetch,
  overpassVerdict,
  parseEndpoints,
  parseRetryAfter,
} from '../scripts/lib.mjs';

const OSM = '<osm><node id="1"/></osm>';

/** A response with only the parts overpassFetch actually looks at. */
function reply(status, body = '', headers = {}) {
  return {
    status,
    statusText: String(status),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/**
 * A clock and a sleep that agree with each other, so a back-off of a minute
 * costs the test nothing. Every deadline in the loop is computed from `now`.
 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Records which endpoint was asked, in order, and answers from a script. */
function scriptedFetch(answers) {
  const asked = [];
  const impl = async (endpoint) => {
    asked.push(new URL(endpoint).host);
    const answer = answers[asked.length - 1] ?? answers.at(-1);
    if (typeof answer === 'function') return answer(endpoint);
    return answer;
  };
  impl.asked = asked;
  return impl;
}

const A = 'https://a.example/api/interpreter';
const B = 'https://b.example/api/interpreter';
const C = 'https://c.example/api/interpreter';

test('parseEndpoints splits on commas and whitespace', () => {
  assert.deepEqual(parseEndpoints(`${A}, ${B}\n${C}`), [A, B, C]);
});

test('parseEndpoints drops what is not a URL and keeps the rest', () => {
  assert.deepEqual(parseEndpoints(`${A}, overpass-api.de, ftp://x/y`), [A]);
});

test('parseEndpoints falls back rather than leaving nowhere to ask', () => {
  // An .env with a typo in it must not end with the pipeline holding an empty
  // list — that failure would read as "Overpass is down" everywhere at once.
  const fallback = [B];
  assert.deepEqual(parseEndpoints('nonsense', fallback), fallback);
  assert.deepEqual(parseEndpoints('', fallback), fallback);
  assert.deepEqual(parseEndpoints(undefined, fallback), fallback);
});

test('overpassVerdict separates a busy server from a broken query', () => {
  assert.equal(overpassVerdict(200), 'ok');
  // The two the public instances actually hand out under load.
  assert.equal(overpassVerdict(429), 'retry');
  assert.equal(overpassVerdict(504), 'retry');
  assert.equal(overpassVerdict(502), 'retry');
  // Our own fault, and identically so on every mirror.
  assert.equal(overpassVerdict(400), 'query-broken');
  // About this instance: blocked agent, moved path.
  assert.equal(overpassVerdict(403), 'endpoint-out');
  assert.equal(overpassVerdict(404), 'endpoint-out');
});

test('parseRetryAfter reads both shapes of the header', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('  30  ', now), 30_000);
  assert.equal(parseRetryAfter('Sun, 23 Aug 2026 12:01:00 GMT', now), 60_000);
  // A date already past is not a wait of minus a minute.
  assert.equal(parseRetryAfter('Sun, 23 Aug 2026 11:59:00 GMT', now), 0);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

test('backoffDelay grows, stays inside its window, and never reaches zero', () => {
  assert.equal(backoffDelay(0), 0);
  for (const [round, window] of [
    [1, 5000],
    [2, 10_000],
    [3, 20_000],
  ]) {
    for (const random of [() => 0, () => 0.5, () => 0.999]) {
      const wait = backoffDelay(round, { random });
      assert.ok(wait >= window / 2, `round ${round}: ${wait} ms is under half the window`);
      assert.ok(wait <= window, `round ${round}: ${wait} ms is over the window`);
    }
  }
  // The cap is what keeps a fourth round from being a quarter of an hour.
  assert.ok(backoffDelay(10, { random: () => 1 }) <= 60_000);
});

test('a busy mirror is stepped over and the next one answers', async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([reply(504), reply(200, OSM)]);
  const { body, endpoint } = await overpassFetch('q', {
    endpoints: [A, B],
    fetchImpl,
    now: clock.now,
    sleepImpl: clock.sleep,
    cooldowns: new Map(),
    hasPayload: (x) => x.includes('<node'),
  });
  assert.equal(body, OSM);
  assert.equal(endpoint, B);
  assert.deepEqual(fetchImpl.asked, ['a.example', 'b.example']);
});

test('a 200 with an apology inside counts as a failure, not as data', async () => {
  // Overpass answers a rate limit with HTTP 200 and a <remark> element. Taking
  // that at face value writes an empty extract and fails four stages later.
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([
    reply(200, '<osm><remark>runtime error: quota</remark></osm>'),
    reply(200, OSM),
  ]);
  const { endpoint } = await overpassFetch('q', {
    endpoints: [A, B],
    fetchImpl,
    now: clock.now,
    sleepImpl: clock.sleep,
    cooldowns: new Map(),
    hasPayload: (x) => x.includes('<node'),
  });
  assert.equal(endpoint, B);
});

test('the leading mirror rotates between rounds', async () => {
  // Otherwise the first entry in the list takes every first attempt from every
  // client, and the mirrors below it only see traffic once it is overloaded.
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([reply(504), reply(504), reply(200, OSM)]);
  const { endpoint } = await overpassFetch('q', {
    endpoints: [A, B],
    rounds: 2,
    fetchImpl,
    now: clock.now,
    sleepImpl: clock.sleep,
    cooldowns: new Map(),
  });
  // Round 0 leads with A, round 1 with B. Without the rotation the third
  // attempt would go back to A, and the busiest instance in the list would
  // take the first shot at every round of every client.
  assert.equal(endpoint, B);
  assert.deepEqual(fetchImpl.asked, ['a.example', 'b.example', 'b.example']);
});

test('an instance that asked to wait is left alone until it said so', async () => {
  const clock = fakeClock();
  const cooldowns = new Map();
  const opts = {
    endpoints: [A, B],
    rounds: 1,
    now: clock.now,
    sleepImpl: clock.sleep,
    cooldowns,
  };

  const first = scriptedFetch([reply(429, '', { 'retry-after': '120' }), reply(200, OSM)]);
  await overpassFetch('q', { ...opts, fetchImpl: first });
  assert.deepEqual(first.asked, ['a.example', 'b.example']);

  // Same process, next question — roads and rail are two calls, one job.
  clock.advance(60_000);
  const during = scriptedFetch([reply(200, OSM)]);
  await overpassFetch('q', { ...opts, fetchImpl: during });
  assert.deepEqual(during.asked, ['b.example'], 'A was asked again inside its own two minutes');

  clock.advance(61_000);
  const after = scriptedFetch([reply(200, OSM)]);
  await overpassFetch('q', { ...opts, fetchImpl: after });
  assert.deepEqual(after.asked, ['a.example'], 'A stayed shunned after its wait had run out');
});

test('a broken query stops at the first mirror instead of touring them all', async () => {
  const clock = fakeClock();
  const fetchImpl = scriptedFetch([reply(400, 'line 3: parse error')]);
  await assert.rejects(
    overpassFetch('bad', {
      endpoints: [A, B, C],
      rounds: 3,
      fetchImpl,
      now: clock.now,
      sleepImpl: clock.sleep,
      cooldowns: new Map(),
    }),
    /parse error/,
  );
  assert.deepEqual(fetchImpl.asked, ['a.example']);
});

test('the budget ends the loop instead of holding the caller for an hour', async () => {
  const clock = fakeClock();
  // Every attempt burns two minutes and fails, the way a hung mirror does.
  const fetchImpl = scriptedFetch([
    () => {
      clock.advance(120_000);
      return reply(504);
    },
  ]);
  await assert.rejects(
    overpassFetch('q', {
      endpoints: [A, B, C],
      rounds: 3,
      budgetMs: 300_000,
      fetchImpl,
      now: clock.now,
      sleepImpl: clock.sleep,
      cooldowns: new Map(),
    }),
    /budget of 300s spent/,
  );
  // Three rounds across three mirrors is nine attempts and eighteen minutes;
  // the budget stops it at two and a half.
  assert.ok(fetchImpl.asked.length < 9, `${fetchImpl.asked.length} attempts got through`);
});

test('a hung mirror does not swallow the budget the others needed', async () => {
  // The failure mode that matters is not a refusal but a silence: an instance
  // that accepts the connection and then says nothing. Given the whole
  // remaining budget it takes it, and the untried mirrors never get asked.
  //
  // Real timers here, at a scale of milliseconds rather than minutes — the
  // point being tested is the abort deadline the loop puts on each attempt,
  // and a fake clock cannot drive one.
  const silent = [];
  const fetchImpl = async (endpoint, init) => {
    silent.push(new URL(endpoint).host);
    return new Promise((_, reject) => {
      // Node unrefs the timer behind AbortSignal.timeout, so without something
      // ref'd here the loop empties and the test never gets its abort.
      const alive = setInterval(() => {}, 20);
      init.signal.addEventListener('abort', () => {
        clearInterval(alive);
        reject(Object.assign(new Error('aborted'), { cause: { code: 'TimeoutError' } }));
      });
    });
  };
  await assert.rejects(
    overpassFetch('q', {
      endpoints: [A, B, C],
      rounds: 1,
      budgetMs: 600,
      attemptTimeoutMs: 10_000,
      minAttemptMs: 50,
      fetchImpl,
      cooldowns: new Map(),
    }),
  );
  assert.deepEqual(silent, ['a.example', 'b.example', 'c.example']);
});

test('the failure names every mirror it tried and the proxy setting', async () => {
  // The commonest cause of "Overpass is down" on a developer machine is a
  // process started without HTTPS_PROXY, and the symptom is identical.
  const clock = fakeClock();
  await assert.rejects(
    overpassFetch('q', {
      endpoints: [A, B],
      rounds: 1,
      fetchImpl: scriptedFetch([reply(504)]),
      now: clock.now,
      sleepImpl: clock.sleep,
      cooldowns: new Map(),
    }),
    (err) => {
      assert.match(err.message, /all 2 Overpass endpoints failed/);
      assert.match(err.message, /a\.example/);
      assert.match(err.message, /b\.example/);
      assert.match(err.message, /proxy/);
      return true;
    },
  );
});
