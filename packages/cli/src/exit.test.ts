import { describe, expect, it } from "vitest";
import { exitCodeFor, previewExitCodeFor } from "./exit";

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

describe("previewExitCodeFor (uiverify check)", () => {
  // A preview check is not a gate: `changed` is the expected result the agent reviews, so it exits 0 —
  // unlike `exitCodeFor("changed")` which is 1. This is the whole behavioral difference between the two.
  it("does NOT gate on changed — it reports, the agent reviews over MCP", () => {
    expect(previewExitCodeFor("passed")).toBe(0);
    expect(previewExitCodeFor("changed")).toBe(0);
    expect(previewExitCodeFor(undefined)).toBe(0);
  });

  it("gates only on failed/blocked — the check couldn't give a clean answer", () => {
    expect(previewExitCodeFor("failed")).toBe(1);
    expect(previewExitCodeFor("blocked")).toBe(1);
  });
});
