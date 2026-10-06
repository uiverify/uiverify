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
  specs?: { title: string; tests: { status: string; results: { errors: { message?: string }[] }[] }[] }[];
  suites?: ReportSuite[];
}

let snapshotTexts: Map<string, string>;
let outcomes: Map<string, string>;
let errors: Map<string, string>;

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
  const visit = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      const [test] = spec.tests;
      outcomes.set(spec.title, test?.status ?? "");
      const messages = test?.results.flatMap((result) => result.errors.map((error) => error.message ?? ""));
      errors.set(spec.title, messages?.join("\n") ?? "");
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of JSON.parse(report).suites) visit(suite);
  snapshotTexts = new Map();
  const dir = path.join(outDir, "snapshots");
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    snapshotTexts.set(snapshot.id, JSON.stringify(snapshot.dom));
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
