import { afterEach, describe, expect, it } from "vitest";
import { installSeededRandom, resetSeed } from "./seed";

const realRandom = Math.random;
afterEach(() => {
  Math.random = realRandom;
});

describe("seeded Math.random", () => {
  it("produces the same sequence after a reset, so each test is order-independent", () => {
    installSeededRandom();
    resetSeed();
    const first = [Math.random(), Math.random(), Math.random(), Math.random()];
    resetSeed();
    const second = [Math.random(), Math.random(), Math.random(), Math.random()];
    expect(second).toEqual(first);
  });

  it("is a real sequence, not a constant (a constant would collapse shuffles)", () => {
    installSeededRandom();
    resetSeed();
    const values = Array.from({ length: 8 }, () => Math.random());
    expect(new Set(values).size).toBeGreaterThan(1);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("resetSeed is a no-op before install, so it never touches a real Math.random", () => {
    resetSeed();
    expect(Math.random).toBe(realRandom);
  });
});
