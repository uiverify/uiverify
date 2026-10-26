import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath } from "./chrome";

describe("chromePath", () => {
  /** Catches the override losing to a Chrome found on PATH. */
  test("BUN_CHROME_PATH wins over a Chrome on PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "uiverify-chrome-"));
    const onPath = join(bin, "google-chrome");
    writeFileSync(onPath, "#!/bin/sh\n");
    chmodSync(onPath, 0o755);
    expect(chromePath({ PATH: bin })).toBe(onPath);
    expect(chromePath({ PATH: bin, BUN_CHROME_PATH: "/opt/my-chrome/chrome" })).toBe("/opt/my-chrome/chrome");
  });
});
