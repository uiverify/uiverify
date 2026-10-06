import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Builds the package, runs the fixture suite in `e2e/fixture` against the build in real headless Chromium,
 * then checks the archive it wrote. This is the only test of the browser half (the setup hooks, the capture,
 * the browser commands), and running the build also catches a bundle that breaks only in the browser.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = path.join(packageDir, "node_modules/.bin/vitest");

interface RunResult {
  snapshots: Map<string, { dom: string; resources: Record<string, unknown> }>;
  failed: Map<string, string>;
  output: string;
  files: string[];
}

/** A real font file to serve, so the page loads it: the icon font Playwright ships. */
function findFont(): Buffer {
  const resolveFrom = (from: string, id: string) => createRequire(from).resolve(id);
  const playwright = resolveFrom(resolveFrom(path.join(packageDir, "package.json"), "@vitest/browser-playwright"), "playwright/package.json");
  const core = path.dirname(resolveFrom(playwright, "playwright-core/package.json"));
  const font = fs.readdirSync(core, { recursive: true, encoding: "utf8" }).find((file) => file.endsWith(".ttf"));
  if (!font) throw new Error("no .ttf in playwright-core");
  return fs.readFileSync(path.join(core, font));
}

let fontBytes: Buffer;
let assets: http.Server;
let origin: string;
const dirs: string[] = [];

