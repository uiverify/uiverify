import { describe, it, expect } from "vitest";
import type { GraphModuleLike } from "./preview-stats";
import { buildStatsFromRun } from "./graph-reporter";

/** A minimal fake of the Vitest shape `buildStatsFromRun` reads: a project whose browser Vite server
 *  exposes a `client` environment module graph via `idToModuleMap.forEach`. */
function fakeProject(root: string, modules: { file: string; importers?: string[] }[], setupFiles: string[] = []) {
  const nodes: GraphModuleLike[] = modules.map((m) => ({
    file: m.file,
    id: m.file,
    importers: (m.importers ?? []).map((f) => ({ file: f, id: f })),
  }));
  return {
    browser: {
      vite: {
        config: { root },
        environments: {
          client: { moduleGraph: { idToModuleMap: { forEach: (cb: (m: GraphModuleLike) => void) => nodes.forEach(cb) } } },
        },
      },
    },
    config: { setupFiles },
    testFilesList: null as string[] | null,
  };
}

const byName = (stats: { modules: { name: string; reasons: { moduleName: string }[] }[] } | null) =>
  new Map((stats?.modules ?? []).map((m) => [m.name, m.reasons.map((r) => r.moduleName).sort()]));

describe("buildStatsFromRun", () => {
  it("reads the browser client module graph and emits root-relative reverse edges", () => {
    const project = fakeProject("/repo/app", [
      { file: "/repo/app/test/a.visual.test.tsx" },
      { file: "/repo/app/src/A.tsx", importers: ["/repo/app/test/a.visual.test.tsx"] },
    ]);
    const stats = byName(buildStatsFromRun({ projects: [project] }, undefined));
    expect(stats.get("src/A.tsx")).toEqual(["test/a.visual.test.tsx"]);
  });

  it("takes test files from the public testModules arg when testFilesList is null (the #2 regression)", () => {
    const project = fakeProject("/repo/app", [{ file: "/repo/app/test/a.visual.test.tsx" }], ["/repo/app/test/setup.ts"]);
    // Note the setup file is NOT a module-graph importer; its edges come only from the test-file list.
    const stats = byName(
      buildStatsFromRun({ projects: [project] }, [{ moduleId: "/repo/app/test/a.visual.test.tsx", project }]),
    );
    // Setup file got a synthetic edge to the test file — proving testModules populated `testFiles`
    // despite `testFilesList` being null.
    expect(stats.get("test/setup.ts")).toEqual(["test/a.visual.test.tsx"]);
  });

  it("relativizes each project against its OWN vite root and unions (the #5 fix)", () => {
    const a = fakeProject("/repo/appA", [{ file: "/repo/appA/src/Foo.tsx" }]);
    const b = fakeProject("/repo/appB", [{ file: "/repo/appB/src/Bar.tsx" }]);
    const names = (buildStatsFromRun({ projects: [a, b] }, undefined)?.modules ?? []).map((m) => m.name).sort();
    // Each is clean root-relative (no `../appB/...` leaking project A's root onto project B).
    expect(names).toEqual(["src/Bar.tsx", "src/Foo.tsx"]);
  });

  it("returns null when no project has a usable browser graph (safe full-render fallback)", () => {
    expect(buildStatsFromRun({ projects: [] }, undefined)).toBeNull();
    expect(buildStatsFromRun({ projects: [{ config: {}, testFilesList: null }] }, undefined)).toBeNull();
  });
});
