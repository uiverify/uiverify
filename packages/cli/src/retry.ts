import { redact } from "./redact";

/**
 * HTTP error carrying the response status, so retry logic can tell a retryable 5xx from a
 * deterministic 4xx.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_DELAYS_MS = [1_000, 3_000, 8_000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Spread each backoff to 75–125% of its base so a fleet of CI jobs retrying against a briefly-stalled
// serverless instance doesn't re-hit it in lockstep (thundering herd) — keeps the exponential shape.
const jitter = (ms: number): number => Math.round(ms * (0.75 + Math.random() * 0.5));

function isRetryable(err: unknown): boolean {
  // A status error is retryable only for the transient classes; anything else reaching here is a
  // transport-level failure (network error or this attempt's timeout) and is safe to retry.
  if (err instanceof HttpStatusError) return RETRYABLE_STATUS.has(err.status);
  return true;
}

export interface RetryOptions {
  /** Identifies the call in the per-attempt warning log. */
  label: string;
  /** Per-attempt deadline; passed as the AbortSignal so a hung request can't outlive it. Default 45s. */
  attemptTimeoutMs?: number;
  /** Backoff before each retry; its length sets the retry count (so N delays ⇒ N+1 attempts). */
  delaysMs?: number[];
}

/**
 * Run one network attempt with a per-attempt timeout, retrying transport failures and retryable 5xx
 * (never 4xx) with backoff. A cold or transiently stuck serverless instance can stall a request to
 * the gateway's invocation limit; a retry simply lands on a healthy instance instead of failing the run.
 */
export async function withRetry<T>(opts: RetryOptions, attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const timeout = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await attempt(AbortSignal.timeout(timeout));
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === delays.length) break;
      // Redacted: this is an arbitrary error string (often a server response body), and it is the one
      // log line in the CLI that doesn't go through the caller's `log`/`softFail` funnel.
      const reason = redact(err instanceof Error ? err.message : String(err));
      const delay = jitter(delays[i]);
      console.warn(`[uiverify] ${opts.label} failed (${reason}); retry ${i + 1}/${delays.length} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
