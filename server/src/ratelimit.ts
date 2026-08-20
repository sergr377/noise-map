import type http from 'node:http';
import {
  RATE_LIMITS,
  RATE_LIMIT_LOOPBACK,
  STREAM_LIMIT_PER_IP,
  TRUST_PROXY,
  type LimitName,
} from './config.js';

export interface Verdict {
  ok: boolean;
  /** Bucket size, i.e. how much may be spent in one burst. */
  limit: number;
  remaining: number;
  /** Seconds until one token is back. Zero while the verdict is `ok`. */
  retryAfter: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  capacity: number;
  /** Tokens returned per second. */
  refill: number;
}

/**
 * One bucket per address per budget. In-process on purpose: the service runs as
 * a single container with a single calculation slot, so a shared store would add
 * a dependency without protecting anything that is not already protected.
 */
const buckets = new Map<string, Bucket>();

const UNLIMITED: Verdict = { ok: true, limit: 0, remaining: 0, retryAfter: 0 };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Address a request is charged to.
 *
 * `X-Forwarded-For` is only read when the deployment says it is behind a proxy:
 * the header costs nothing to forge, so honouring it on a directly reachable
 * server would turn the limiter off for anyone who bothers to send it. The first
 * entry is the client; the rest are the proxies it passed through.
 */
export function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function exempt(ip: string): boolean {
  return !RATE_LIMIT_LOOPBACK && LOOPBACK.has(ip);
}

/**
 * Spends one token from `name`'s bucket for this address.
 *
 * A token bucket rather than a fixed window because the traffic it meters is
 * bursty by nature: opening the page fires several requests at once, and a
 * window boundary would either reject that or allow twice the rate across it.
 */
export function take(name: LimitName, ip: string): Verdict {
  const limit = RATE_LIMITS[name];
  if (limit.capacity <= 0 || limit.perHour <= 0 || exempt(ip)) return UNLIMITED;

  const now = Date.now();
  const key = `${name}:${ip}`;
  const bucket = buckets.get(key) ?? {
    tokens: limit.capacity,
    updatedAt: now,
    capacity: limit.capacity,
    refill: limit.perHour / 3600,
  };

  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + ((now - bucket.updatedAt) / 1000) * bucket.refill,
  );
  bucket.updatedAt = now;
  buckets.set(key, bucket);

  if (bucket.tokens < 1) {
    return {
      ok: false,
      limit: bucket.capacity,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / bucket.refill)),
    };
  }

  bucket.tokens -= 1;
  return { ok: true, limit: bucket.capacity, remaining: Math.floor(bucket.tokens), retryAfter: 0 };
}

export interface StreamSlot {
  ok: boolean;
  /** How many this address may hold at once; zero when the check is off. */
  limit: number;
  /** How many it holds now, this one included when it was granted. */
  open: number;
  /** Hands the slot back. Safe to call more than once. */
  release: () => void;
}

/** Open progress streams per address. Counted, unlike the buckets, not spent. */
const streams = new Map<string, number>();

const noop = () => {};

/**
 * Takes one of this address's progress-stream slots, or refuses.
 *
 * The caller must release it when the connection ends — including when it ends
 * by the client vanishing, which is the whole point: a slot that is never given
 * back is a slot lost until the process restarts.
 */
export function openStream(ip: string): StreamSlot {
  if (STREAM_LIMIT_PER_IP <= 0 || exempt(ip)) {
    return { ok: true, limit: 0, open: 0, release: noop };
  }

  const open = streams.get(ip) ?? 0;
  if (open >= STREAM_LIMIT_PER_IP) {
    return { ok: false, limit: STREAM_LIMIT_PER_IP, open, release: noop };
  }
  streams.set(ip, open + 1);

  let released = false;
  return {
    ok: true,
    limit: STREAM_LIMIT_PER_IP,
    open: open + 1,
    release: () => {
      // The stream's own close path and the socket's `close` event both call
      // this, in either order, and a double release would free somebody else's
      // slot — the count is per address, not per connection.
      if (released) return;
      released = true;
      const left = (streams.get(ip) ?? 1) - 1;
      // Delete rather than keep a zero: the map is keyed by address and would
      // otherwise grow with every client ever seen.
      if (left > 0) streams.set(ip, left);
      else streams.delete(ip);
    },
  };
}

/** Standard advisory headers, so a client can back off before being refused. */
export function limitHeaders(verdict: Verdict): Record<string, string> {
  if (verdict.limit === 0) return {};
  return {
    'RateLimit-Limit': String(verdict.limit),
    'RateLimit-Remaining': String(verdict.remaining),
    ...(verdict.ok ? {} : { 'Retry-After': String(verdict.retryAfter) }),
  };
}

// A refilled bucket is indistinguishable from a client that never appeared, so
// dropping it is free. Without this the map would grow with every address seen.
const sweep = setInterval(
  () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      const refilled = bucket.tokens + ((now - bucket.updatedAt) / 1000) * bucket.refill;
      if (refilled >= bucket.capacity) buckets.delete(key);
    }
  },
  10 * 60_000,
);
sweep.unref();
