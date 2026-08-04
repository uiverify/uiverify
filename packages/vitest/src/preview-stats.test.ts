import { describe, it, expect } from "vitest";
import { type GraphModuleLike, buildPreviewStats } from "./preview-stats";

const ROOT = "/repo/apps/web";

/** A module node the way Vite exposes it: absolute `file`, importers as node refs. */
function mod(file: string, importers: string[] = []): GraphModuleLike {
  return { file, id: file, importers: importers.map((f) => ({ file: f, id: f })) };
}

describe("buildPreviewStats", () => {
  it("emits Vite-root-relative names with reverse (importer) edges", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [
        mod(`${ROOT}/uiverify/landing.visual.test.tsx`),
        mod(`${ROOT}/src/LandingPage.tsx`, [`${ROOT}/uiverify/landing.visual.test.tsx`]),
        mod(`${ROOT}/src/HeroBackdrop.tsx`, [`${ROOT}/src/LandingPage.tsx`]),
      ],
      setupFiles: [],
      testFiles: [`${ROOT}/uiverify/landing.visual.test.tsx`],
    });
    const byName = new Map(stats.modules.map((m) => [m.name, m.reasons.map((r) => r.moduleName).sort()]));
    expect(byName.get("uiverify/landing.visual.test.tsx")).toEqual([]);
    expect(byName.get("src/LandingPage.tsx")).toEqual(["uiverify/landing.visual.test.tsx"]);
    // A leaf change (HeroBackdrop) can BFS through LandingPage up to the test — the cross-component trace.
    expect(byName.get("src/HeroBackdrop.tsx")).toEqual(["src/LandingPage.tsx"]);
  });

  it("drops node_modules and virtual modules — only repo source survives", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [
        mod(`${ROOT}/src/App.tsx`, [
          `/repo/node_modules/.pnpm/react@19/node_modules/react/index.js`,
          `${ROOT}/src/App.test.tsx`,
        ]),
        mod(`/repo/node_modules/.pnpm/react@19/node_modules/react/index.js`),
        { id: "\0virtual:uiverify", file: null, importers: [{ file: `${ROOT}/src/App.tsx` }] },
      ],
      setupFiles: [],
      testFiles: [],
    });
    const names = stats.modules.map((m) => m.name);
    expect(names).toContain("src/App.tsx");
    expect(names.some((n) => n.includes("node_modules"))).toBe(false);
    expect(names.some((n) => n.includes("virtual"))).toBe(false);
    // The node_modules importer is stripped from reasons; the repo-source importer stays.
    expect(stats.modules.find((m) => m.name === "src/App.tsx")?.reasons).toEqual([{ moduleName: "src/App.test.tsx" }]);
  });

  it("strips ?v= / ?import query suffixes off ids when file is absent", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [{ id: `${ROOT}/src/util.ts?v=abc123`, file: null, importers: [{ id: `${ROOT}/src/x.test.tsx?t=1` }] }],
      setupFiles: [],
      testFiles: [],
    });
    expect(stats.modules).toEqual([{ name: "src/util.ts", reasons: [{ moduleName: "src/x.test.tsx" }] }]);
  });

  it("synthesizes setup-file edges to every test file (setup files aren't real importers)", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [mod(`${ROOT}/test/a.visual.test.tsx`), mod(`${ROOT}/test/b.visual.test.tsx`)],
      setupFiles: [`${ROOT}/test/setup.ts`],
      testFiles: [`${ROOT}/test/a.visual.test.tsx`, `${ROOT}/test/b.visual.test.tsx`],
    });
    const setup = stats.modules.find((m) => m.name === "test/setup.ts");
    expect(setup?.reasons.map((r) => r.moduleName).sort()).toEqual([
      "test/a.visual.test.tsx",
      "test/b.visual.test.tsx",
    ]);
  });

  it("drops a node_modules setup file (a change to it is a lockfile change the server full-rebuilds)", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [mod(`${ROOT}/test/a.visual.test.tsx`)],
      setupFiles: [`/repo/node_modules/.pnpm/@uiverify+vitest/dist/browser-setup.js`],
      testFiles: [`${ROOT}/test/a.visual.test.tsx`],
    });
    expect(stats.modules.some((m) => m.name.includes("browser-setup"))).toBe(false);
  });

  it("unions duplicate module names (across browser servers) into one entry, merging reasons", () => {
    const stats = buildPreviewStats({
      viteRoot: ROOT,
      modules: [
        mod(`${ROOT}/src/Shared.tsx`, [`${ROOT}/test/a.visual.test.tsx`]),
        mod(`${ROOT}/src/Shared.tsx`, [`${ROOT}/test/b.visual.test.tsx`]),
      ],
      setupFiles: [],
      testFiles: [],
    });
    const shared = stats.modules.filter((m) => m.name === "src/Shared.tsx");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.reasons.map((r) => r.moduleName).sort()).toEqual([
      "test/a.visual.test.tsx",
      "test/b.visual.test.tsx",
    ]);
  });
});
