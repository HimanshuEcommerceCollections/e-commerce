import type { RequestHandler } from 'express';
import { failure } from '../common/api-response';

/**
 * Per-client-IP token bucket for the public auth endpoints — login and register
 * are otherwise unbounded brute-force targets. In-memory and per instance, with
 * an LRU bound so hostile traffic can't exhaust memory; move to a shared store
 * when scaling out.
 */
const MAX_TRACKED_CLIENTS = 10_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function authRateLimit(options: { enabled: boolean; capacity: number; refillPerMinute: number }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = options.refillPerMinute / 60_000;

  return (req, res, next) => {
    if (!options.enabled || !req.path.startsWith('/api/auth/')) {
      next();
      return;
    }
    // req.ip honours X-Forwarded-For only when 'trust proxy' is set
    // (SERVER_FORWARD_HEADERS_STRATEGY) — never parsed by hand here.
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();

    let bucket = buckets.get(key);
    if (bucket) {
      buckets.delete(key); // re-insert below: Map order doubles as LRU order
      bucket.tokens = Math.min(options.capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
      bucket.updatedAt = now;
    } else {
      bucket = { tokens: options.capacity, updatedAt: now };
    }
    buckets.set(key, bucket);
    if (buckets.size > MAX_TRACKED_CLIENTS) {
      buckets.delete(buckets.keys().next().value!);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
      return;
    }
    res.status(429).json(failure('Too many requests — try again shortly'));
  };
}
