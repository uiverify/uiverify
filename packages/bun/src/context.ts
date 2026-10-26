import { AsyncLocalStorage } from "node:async_hooks";

/** Thrown by a call a test makes after it has timed out: bun:test can't cancel a test body, so a timed-out
 *  one keeps running alongside the next test, and must not touch that test's page. */
export class StaleTestError extends Error {
  constructor(what: string) {
    super(`@uiverify/bun: ${what} ran after its test ended (the test timed out, or a call wasn't awaited)`);
  }
}

/** The test a call belongs to: its page's generation when it started. */
export interface TestScope {
  generation: number;
}

/** The running test, carried through every `await` of its body. */
export const testScope = new AsyncLocalStorage<TestScope>();
