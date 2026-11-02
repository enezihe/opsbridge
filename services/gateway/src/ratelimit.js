/** Fixed-window limiter, per key. In-memory by design: one gateway instance per replica, Redis when you need a global limit. */
export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return {
    take(key) {
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), retryAfterSeconds: Math.ceil((entry.resetAt - t) / 1000) };
    },
  };
}
