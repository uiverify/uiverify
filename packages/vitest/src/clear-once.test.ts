import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearOncePerRun } from "./clear-once";

const dirs: string[] = [];

/** An archive dir holding a previous run's output plus a file the user keeps there. */
function previousRun(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-plugin-"));
  dirs.push(dir);
  for (const sub of ["snapshots", "resources", "design"]) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, "snapshots", "deleted-test.json"), "{}");
  fs.writeFileSync(path.join(dir, "resources", "abc"), "x");
  fs.writeFileSync(path.join(dir, "index.json"), "{}");
  fs.writeFileSync(path.join(dir, "preview-stats.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("clearOncePerRun", () => {
  /** Catches a reused local archive dir carrying the last run's output into the next upload: snapshots of
   *  since-deleted tests (uploaded as stories) and resources nothing references. */
  it("removes the previous run's output and keeps the user's other files", () => {
    const dir = previousRun();
    clearOncePerRun({}, dir);
    expect(fs.readdirSync(dir)).toEqual(["notes.txt"]);
  });

  /** Catches a second project sharing the dir wiping snapshots the run has already written. */
  it("clears a dir only once per run", () => {
    const dir = previousRun();
    const run = {};
    clearOncePerRun(run, dir);
    fs.mkdirSync(path.join(dir, "snapshots"));
    fs.writeFileSync(path.join(dir, "snapshots", "this-run.json"), "{}");
    clearOncePerRun(run, dir);
    expect(fs.readdirSync(path.join(dir, "snapshots"))).toEqual(["this-run.json"]);
    clearOncePerRun({}, dir);
    expect(fs.existsSync(path.join(dir, "snapshots"))).toBe(false);
  });
});
