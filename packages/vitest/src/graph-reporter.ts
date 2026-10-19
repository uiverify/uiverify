import fs from "node:fs";
import path from "node:path";
import { type GraphModuleLike, buildPreviewStats } from "./preview-stats";
import { type GitState, type RunStats, checkSources, droppedTestsLine, readGitState } from "./source-check";

/**
 * A Vitest reporter that, at the end of a browser-mode run, serializes Vite's module graph into
 * `<outDir>/preview-stats.json` for UI Verify's skip-unchanged. It runs in the MAIN process (a reporter,
 * not a Vite plugin hook) because that is the only seam with a handle to every project's browser Vite
 * server — the browser server owns the module graph the tests actually loaded, and it's complete only
 * once the run has finished. `uiverifyPlugin()` registers this automatically.
 *
 * Each project is normalized against its OWN Vite root and its own test/setup files, then all projects'
 * stats are unioned — so a multi-project workspace doesn't relativize project B against project A's root,
 * and setup-file edges never cross projects. Before writing, `checkSources` drops each test the graph
 * can't trace to tracked source, so it always renders.
 *
 * Failure is non-fatal: a missing/odd graph, or no git to check it against, just means no stats file
 * ships, so the upload renders everything (the server bails to a full render with no graph) — never a
 * broken run.
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

/** Each browser project's graph from a finished run, plus every project's test and setup files; null when
 *  no browser project ran, and `unchecked` when one ran but can't be source-checked. Pure (no fs) so it can
 *  be unit-tested against a hand-built Vitest shape. */
export function buildStatsFromRun(
  vitest: VitestLike | undefined,
  testModules: readonly TestModuleLike[] | undefined,
): RunStats | "unchecked" | null {
  const projects = vitest?.projects ?? [];
  if (projects.length === 0) return null;

  const testFilesByProject = new Map<ProjectLike, string[]>();
  for (const tm of testModules ?? []) {
    if (!tm.project || !tm.moduleId) continue;
    const arr = testFilesByProject.get(tm.project) ?? [];
    arr.push(tm.moduleId);
    testFilesByProject.set(tm.project, arr);
  }

  const run: RunStats = { projects: [], testFiles: [], setupFiles: [] };
  for (const project of projects) {
    // Prefer the public per-run test list; union in the `@internal` fallback in case project identity
    // didn't line up. Either source alone is enough.
    const ran = testFilesByProject.get(project) ?? [];
    const testFiles = [...new Set([...ran, ...(project.testFilesList ?? [])])];
    const setupFiles = project.config?.setupFiles ?? [];
    run.testFiles.push(...testFiles);
    run.setupFiles.push(...setupFiles);
    const vite = project.browser?.vite;
    const viteRoot = vite?.config?.root;
    if (!vite || !viteRoot) continue; // a non-browser project has no archive to skip for
    const modules: GraphModuleLike[] = [];
    collectModules((vite.environments?.client?.moduleGraph ?? vite.moduleGraph)?.idToModuleMap, modules);
    if (modules.length === 0 && ran.length === 0) continue; // ran nothing this run
    // A project that ran tests but has no module graph, or has a graph but no listed tests, can't be
    // source-checked, and leaving it out isn't enough: its snapshots could still be located through another
    // project's same-path module. No graph, then.
    if (modules.length === 0 || testFiles.length === 0) return "unchecked";
    run.projects.push({ viteRoot, testFiles, stats: buildPreviewStats({ viteRoot, modules, setupFiles, testFiles }) });
  }
  return run.projects.length > 0 ? run : null;
}

export type GraphOutcome =
  | { kind: "written"; droppedLine: string | null }
  | { kind: "no-graph" }
  | { kind: "unchecked" }
  | { kind: "no-git" }
  | { kind: "collision"; path: string };

/** Write `preview-stats.json` for a finished run, or remove a stale one when this run ships no graph.
 *  `readGit` is the seam to git, so a test can drive the whole emit without a real repository. */
export function emitModuleGraph(
  outDir: string,
  vitest: VitestLike | undefined,
  testModules: readonly TestModuleLike[] | undefined,
  readGit: (cwd: string) => GitState | null = readGitState,
): GraphOutcome {
  const outcome = graphOutcome(outDir, vitest, testModules, readGit);
  if (outcome.kind !== "written") fs.rmSync(path.join(outDir, "preview-stats.json"), { force: true });
  return outcome;
}

function graphOutcome(
  outDir: string,
  vitest: VitestLike | undefined,
  testModules: readonly TestModuleLike[] | undefined,
  readGit: (cwd: string) => GitState | null,
): GraphOutcome {
  const run = buildStatsFromRun(vitest, testModules);
  if (run === "unchecked") return { kind: "unchecked" };
  const first = run?.projects[0];
  if (!run || !first) return { kind: "no-graph" };
  const git = readGit(first.viteRoot);
  if (!git) return { kind: "no-git" };
  const check = checkSources(run, git);
  if (!check.stats) return { kind: "collision", path: check.collision };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "preview-stats.json"), JSON.stringify(check.stats));
  return { kind: "written", droppedLine: droppedTestsLine(check) };
}

const graphReporterDirs = new WeakMap<object, string>();

export function graphReporter(outDir: string) {
  let vitest: VitestLike | undefined;
  let warnedNoGit = false;
  let warnedUnchecked = false;
  const reporter = {
    onInit(ctx: VitestLike) {
      vitest = ctx;
    },
    onTestRunEnd(testModules?: readonly TestModuleLike[]) {
      try {
        const outcome = emitModuleGraph(outDir, vitest, testModules);
        if (outcome.kind === "written" && outcome.droppedLine) console.log(outcome.droppedLine);
        if (outcome.kind === "collision") {
          console.warn(
            `[uiverify] no module graph written, so every test renders: ${outcome.path} always renders, but another module in the graph ends with the same path`,
          );
        }
        if (outcome.kind === "unchecked" && !warnedUnchecked) {
          warnedUnchecked = true;
          console.warn("[uiverify] no module graph written, so every test renders: Vitest didn't report both a browser project's tests and its imports");
        }
        if (outcome.kind === "no-git" && !warnedNoGit) {
          warnedNoGit = true;
          console.warn("[uiverify] no module graph written, so every test renders: git could not list this repository's files");
        }
      } catch (err) {
        // An earlier run's graph must not ship with this run's archive.
        fs.rmSync(path.join(outDir, "preview-stats.json"), { force: true });
        console.warn("[uiverify] could not write the module graph, so every test renders:", err);
      }
    },
  };
  graphReporterDirs.set(reporter, outDir);
  return reporter;
}

/** Vitest honours `reporters` only in the root config, so the one `uiverifyPlugin()` sets through its own
 *  config never runs when the plugin sits inside a `projects` entry, and no graph ships. `configureVitest`
 *  runs before Vitest builds the root reporters, so the plugin adds it there unless it's already present. */
export function ensureGraphReporter(vitest: { config: { reporters: unknown[] } }, outDir: string): void {
  const reporters = vitest.config.reporters;
  const present = reporters.some((r) => typeof r === "object" && r !== null && graphReporterDirs.get(r) === outDir);
  if (!present) reporters.push(graphReporter(outDir));
}
