import { describe, expect, it } from "vitest";
import { exitCodeFor } from "./exit";

describe("exitCodeFor", () => {
  const gate = { exitZeroOnChanges: false };
  const soften = { exitZeroOnChanges: true };

  it("passes green: passed or an absent status exit 0", () => {
    expect(exitCodeFor("passed", gate)).toBe(0);
    expect(exitCodeFor(undefined, gate)).toBe(0);
    expect(exitCodeFor(undefined, soften)).toBe(0);
  });

  it("gates a changed verdict by default, softens it under --exit-zero-on-changes", () => {
    expect(exitCodeFor("changed", gate)).toBe(1);
    expect(exitCodeFor("changed", soften)).toBe(0);
  });

  it("always fails on failed and blocked — the flag never softens them", () => {
    expect(exitCodeFor("failed", gate)).toBe(1);
    expect(exitCodeFor("failed", soften)).toBe(1);
    expect(exitCodeFor("blocked", gate)).toBe(1);
    expect(exitCodeFor("blocked", soften)).toBe(1);
  });
});
