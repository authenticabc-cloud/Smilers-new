/**
 * fetchWithRetryAfter
 * ------------------------------------------------------------------
 * A thin `fetch` wrapper that honors HTTP 429 `Retry-After` responses
 * from our backend rate limiter. When the server throttles a request it
 * returns `429` with a `Retry-After: <seconds>` header; instead of
 * failing immediately, this waits the indicated delay (capped) and
 * retries once, so a briefly-throttled request quietly resolves itself.
 *
 * Non-429 responses (including other errors) are returned unchanged so
 * each caller keeps its own error handling. If still 429 after the
 * retries, the final 429 response is returned for the caller to handle.
 */

export interface RetryAfterOptions {
  /** Max number of automatic retries on 429 (default 1). */
  maxRetries?: number;
  /** Upper bound on how long we'll wait for a single retry (ms, default 15s). */
  maxWaitMs?: number;
}

export async function fetchWithRetryAfter(
  input: string,
  init?: RequestInit,
  options: RetryAfterOptions = {},
): Promise<Response> {
  const { maxRetries = 1, maxWaitMs = 15000 } = options;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await fetch(input, init);
    if (resp.status !== 429 || attempt >= maxRetries) {
      return resp;
    }

    const header = resp.headers.get('retry-after');
    let waitMs = header ? parseInt(header, 10) * 1000 : 1000;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      waitMs = 1000;
    }
    waitMs = Math.min(waitMs, maxWaitMs);

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    attempt += 1;
  }
}
