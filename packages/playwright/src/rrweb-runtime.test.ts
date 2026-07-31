import { describe, it, expect } from "vitest";
import { rrwebRuntimeSource, RRWEB_GLOBAL } from "./rrweb-runtime";

describe("rrwebRuntimeSource", () => {
  it("reads the rrweb-snapshot UMD as injectable source that installs the expected global", () => {
    const src = rrwebRuntimeSource();
    expect(src.length).toBeGreaterThan(0);
    // The UMD we inject must expose the global the archiver serializes through.
    expect(src).toContain(RRWEB_GLOBAL);
  });

  it("caches the source (same string instance across calls)", () => {
    expect(rrwebRuntimeSource()).toBe(rrwebRuntimeSource());
  });
});
