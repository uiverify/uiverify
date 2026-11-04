/** How long a capture inside the test body may wait, for the network and then for a stable frame together:
 *  the test's `timeout` less the time since this attempt's setup began (so `beforeEach` time counts too, which
 *  only errs short) and a margin for the rest of the capture, so the waits never time a passing test out. No
 *  limit when the test has none. */
export function testWaitLimit(timeout: unknown, attemptStartedAt: number, now: number): number {
  if (typeof timeout !== "number" || timeout <= 0) return Number.POSITIVE_INFINITY;
  return timeout - (now - attemptStartedAt) - 3_000;
}

/** How long the setup-file hook's capture may wait, for the network and then for a stable frame together:
 *  the hook runs under `hookTimeout`, and settling and archiving need time after the wait (10 s, or two thirds
 *  of a shorter timeout). No limit when hooks have no timeout. */
export function hookWaitLimit(hookTimeout: unknown): number {
  if (typeof hookTimeout !== "number" || hookTimeout <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(hookTimeout - 10_000, hookTimeout / 3);
}
