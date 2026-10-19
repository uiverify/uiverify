import path from "node:path";

/**
 * Build a Storybook-`preview-stats.json`-shaped module graph from Vite's browser-mode module graph, so
 * UI Verify's skip-unchanged can trace a changed source file to the test files it
 * affects — exactly as it does from a Storybook `--stats-json` bundle. The server reuses its Storybook
 * graph tier verbatim; this just fills the slot an archive normally leaves empty.
 *
 * The emitted shape is `{ modules: [{ name, reasons: [{ moduleName }] }] }`, where `reasons` are the
 * REVERSE edges — each module's importers — which the server BFS-walks upward from a changed file to the
 * test modules that transitively import it.
 *
 * Two normalizations make the emitted `name`s line up with the server's inputs:
 *  - **Vite-root-relative paths.** Vite module ids are absolute and carry `?v=`/`?import` queries; we
 *    reduce each to a path relative to the Vite root, the same convention `sourcePath` (a test file's
 *    `task.file.name`) already uses and the same shape a Storybook stats `name` has. The server's
 *    `stripDotSegments`/`suffixMatch` then bridge both to the git-root-relative delta.
 *  - **Repo-source only.** `node_modules` and virtual/unresolved modules are dropped: they never appear
 *    in a git delta. They can sit between a repo file and the test that imports it, so an edge is walked
 *    through them to the next repo file rather than lost with them.
 */

export interface PreviewStatsModule {
  name: string;
  reasons: { moduleName: string }[];
}
export interface PreviewStats {
  modules: PreviewStatsModule[];
}

/** The minimal shape we read off a Vite `EnvironmentModuleNode` (Vite 6+) or legacy `ModuleNode`. */
export interface GraphModuleLike {
  id?: string | null;
  file?: string | null;
  importers?: Iterable<GraphModuleLike>;
}

export interface BuildPreviewStatsInput {
  /** The Vite root every module path is relativized against (`server.config.root`). */
  viteRoot: string;
  /** Every module node, unioned across all browser servers of the run. */
  modules: Iterable<GraphModuleLike>;
  /** Resolved setup-file paths (absolute). Setup files do NOT appear as module-graph importers, so each
   *  repo-source setup file is emitted with synthetic importers = every test file, so that changing a
   *  setup file forces every test to render (a global, like Storybook's `preview.tsx`). A `node_modules`
   *  setup file (e.g. the plugin's own injected one) is dropped — a change to it lands as a lockfile
   *  change, which the server already treats as a full rebuild. */
  setupFiles: string[];
  /** Test-file paths (absolute) — the synthetic importers for each setup file. */
  testFiles: string[];
}

/** Reduce a Vite module id/file to a Vite-root-relative path, or `null` to drop it (node_modules,
 *  virtual, or unresolvable). */
export function toRepoRel(viteRoot: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const p = raw.replace(/\?.*$/, ""); // drop ?v=hash / ?import / ?t= query
  if (p.includes("\0") || p.startsWith("virtual:")) return null; // virtual module
  if (!path.isAbsolute(p)) return null; // unresolved / virtual id
  if (/(^|[/\\])node_modules[/\\]/.test(p)) return null;
  return path.relative(viteRoot, p).split(path.sep).join("/");
}

export function buildPreviewStats(input: BuildPreviewStatsInput): PreviewStats {
  const reasonsByName = new Map<string, Set<string>>();
  const ensure = (name: string): Set<string> => {
    let set = reasonsByName.get(name);
    if (!set) reasonsByName.set(name, (set = new Set()));
    return set;
  };

  const byKey = new Map<string, GraphModuleLike>();
  for (const mod of input.modules) {
    const key = mod.id ?? mod.file;
    if (key) byKey.set(key, mod);
  }
  for (const mod of input.modules) {
    const name = toRepoRel(input.viteRoot, mod.file ?? mod.id);
    if (name === null) continue;
    const reasons = ensure(name);
    // An importer that is dropped (virtual, node_modules) is walked through to ITS importers, so a repo
    // file a test reaches only by way of a virtual module still traces to that test.
    const seen = new Set<string>();
    const queue = [...(mod.importers ?? [])];
    for (let imp = queue.shift(); imp; imp = queue.shift()) {
      const key = imp.id ?? imp.file;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const r = toRepoRel(input.viteRoot, imp.file ?? imp.id);
      if (r !== null) {
        if (r !== name) reasons.add(r);
        continue;
      }
      queue.push(...(byKey.get(key)?.importers ?? imp.importers ?? []));
    }
  }

  // Synthetic setup-file edges: a setup file applies to every test, but isn't a graph importer of any of
  // them, so without this a changed setup file would trace to no test and be silently carried forward.
  const testNames = input.testFiles.map((f) => toRepoRel(input.viteRoot, f)).filter((n): n is string => n !== null);
  for (const sf of input.setupFiles) {
    const name = toRepoRel(input.viteRoot, sf);
    if (name === null) continue; // node_modules setup file → lockfile change already forces a full rebuild
    const reasons = ensure(name);
    for (const t of testNames) if (t !== name) reasons.add(t);
  }

  return toStats(reasonsByName);
}

/** Union several graphs by module name, merging reasons. */
export function unionStats(all: Iterable<PreviewStats>): PreviewStats {
  const reasonsByName = new Map<string, Set<string>>();
  for (const stats of all) {
    for (const m of stats.modules) {
      let set = reasonsByName.get(m.name);
      if (!set) reasonsByName.set(m.name, (set = new Set()));
      for (const r of m.reasons) set.add(r.moduleName);
    }
  }
  return toStats(reasonsByName);
}

function toStats(reasonsByName: Map<string, Set<string>>): PreviewStats {
  return {
    modules: [...reasonsByName].map(([name, reasons]) => ({
      name,
      reasons: [...reasons].map((moduleName) => ({ moduleName })),
    })),
  };
}
