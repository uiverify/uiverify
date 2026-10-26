import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSuite, parseNow, type SuiteOptions } from "./suite";

// defineSuite clears the archive of a direct run: point it somewhere disposable.
process.env.UIVERIFY_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), "uiverify-suite-test-"));
const declared = (() => {
  try {
    defineSuite<SuiteOptions>({ viewports: { "": { width: 10, height: 10 } } })("empty.visual.ts").test("t", () => {}, { viewports: {} });
    return undefined;
  } catch (error) {
    return error;
  }
})();

describe("parseNow", () => {
  /** Catches a date-time without an offset read in the machine's own zone, so a Mac and CI start apart. */
  test("reads a date-time as UTC unless it names an offset", () => {
    // In a zone away from UTC, so a parse in the machine's own zone would show.
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
    expect(parseNow("2026-05-12T09:30:00")).toBe(Date.UTC(2026, 4, 12, 9, 30));
    expect(parseNow("2026-05-12 09:30:00")).toBe(Date.UTC(2026, 4, 12, 9, 30));
    expect(parseNow("2026-05-12T09:30:00Z")).toBe(Date.UTC(2026, 4, 12, 9, 30));
    expect(parseNow("2026-05-12T09:30:00+02:00")).toBe(Date.UTC(2026, 4, 12, 7, 30));
    expect(parseNow("2026-05-12")).toBe(Date.UTC(2026, 4, 12));
    expect(() => parseNow("soon")).toThrow("is not a date");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("test()", () => {
  /** Catches a test with no viewports registering nothing, so it silently never runs. */
  test("refuses a test with no viewports", () => {
    expect(declared).toBeInstanceOf(Error);
    expect(String(declared)).toContain('"empty.visual.ts > t" has no viewports');
  });
});