/** Assets on another origin than the test page, served with no CORS headers (but the font). */
beforeAll(async () => {
  await promisify(execFile)(path.join(packageDir, "node_modules/.bin/tsup"), [], { cwd: packageDir });
  fontBytes = findFont();
  assets = http.createServer((req, res) => {
    if (req.url === "/icon.png" || req.url === "/frozen.png") {
      return void res.writeHead(200, { "content-type": "image/png" }).end("png-bytes");
    }
    if (req.url === "/font.css") {
      return void res
        .writeHead(200, { "content-type": "text/css" })
        .end(
          "@font-face{font-family:Brand;src:url(brand.ttf)}" +
            "@font-face{font-family:Brand;src:url(brand-cyrillic.ttf);unicode-range:U+0400-04FF}",
        );
    }
    // Fonts load in CORS mode, so like a font CDN this one allows any origin; the sheet naming it doesn't.
    if (req.url === "/brand.ttf") {
      return void res
        .writeHead(200, { "content-type": "font/ttf", "access-control-allow-origin": "*" })
        .end(fontBytes);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => assets.listen(0, "127.0.0.1", resolve));
  const address = assets.address();
  if (!address || typeof address === "string") throw new Error("asset server has no port");
  origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => assets.close(() => resolve()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function runFixture(args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-e2e-"));
  dirs.push(outDir);
  const report = path.join(outDir, "report.json");
  let output = "";
  try {
    const run = await promisify(execFile)(
      vitestBin,
      ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`, ...args],
      { cwd: fixture, env: { ...process.env, UIVERIFY_ARCHIVE_DIR: outDir, UIVERIFY_E2E_ASSETS: origin, ...env } },
    );
    output = run.stdout + run.stderr;
  } catch (err) {
    // The fixture has tests that fail on purpose, so the run exits non-zero.
    if (typeof err !== "object" || err === null || !("stdout" in err)) throw err;
    output = String(err.stdout) + String(Reflect.get(err, "stderr"));
  }
  const snapshots = new Map<string, { dom: string; resources: Record<string, unknown> }>();
  const snapshotDir = path.join(outDir, "snapshots");
  for (const file of fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : []) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, file), "utf8"));
    snapshots.set(snapshot.id, { dom: JSON.stringify(snapshot.dom), resources: snapshot.resources });
  }
  const failed = new Map<string, string>();
  const results = JSON.parse(fs.readFileSync(report, "utf8"));
  for (const file of results.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === "failed") failed.set(test.fullName, test.failureMessages.join("\n"));
    }
  }
  return { snapshots, failed, output, files: fs.readdirSync(outDir) };
}

describe("a browser-mode run", () => {
  let run: RunResult;
  beforeAll(async () => {
    run = await runFixture();
  }, 180_000);

  /** Catches the plugin inside a `projects` entry writing no module graph, so `--only-changed` saves
   *  nothing. */
  it("writes the module graph", () => {
    expect(run.files).toContain("preview-stats.json");
  });

  /** Catches the automatic snapshot running after a test file's cleanup `afterEach`, archiving an empty
   *  page. */
  it("captures the page before the test file's cleanup runs", () => {
    expect(run.snapshots.get("visual/hooks.capture.ts > cleaned up after")?.dom).toContain("rendered");
  });

  /** Catches an `afterEach` that takes its own snapshot gaining an extra automatic one, one that opts the
   *  test out being ignored, and a failed test's capture vanishing from the build. */
  it("lets afterEach hooks take their own snapshot or opt out, and captures a failed test", () => {
    const ids = [...run.snapshots.keys()].filter((id) => id.startsWith("visual/hooks.capture.ts > "));
    expect(ids.sort()).toEqual([
      "visual/hooks.capture.ts > cleaned up after",
      "visual/hooks.capture.ts > failing afterEach > fails after the body",
      "visual/hooks.capture.ts > fake timers > image under a frozen clock",
      "visual/hooks.capture.ts > snapshot in afterEach > settles in a hook",
    ]);
    expect(run.failed.has("failing afterEach fails after the body")).toBe(true);
  });

  /** Catches the capture reading Resource Timing through the fake `performance` `vi.useFakeTimers()`
   *  installs, which lists nothing, so no image or font was archived. */
  it("archives resources while fake timers are installed", () => {
    const id = "visual/hooks.capture.ts > fake timers > image under a frozen clock";
    expect(Object.keys(run.snapshots.get(id)?.resources ?? {})).toEqual([`${origin}/frozen.png`]);
  });

  /** Catches the second of two same-titled tests taking the first one's id when the first fails. */
  it("gives every snapshot its own id", () => {
    expect(run.snapshots.get("visual/ids.capture.ts > two snapshots")?.dom).toContain("one");
    expect(run.snapshots.get("visual/ids.capture.ts > two snapshots #2")?.dom).toContain("two");
    expect(run.snapshots.has("visual/ids.capture.ts > same title")).toBe(true);
    expect(run.snapshots.get("visual/ids.capture.ts > same title (2)")?.dom).toContain("second");
  });

  it("fails a test that doesn't await takeSnapshot(), in the test or in an afterEach", () => {
    expect(run.failed.get("not awaited")).toContain("takeSnapshot() call was not awaited");
    expect(run.failed.get("not awaited in afterEach left running")).toContain("takeSnapshot() call was not awaited");
  });

  /** Catches a passing test whose automatic capture failed going green with no snapshot, and a failed
   *  test's report gaining the capture error on top of its own failure. */
  it("fails a passing test whose capture failed, and leaves a failed test's report alone", () => {
    expect(run.failed.get("capture fails on a passing test")).toContain("capture broke");
    const failing = run.failed.get("capture fails on a failing test");
    expect(failing).toContain("the test's own failure");
    expect(failing).not.toContain("capture broke");
  });

  /** Catches a cross-origin image with no CORS headers replaying blank: the page can't read it. */
  it("archives a cross-origin image the page can't read", () => {
    expect(Object.keys(run.snapshots.get("visual/resources.capture.ts > cross-origin image without CORS")?.resources ?? {}))
      .toEqual([`${origin}/icon.png`]);
  });

  /** Catches a web font from a `<link>` without `crossorigin` replaying in a fallback font: Chromium hides
   *  what that sheet loads from Resource Timing. The sheet's cyrillic face fails to load (its file is
   *  missing), so it is neither archived nor warned about. */
  it("archives the fonts the page loaded from a cross-origin stylesheet, and not a face that failed", () => {
    const id = "visual/resources.capture.ts > web font from a cross-origin link without crossorigin";
    expect(Object.keys(run.snapshots.get(id)?.resources ?? {}).sort()).toEqual(
      [`${origin}/brand.ttf`, `${origin}/font.css`].sort(),
    );
    expect(run.output).not.toContain("brand-cyrillic");
  });

  it("warns about a resource it could not archive", () => {
    expect(run.output).toContain(`could not archive ${origin}/gone.png (HTTP 404)`);
  });

  it("warns about a blob: image it can no longer read", () => {
    expect(run.output).toMatch(/blob image revoked once it loaded": could not archive blob:/);
  });

  it("inlines a blob: image", () => {
    const dom = run.snapshots.get("visual/resources.capture.ts > blob image")?.dom ?? "";
    expect(dom).toContain("data:image/png;base64,");
    expect(dom).not.toContain("blob:");
  });
});

describe('a run with sequence.hooks: "list"', () => {
  /** Catches the hook placement assuming the default "stack" order, where the last-registered hook runs
   *  first. */
  it("still captures before the test file's cleanup", async () => {
    const run = await runFixture(["--sequence.hooks=list", "visual/hooks.capture.ts"]);
    expect(run.snapshots.get("visual/hooks.capture.ts > cleaned up after")?.dom).toContain("rendered");
  }, 180_000);
});

describe('a run with sequence.hooks: "parallel"', () => {
  /** Catches the setup-file hook, used where the capture can't run first, no longer capturing. */
  it("still captures each test", async () => {
    const run = await runFixture(["--sequence.hooks=parallel", "visual/hooks.capture.ts"]);
    expect(run.snapshots.has("visual/hooks.capture.ts > cleaned up after")).toBe(true);
  }, 180_000);
});

describe("a run with two browser projects capturing one file", () => {
  /** Catches the projects silently overwriting each other's captures in the shared archive folder. */
  it("warns that one capture per test is kept", async () => {
    const run = await runFixture(["visual/ids.capture.ts"], { UIVERIFY_E2E_SECOND_PROJECT: "1" });
    expect(run.output).toContain("browser projects into one archive folder");
  }, 180_000);
});
