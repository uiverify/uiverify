import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type PreviewStats, toRepoRel, unionStats } from "./preview-stats";

/**
 * Checks each test's imports against git before the graph ships. UI Verify traces a changed git file up
 * the graph to the tests that import it, so a test is only safe to skip when its imports in the graph ARE
 * the files git changes. A test whose imports pass through files git doesn't track (a bundler's chunks,
 * as under Angular's unit-test builder, a workspace package's built `dist/`, gitignored codegen), or that
 * reaches no tracked source at all, would have a source edit map to no test and be carried forward. Such
 * a test is dropped from the graph: the server can't locate it, so it always renders.
 */

/** Stamped on every graph that went through this check, so the CLI can tell it from one an older SDK
 *  wrote without it. */
export const SOURCE_CHECKED_KEY = "uiverify";
export interface SourceCheckedMarker {
  sourceChecked: true;
}
export interface SourceCheckedStats extends PreviewStats {
  [SOURCE_CHECKED_KEY]: SourceCheckedMarker;
}

export interface ProjectStats {
  viteRoot: string;
  stats: PreviewStats;
  /** This project's test files (absolute): the ones a drop can apply to. */
  testFiles: string[];
}
export interface RunStats {
  projects: ProjectStats[];
  /** Every project's test and setup files (absolute). Reaching one is no evidence a test imports source. */
  testFiles: string[];
  setupFiles: string[];
}

export interface GitState {
  /** The repository's top level, as a real path. */
  root: string;
  /** Tracked files, relative to `root`, `/`-separated (`git ls-files`). */
  tracked: ReadonlySet<string>;
  /** Resolves symlinks in an absolute path; identity when omitted. */
  realpath?: (abs: string) => string;
}

export type SourceCheck =
  | {
      stats: SourceCheckedStats;
      /** Dropped tests whose imports pass through an untracked in-repo file. */
      throughUntracked: number;
      /** Dropped tests that reach no tracked source but no untracked file either. */
      withoutSource: number;
      /** One untracked in-repo file a test was dropped for, relative to the repo root. */
      example: string | null;
    }
  | { stats: null; collision: string };

type Kind = "outside" | "tracked" | "untracked";

export function checkSources(run: RunStats, git: GitState): SourceCheck {
  const realpath = git.realpath ?? ((p: string) => p);
  const notSource = new Set([...run.testFiles, ...run.setupFiles].map(realpath));
  let throughUntracked = 0;
  let withoutSource = 0;
  let example: string | null = null;
  const dropped: string[] = [];
  const kept: PreviewStats[] = [];

  for (const project of run.projects) {
    const located = new Map<string, { abs: string; rel: string | null }>();
    const locate = (name: string) => {
      let loc = located.get(name);
      if (!loc) {
        const abs = realpath(path.resolve(project.viteRoot, name));
        const r = path.relative(git.root, abs);
        const inRepo = r !== "" && r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
        loc = { abs, rel: inRepo ? r.split(path.sep).join("/") : null };
        located.set(name, loc);
      }
      return loc;
    };
    const kind = (name: string): Kind => {
      const { rel } = locate(name);
      if (rel === null) return "outside";
      return git.tracked.has(rel) ? "tracked" : "untracked";
    };

    const importers = new Map(project.stats.modules.map((m) => [m.name, m.reasons.map((r) => r.moduleName)]));
    const names = new Set([...importers.keys(), ...[...importers.values()].flat()]);
    const isSource = (n: string) => kind(n) === "tracked" && !notSource.has(locate(n).abs);
    const reachesSource = reachedFrom(importers, [...names].filter(isSource));
    const reachesUntracked = reachedFrom(importers, [...names].filter((n) => kind(n) === "untracked"));

    const drop = new Set<string>();
    for (const file of project.testFiles) {
      const test = toRepoRel(project.viteRoot, file);
      // A listed test that never loaded (a filtered, sharded or `--changed` run) wrote no snapshot.
      if (test === null || drop.has(test) || !importers.has(test)) continue;
      const untracked = reachesUntracked.get(test);
      if (untracked !== undefined) {
        throughUntracked++;
        example ??= locate(untracked).rel;
      } else if (!reachesSource.has(test)) {
        withoutSource++;
      } else {
        continue;
      }
      drop.add(test);
      dropped.push(test);
    }
    kept.push({
      modules: project.stats.modules
        .filter((m) => !drop.has(m.name))
        .map((m) => ({ name: m.name, reasons: m.reasons.filter((r) => !drop.has(r.moduleName)) })),
    });
  }

  const stats = unionStats(kept);
  const locatable = locatablePaths(stats);
  const collision = dropped.find((name) => locatable.has(stripDotSegments(name)));
  if (collision !== undefined) return { stats: null, collision };
  return {
    stats: { modules: stats.modules, [SOURCE_CHECKED_KEY]: { sourceChecked: true } },
    throughUntracked,
    withoutSource,
    example,
  };
}

/** The one line telling the user which tests always render and why, or null when none were dropped. */
export function droppedTestsLine(check: SourceCheck): string | null {
  if (!check.stats) return null;
  const { throughUntracked, withoutSource, example } = check;
  const count = `[uiverify] The tests in ${throughUntracked + withoutSource} file(s) always render`;
  if (throughUntracked === 0) return withoutSource === 0 ? null : `${count}: they import no tracked source file`;
  if (withoutSource === 0) return `${count}: their imports pass through files git doesn't track, e.g. ${example}`;
  return `${count}: they import files git doesn't track (e.g. ${example}) or no tracked source file`;
}

/** Every module that transitively imports one of `seeds` (or is one), mapped to a seed it reaches. One
 *  multi-source walk up the importer edges, so the whole graph is visited once rather than once per test. */
function reachedFrom(importers: ReadonlyMap<string, string[]>, seeds: string[]): Map<string, string> {
  const reached = new Map(seeds.map((s) => [s, s]));
  const queue = [...seeds];
  for (const name of queue) {
    const seed = reached.get(name) ?? name;
    for (const importer of importers.get(name) ?? []) {
      if (reached.has(importer)) continue;
      reached.set(importer, seed);
      queue.push(importer);
    }
  }
  return reached;
}

/** The server locates a test whose path equals a module name or ends one after a `/`, both with leading
 *  `./` and `../` segments removed. Every path some module locates, so a dropped test the union still
 *  locates (another project's same-named file) can be caught: the server would carry it forward. */
function locatablePaths(stats: PreviewStats): Set<string> {
  const paths = new Set<string>();
  for (const m of stats.modules) {
    const segments = stripDotSegments(m.name).split("/");
    for (let i = 0; i < segments.length; i++) paths.add(segments.slice(i).join("/"));
  }
  return paths;
}

function stripDotSegments(p: string): string {
  return p.replace(/^(?:\.\.?\/)+/, "");
}

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** `p` with symlinks resolved as far as it exists on disk, so a module path that was never written (a
 *  bundler's in-memory chunk) still compares against a real-path repository root. */
function realpathIfExists(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realpathIfExists(parent), path.basename(p));
  }
}

/** The repository `cwd` is in and its tracked files, or null when git is missing, `cwd` isn't in a
 *  repository, or git fails. */
export function readGitState(cwd: string): GitState | null {
  const git = (args: string[], dir: string) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    const root = realpathIfExists(git(["rev-parse", "--show-toplevel"], cwd).trim());
    const tracked = new Set(git(["ls-files", "-z"], root).split("\0").filter(Boolean));
    return { root, tracked, realpath: realpathIfExists };
  } catch {
    return null;
  }
}
