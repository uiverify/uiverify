import { describe, expect, it } from "vitest";
import { type BundleGraph, planSkip } from "./skip";

const NO_GRAPH: BundleGraph[] = [
  "storybook-no-graph",
  "vitest-no-graph",
  "vitest-graph-withheld",
  "unchecked-graph",
];

describe("planSkip", () => {
  it("skips by default only with a usable graph", () => {
    expect(planSkip("default", "graph")).toEqual({ onlyChanged: true, notice: null });
    for (const graph of NO_GRAPH) {
      const plan = planSkip("default", graph);
      expect(plan.onlyChanged).toBe(false);
      expect(plan.notice).toMatch(/^Every (story|test) renders: /);
    }
  });

  it("never asks under --render-all, and never says why", () => {
    for (const graph of ["graph", ...NO_GRAPH, null] as const) {
      expect(planSkip("render-all", graph)).toEqual({ onlyChanged: false, notice: null });
    }
  });

  it("leaves a screenshot upload and a graphless Playwright archive alone, without a notice", () => {
    expect(planSkip("default", null)).toEqual({ onlyChanged: false, notice: null });
    expect(planSkip("default", "archive-no-graph")).toEqual({ onlyChanged: false, notice: null });
  });

  // Customer-facing CI output: no em or en dashes.
  it("keeps every notice free of dashes", () => {
    for (const graph of ["graph", ...NO_GRAPH, null] as const) {
      expect(planSkip("default", graph).notice ?? "").not.toMatch(/[—–]/);
    }
  });
});
