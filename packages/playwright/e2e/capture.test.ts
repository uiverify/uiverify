import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Builds the package and runs the Playwright suite in `e2e/fixture` against the build, then checks which
 * tests' snapshots reached the archive and how each test ended.
 */

const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(packageDir, "e2e/fixture");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-playwright-e2e-"));

/** The part of Playwright's JSON report read here. */
interface ReportSuite {
  specs?: {
    title: string;
    tests: {
      status: string;
      results: { duration: number; errors: { message?: string }[]; stderr: { text?: string }[] }[];
    }[];
  }[];
  suites?: ReportSuite[];
}

let snapshotTexts: Map<string, string>;
let resourceUrls: Map<string, string[]>;
let sourcePaths: Map<string, string>;
let outcomes: Map<string, string>;
let errors: Map<string, string>;
let stderrs: Map<string, string>;
let durations: Map<string, number>;

beforeAll(async () => {
  await promisify(execFile)(path.join(packageDir, "node_modules/.bin/tsup"), [], { cwd: packageDir });
  let report = "";
  try {
    report = (
      await promisify(execFile)(path.join(packageDir, "node_modules/.bin/playwright"), ["test"], {
        cwd: fixture,
        env: { ...process.env, UIVERIFY_ARCHIVE_DIR: outDir, PLAYWRIGHT_E2E_OUTPUT: path.join(outDir, "results") },
      })
    ).stdout;
  } catch (err) {
    // Tests in the fixture fail on purpose, so the run exits non-zero.
    if (typeof err !== "object" || err === null || !("stdout" in err)) throw err;
    report = String(err.stdout);
  }
  outcomes = new Map();
  errors = new Map();
  stderrs = new Map();
  durations = new Map();
  const visit = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      const [test] = spec.tests;
      outcomes.set(spec.title, test?.status ?? "");
      const messages = test?.results.flatMap((result) => result.errors.map((error) => error.message ?? ""));
      errors.set(spec.title, messages?.join("\n") ?? "");
      durations.set(spec.title, test?.results.reduce((sum, result) => sum + result.duration, 0) ?? 0);
      stderrs.set(spec.title, test?.results.flatMap((result) => result.stderr.map((line) => line.text ?? "")).join("") ?? "");
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of JSON.parse(report).suites) visit(suite);
  snapshotTexts = new Map();
  resourceUrls = new Map();
  sourcePaths = new Map();
  const dir = path.join(outDir, "snapshots");
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    snapshotTexts.set(snapshot.id, JSON.stringify(snapshot.dom));
    resourceUrls.set(snapshot.id, Object.keys(snapshot.resources ?? {}));
    sourcePaths.set(snapshot.id, snapshot.sourcePath);
  }
}, 180_000);

afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

describe("the automatic snapshot", () => {
  it("captures a passing test", () => {
    expect(snapshotTexts.get("capture.spec.ts > passes")).toContain("passed");
  });

  /** Catches a failed test's snapshot vanishing from the build, which hides that its UI changed. */
  it("captures a test that fails an assertion", () => {
    expect(snapshotTexts.get("capture.spec.ts > fails an assertion")).toContain("broken");
  });

  /** Catches the teardown hanging on a stuck page: a timed-out test is not captured. */
  it("skips a test that timed out", () => {
    expect(snapshotTexts.has("capture.spec.ts > times out")).toBe(false);
    expect(outcomes.get("times out")).toBe("unexpected");
  });

  /** Catches a capture error on a page the test closed turning an expected failure into a reported one. */
  it("leaves a capture error out of an expected failure", () => {
    expect(outcomes.get("expected to fail with its page closed")).toBe("expected");
    expect(errors.get("expected to fail with its page closed")).not.toContain("closed");
  });
});

/** Catches a hand-written module graph being unable to locate a test: the server finds each test's spec
 *  through `sourcePath`, and without it every test renders whatever the graph says. */
it("records each snapshot's spec file, relative to the Playwright config", () => {
  expect(sourcePaths.get("capture.spec.ts > passes")).toBe("tests/capture.spec.ts");
});

