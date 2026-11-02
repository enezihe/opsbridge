const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter. `isRetryable` lets permanent failures skip straight to the DLQ. */
export async function withRetry(fn, { attempts = 4, baseMs = 200, maxMs = 5000, sleep = sleepMs, isRetryable = () => true, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) break;
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  lastError.attempts = lastError.attempts ?? attempts;
  throw lastError;
}
