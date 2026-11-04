import { describe, expect, it } from "vitest";
import { hookWaitLimit, testWaitLimit } from "./wait-limit";

describe("testWaitLimit", () => {
  /** Catches a `takeSnapshot()` late in a test waiting past the test's own timeout. */
  it("leaves the rest of the test's timeout, less a margin", () => {
    expect(testWaitLimit(15_000, 1_000, 11_000)).toBe(2_000);
    expect(testWaitLimit(15_000, 1_000, 14_000)).toBeLessThan(0);
  });

  it("doesn't limit a test with no timeout", () => {
    expect(testWaitLimit(0, 0, 100)).toBe(Number.POSITIVE_INFINITY);
    expect(testWaitLimit(undefined, 0, 100)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("hookWaitLimit", () => {
  /** Catches the setup-file hook's wait taking a short hookTimeout's whole budget. */
  it("leaves the hook room to settle and archive", () => {
    expect(hookWaitLimit(30_000)).toBe(20_000);
    expect(hookWaitLimit(9_000)).toBe(3_000);
    expect(hookWaitLimit(0)).toBe(Number.POSITIVE_INFINITY);
  });
});