describe("the stable frame", () => {
  /** Catches a below-the-fold `loading="lazy"` image the test never scrolled to being left out of the
   *  archive, so it replays as a broken image. */
  it("archives a lazy image below the fold", () => {
    expect(resourceUrls.get("stable-frame.spec.ts > lazy image below the fold")).toContain("https://assets.test/below.png");
  });

  /** Catches the opt-out skipping the image wait too: a missing image is never the frame anyone wanted. */
  it("archives a lazy image below the fold with waitForStableFrame off", () => {
    expect(resourceUrls.get("stable-frame.spec.ts > lazy image below the fold, captured right now")).toContain(
      "https://assets.test/right-now.png",
    );
  });

  /** Catches a capture that doesn't wait for a requestAnimationFrame animation, archiving a frame mid-tween. */
  it("archives a finite animation's last frame", () => {
    expect(snapshotTexts.get("stable-frame.spec.ts > finite animation")).toContain("done");
  });

  /** Catches the page script not being installed before the page's own scripts: a loop that saved
   *  requestAnimationFrame at load (framer-motion's does) would schedule frames the probe never sees. */
  it("archives a finite animation's last frame through a saved requestAnimationFrame", () => {
    expect(snapshotTexts.get("stable-frame.spec.ts > finite animation through a saved requestAnimationFrame")).toContain(
      "done",
    );
  });

  /** Catches the page script evaluated late (a `setContent` page never gets the init script) not waiting. */
  it("archives a finite animation's last frame on a page set by content", () => {
    expect(snapshotTexts.get("stable-frame.spec.ts > finite animation, page set by content")).toContain("done");
  });

  /** Catches the wait being skipped under Playwright's clock: `setFixedTime` and `install` keep it running,
   *  with its own requestAnimationFrame, so the animation still plays and would be archived mid-tween. */
  it("archives a finite animation's last frame under a running Playwright clock", () => {
    expect(snapshotTexts.get("stable-frame.spec.ts > finite animation under a running clock")).toContain("done");
  });

  /** Catches the page script not wrapping again the requestAnimationFrame Playwright's clock put in place
   *  after the page loaded: the animation it drives would be archived mid-tween. */
  it("archives a finite animation's last frame under a clock installed after the page loaded", () => {
    expect(
      snapshotTexts.get("stable-frame.spec.ts > finite animation under a clock installed after the page loaded"),
    ).toContain("done");
  });

  /** Catches a snapshot leaving the live page changed: the rest of the test would see `loading="eager"`. The
   *  archive itself keeps `eager`, so it doesn't depend on which images had loaded in time. */
  it("puts a lazy image's loading attribute back after the snapshot, and archives it eager", () => {
    expect(outcomes.get("lazy image restored after a snapshot")).toBe("expected");
    expect(snapshotTexts.get("stable-frame.spec.ts > lazy image restored after a snapshot::mid-test")).toContain(
      '"loading":"eager"',
    );
  });

  /** Catches the opt-out still waiting, so a test can't capture the page as it is right now. */
  it("captures mid-animation with waitForStableFrame off", () => {
    const dom = snapshotTexts.get("stable-frame.spec.ts > finite animation, captured right now");
    expect(dom).toContain("frame");
    expect(dom).not.toContain("done");
  });

  /** Catches the waits running on Playwright's paused clock, which never advances, in a document that got
   *  the page script late or after the clock: the snapshot would hang until the archiver's own backstop
   *  (15 s) or the test timeout. */
  it("captures under a paused Playwright clock without waiting it out", () => {
    for (const title of ["paused clock, page set by content", "paused clock, page navigated"]) {
      expect(outcomes.get(title)).toBe("expected");
      expect(snapshotTexts.has(`stable-frame.spec.ts > ${title}`)).toBe(true);
      expect(durations.get(title)).toBeLessThan(10_000);
    }
  });

  /** Catches the wait hanging on an animation that never ends: the capture must give up and say why. */
  it("captures an endless animation at the deadline, and warns", () => {
    expect(snapshotTexts.get("stable-frame.spec.ts > endless animation")).toContain("frame");
    expect(outcomes.get("endless animation")).toBe("expected");
    expect(stderrs.get("endless animation")).toContain('"stable-frame.spec.ts > endless animation" was still animating');
  });

  /** Catches the wait ignoring the test's timeout: five snapshots of an endless animation at the full 4 s each
   *  would time out a 15 s test that passes without the wait. */
  it("keeps several snapshots of an endless animation within the test's timeout", () => {
    expect(outcomes.get("endless animation, several snapshots")).toBe("expected");
    expect(snapshotTexts.has("stable-frame.spec.ts > endless animation, several snapshots::five")).toBe(true);
  });
});
