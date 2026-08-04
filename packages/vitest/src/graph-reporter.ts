import fs from "node:fs";
import path from "node:path";
import { type GraphModuleLike, type PreviewStats, buildPreviewStats } from "./preview-stats";

/**
 * A Vitest reporter that, at the end of a browser-mode run, serializes Vite's module graph into
 * `<outDir>/preview-stats.json` for UI Verify's skip-unchanged. It runs in the MAIN process (a reporter,
 * not a Vite plugin hook) because that is the only seam with a handle to every project's browser Vite
 * server — the browser server owns the module graph the tests actually loaded, and it's complete only
 * once the run has finished. `uiverifyPlugin()` registers this automatically.
 *
 * Each project is normalized against its OWN Vite root and its own test/setup files, then all projects'
 * stats are unioned — so a multi-project workspace doesn't relativize project B against project A's root,
 * and setup-file edges never cross projects.
 *
 * Failure is non-fatal: a missing/odd graph just means no stats file ships, so `--only-changed` falls
 * back to rendering everything (the server bails to a full render with no graph) — never a broken run.
 */

interface ModuleMapLike {
  forEach?(cb: (mod: GraphModuleLike) => void): void;
}
interface ModuleGraphLike {
  idToModuleMap?: ModuleMapLike;
}
interface ViteLike {
  config?: { root?: string };
  environments?: { client?: { moduleGraph?: ModuleGraphLike } };
  moduleGraph?: ModuleGraphLike;
}
interface ProjectLike {
  browser?: { vite?: ViteLike };
  config?: { setupFiles?: string[] };
  testFilesList?: string[] | null;
}
interface VitestLike {
  projects?: ProjectLike[];
}
/** The public `TestModule` shape a reporter's `onTestRunEnd` receives — `moduleId` is the test file, and
 *  `project` ties it to one of `vitest.projects`. Preferred over the `@internal` `project.testFilesList`,
 *  which is reset to null on watch reruns. */
interface TestModuleLike {
  moduleId?: string;
  project?: ProjectLike;
}

function collectModules(map: ModuleMapLike | undefined, out: GraphModuleLike[]): void {
  if (typeof map?.forEach !== "function") return;
  map.forEach((mod) => out.push(mod));
}

/** Build the unioned `preview-stats.json` payload from a finished run, or null when no browser project
 *  had a usable graph. Pure (no fs) so it can be unit-tested against a hand-built Vitest shape. */
export function buildStatsFromRun(
  vitest: VitestLike | undefined,
  testModules: readonly TestModuleLike[] | undefined,
): PreviewStats | null {
  const projects = vitest?.projects ?? [];
  if (projects.length === 0) return null;

  const testFilesByProject = new Map<ProjectLike, string[]>();
  for (const tm of testModules ?? []) {
    if (!tm.project || !tm.moduleId) continue;
    const arr = testFilesByProject.get(tm.project) ?? [];
    arr.push(tm.moduleId);
    testFilesByProject.set(tm.project, arr);
  }

  const reasonsByName = new Map<string, Set<string>>();
  let any = false;
  for (const project of projects) {
    const vite = project.browser?.vite;
    const viteRoot = vite?.config?.root;
    if (!vite || !viteRoot) continue; // a non-browser project has no archive to skip for
    const modules: GraphModuleLike[] = [];
    collectModules((vite.environments?.client?.moduleGraph ?? vite.moduleGraph)?.idToModuleMap, modules);
    if (modules.length === 0) continue;
    // Prefer the public per-run test list; union in the `@internal` fallback in case project identity
    // didn't line up. Either source alone is enough.
    const testFiles = [...new Set([...(testFilesByProject.get(project) ?? []), ...(project.testFilesList ?? [])])];
    const stats = buildPreviewStats({ viteRoot, modules, setupFiles: project.config?.setupFiles ?? [], testFiles });
    for (const m of stats.modules) {
      let set = reasonsByName.get(m.name);
      if (!set) reasonsByName.set(m.name, (set = new Set()));
      for (const r of m.reasons) set.add(r.moduleName);
    }
    any = true;
  }
  if (!any) return null;
  return {
    modules: [...reasonsByName].map(([name, reasons]) => ({
      name,
      reasons: [...reasons].map((moduleName) => ({ moduleName })),
    })),
  };
}

export function emitModuleGraph(
  outDir: string,
  vitest: VitestLike | undefined,
  testModules: readonly TestModuleLike[] | undefined,
): boolean {
  const stats = buildStatsFromRun(vitest, testModules);
  if (!stats) return false;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "preview-stats.json"), JSON.stringify(stats));
  return true;
}

export function graphReporter(outDir: string) {
  let vitest: VitestLike | undefined;
  return {
    onInit(ctx: VitestLike) {
      vitest = ctx;
    },
    onTestRunEnd(testModules?: readonly TestModuleLike[]) {
      try {
        emitModuleGraph(outDir, vitest, testModules);
      } catch (err) {
        console.warn("[uiverify] could not emit the module graph for --only-changed:", err);
      }
    },
  };
}
