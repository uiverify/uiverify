/**
 * Whether this upload asks UI Verify to skip unchanged stories, and what to tell the user about it.
 *
 * Skipping is on whenever the bundle carries a dependency graph (`preview-stats.json`): the server can
 * then prove which stories a change can't reach. Without one every story renders, and the log says so on
 * every upload, with the way to get a graph. `--render-all` turns it off.
 */

/** How the user asked: no flag, or `--render-all`. */
export type SkipMode = "default" | "render-all";

/**
 * What the bundle offers. `unchecked-graph` is a graph from a `@uiverify/vitest` that predates its source
 * check: it can name only bundler output for an Angular project, so it never drives a skip.
 */
export type BundleGraph =
  | "graph"
  | "unchecked-graph"
  | "storybook-no-graph"
  | "vitest-no-graph"
  /** A `@uiverify/vitest` 1.6.0+ archive with no graph: the SDK withheld it and said why in the test run. */
  | "vitest-graph-withheld"
  | "archive-no-graph";

export interface SkipPlan {
  /** Ask the server to skip, and compute + send the changed-file delta it decides from. */
  onlyChanged: boolean;
  notice: string | null;
}

const STORYBOOK_FIX = "Build it with `storybook build --stats-json`";
const VITEST_FIX = "Upgrade @uiverify/vitest to 1.6.0 or later and keep uiverifyPlugin() in your root Vitest config";
const PAYOFF = "and UI Verify renders only what your change affects.";
const WITHHELD = "@uiverify/vitest wrote none for this run; the test run's [uiverify] line says why.";

/** A Playwright archive gets no line: its tests open pages by URL, so "add a module graph" isn't an
 *  actionable fix for whoever reads the CI log. */
const DEFAULT_NO_GRAPH: Record<Exclude<BundleGraph, "graph" | "archive-no-graph">, string> = {
  "storybook-no-graph": `Every story renders: this Storybook build has no dependency graph (preview-stats.json). ${STORYBOOK_FIX} ${PAYOFF}`,
  "unchecked-graph": `Every test renders: this archive's module graph comes from an older @uiverify/vitest. ${VITEST_FIX}, ${PAYOFF}`,
  "vitest-no-graph": `Every test renders: this archive has no module graph (preview-stats.json). ${VITEST_FIX}, ${PAYOFF}`,
  "vitest-graph-withheld": `Every test renders: this archive has no module graph (preview-stats.json). ${WITHHELD}`,
};

/** `graph` is null for an upload that can never carry one (a screenshot directory). */
export function planSkip(mode: SkipMode, graph: BundleGraph | null): SkipPlan {
  if (mode === "render-all" || graph === null || graph === "archive-no-graph") return { onlyChanged: false, notice: null };
  if (graph === "graph") return { onlyChanged: true, notice: null };
  return { onlyChanged: false, notice: DEFAULT_NO_GRAPH[graph] };
}
