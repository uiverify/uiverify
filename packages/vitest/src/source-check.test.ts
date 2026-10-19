import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PreviewStats } from "./preview-stats";
import { type GitState, type ProjectStats, checkSources, droppedTestsLine, readGitState } from "./source-check";

/** A graph from `{ name: importers }`, names relative to the Vite root like the emitted file's. */
function graph(edges: Record<string, string[]>): PreviewStats {
  return {
    modules: Object.entries(edges).map(([name, reasons]) => ({ name, reasons: reasons.map((moduleName) => ({ moduleName })) })),
  };
}

function project(viteRoot: string, edges: Record<string, string[]>, tests: string[]): ProjectStats {
  return { viteRoot, stats: graph(edges), testFiles: tests.map((t) => path.join(viteRoot, t)) };
}

function git(tracked: string[]): GitState {
  return { root: "/repo", tracked: new Set(tracked) };
}

const names = (stats: PreviewStats | null) => (stats?.modules ?? []).map((m) => m.name).sort();
const importersOf = (stats: PreviewStats | null, name: string) =>
  stats?.modules.find((m) => m.name === name)?.reasons.map((r) => r.moduleName).sort();

describe("checkSources", () => {
  /** Catches a bundled spec graph (only chunks between the specs and the components) shipping as if it
   *  traced source edits: every test would be carried forward when a component changes. */
  it("drops every test of an Angular unit-test graph, and still ships the marked graph", () => {
    const specs = ["src/app/app.spec.ts", "src/app/order-summary/order-summary.spec.ts"];
    const p = project(
      "/repo",
      {
        "init-compiler.js": specs,
        "init-testbed.js": specs,
        "chunk-CGZBV6BD.js": specs,
        "vitest-mock-patch.js": specs,
        "src/app/app.spec.ts": [],
        "src/app/order-summary/order-summary.spec.ts": [],
      },
      specs,
    );
    const check = checkSources(
      { projects: [p], testFiles: p.testFiles, setupFiles: [] },
      git([...specs, "src/app/app.ts", "src/app/order-summary/order-summary.ts"]),
    );
    expect(check.stats?.uiverify).toEqual({ sourceChecked: true });
    expect(names(check.stats)).toEqual(["chunk-CGZBV6BD.js", "init-compiler.js", "init-testbed.js", "vitest-mock-patch.js"]);
    expect(importersOf(check.stats, "init-compiler.js")).toEqual([]);
    expect(droppedTestsLine(check)).toBe(
      "[uiverify] The tests in 2 file(s) always render: their imports pass through files git doesn't track, e.g. init-compiler.js",
    );
  });

  /** Would catch: a filtered or sharded run (Vitest lists every test file it globbed, not just the ones
   *  that ran) reporting the tests it didn't run as "always render", and feeding them to the collision
   *  check as if they were dropped. */
  it("ignores listed tests that never loaded", () => {
    const edges = { "src/a.test.tsx": [], "src/A.tsx": ["src/a.test.tsx"] };
    const p = project("/repo/app", edges, ["src/a.test.tsx", "src/b.test.tsx"]);
    const check = checkSources({ projects: [p], testFiles: p.testFiles, setupFiles: [] }, git(["app/src/a.test.tsx", "app/src/A.tsx"]));
    expect(names(check.stats)).toEqual(["src/A.tsx", "src/a.test.tsx"]);
    expect(droppedTestsLine(check)).toBeNull();
  });

  it("keeps every test of a graph made of tracked source, changing nothing but the marker", () => {
    const edges = { "src/a.test.tsx": [], "src/A.tsx": ["src/a.test.tsx"], "src/util.ts": ["src/A.tsx"] };
    const p = project("/repo/app", edges, ["src/a.test.tsx"]);
    const check = checkSources(
      { projects: [p], testFiles: p.testFiles, setupFiles: [] },
      git(["app/src/a.test.tsx", "app/src/A.tsx", "app/src/util.ts"]),
    );
    expect(check.stats).toEqual({ ...graph(edges), uiverify: { sourceChecked: true } });
    expect(droppedTestsLine(check)).toBeNull();
  });

  /** Catches a test whose imports reach a workspace package's build output being kept: an edit to that
   *  package's source would trace to no test. */
  it("drops a test that imports a workspace package's dist, and keeps the others", () => {
    const p = project(
      "/repo/apps/web",
      {
        "src/a.test.tsx": [],
        "src/b.test.tsx": [],
        "src/A.tsx": ["src/a.test.tsx"],
        "src/B.tsx": ["src/b.test.tsx"],
        "../../packages/ui/dist/index.js": ["src/A.tsx"],
      },
      ["src/a.test.tsx", "src/b.test.tsx"],
    );
    const check = checkSources(
      { projects: [p], testFiles: p.testFiles, setupFiles: [] },
      git(["apps/web/src/a.test.tsx", "apps/web/src/b.test.tsx", "apps/web/src/A.tsx", "apps/web/src/B.tsx", "packages/ui/src/index.ts"]),
    );
    expect(names(check.stats)).toEqual(["../../packages/ui/dist/index.js", "src/A.tsx", "src/B.tsx", "src/b.test.tsx"]);
    expect(importersOf(check.stats, "src/A.tsx")).toEqual([]);
    expect(importersOf(check.stats, "src/B.tsx")).toEqual(["src/b.test.tsx"]);
    expect(droppedTestsLine(check)).toBe(
      "[uiverify] The tests in 1 file(s) always render: their imports pass through files git doesn't track, e.g. packages/ui/dist/index.js",
    );
  });

  /** Catches a test whose only imports are other tests and setup files counting those as its source. */
  it("drops a test that imports only test and setup files", () => {
    const p = project(
      "/repo",
      {
        "test/a.test.ts": [],
        "test/b.test.ts": ["test/a.test.ts"],
        "test/c.test.ts": [],
        "test/setup.ts": ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
        "src/C.tsx": ["test/c.test.ts"],
      },
      ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    );
    const check = checkSources(
      { projects: [p], testFiles: p.testFiles, setupFiles: ["/repo/test/setup.ts"] },
      git(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/setup.ts", "src/C.tsx"]),
    );
    expect(names(check.stats)).toEqual(["src/C.tsx", "test/c.test.ts", "test/setup.ts"]);
    expect(importersOf(check.stats, "test/setup.ts")).toEqual(["test/c.test.ts"]);
    expect(droppedTestsLine(check)).toBe("[uiverify] The tests in 2 file(s) always render: they import no tracked source file");
  });

  /** Catches a dropped test shipping a graph in which another project's file of the same path still
   *  locates it, so it would be carried forward anyway. */
  it("ships no graph when a dropped test's path is still located through another project", () => {
    const kept = project("/repo/one", { "src/a.test.ts": [], "src/A.ts": ["src/a.test.ts"] }, ["src/a.test.ts"]);
    const dropped = project("/repo/two", { "src/a.test.ts": [] }, ["src/a.test.ts"]);
    const check = checkSources(
      { projects: [kept, dropped], testFiles: [...kept.testFiles, ...dropped.testFiles], setupFiles: [] },
      git(["one/src/a.test.ts", "one/src/A.ts", "two/src/a.test.ts"]),
    );
    expect(check).toEqual({ stats: null, collision: "src/a.test.ts" });
  });

  it("ignores a module outside the repository", () => {
    const p = project(
      "/repo/app",
      { "src/a.test.ts": [], "src/A.ts": ["src/a.test.ts"], "../../elsewhere/lib.js": ["src/A.ts"] },
      ["src/a.test.ts"],
    );
    const check = checkSources(
      { projects: [p], testFiles: p.testFiles, setupFiles: [] },
      git(["app/src/a.test.ts", "app/src/A.ts"]),
    );
    expect(names(check.stats)).toContain("src/a.test.ts");
    expect(droppedTestsLine(check)).toBeNull();
  });
});

describe("readGitState", () => {
  /** Catches the I/O wrapper misreading git: a tracked file read as untracked (or the reverse), or a
   *  symlinked temp dir (`/var` → `/private/var`) putting every module outside the repository. */
  it("classifies a real repository's tracked and untracked files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-git-"));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/A.ts"), "");
      fs.writeFileSync(path.join(dir, "src/a.test.ts"), "");
      fs.writeFileSync(path.join(dir, "src/b.test.ts"), "");
      const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      run(["init", "-q"]);
      run(["add", "src"]);
      run(["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
      fs.writeFileSync(path.join(dir, "chunk-x.js"), "");

      const state = readGitState(dir);
      expect(state?.root).toBe(fs.realpathSync(dir));
      const p = project(
        dir,
        {
          "src/a.test.ts": [],
          "src/b.test.ts": [],
          "src/A.ts": ["src/a.test.ts", "src/b.test.ts"],
          "chunk-x.js": ["src/b.test.ts"],
        },
        ["src/a.test.ts", "src/b.test.ts"],
      );
      const check = state && checkSources({ projects: [p], testFiles: p.testFiles, setupFiles: [] }, state);
      expect(names(check?.stats ?? null)).toEqual(["chunk-x.js", "src/A.ts", "src/a.test.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null outside a repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-nogit-"));
    try {
      expect(readGitState(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
