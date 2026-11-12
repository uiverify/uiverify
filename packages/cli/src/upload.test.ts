import { afterEach, describe, it, expect, vi } from "vitest";
import type { BuildStatus, IngestClient, OpenComments, RegisterBody } from "./client";
import type { ClientDeltaEntry, GitMeta } from "./git";
import type { BundleGraph } from "./skip";
import type { UploadProgress } from "./failure-report";
import { projectLine, runUpload, type UploadDeps, type UploadOptions } from "./upload";

interface CallLog {
  register?: RegisterBody;
  uploaded?: { url: string; tgz: string };
  marked?: string;
  markedAncestors?: string[];
  markedChangedFiles?: Record<string, ClientDeltaEntry>;
  deltaForBases?: string[];
  deltaForUncommitted?: string[] | null;
  statusPolls: number;
}

/** A poll result: a bare status string (counts default to 0) or the full progress shape. */
type FakeStatus =
  | string
  | {
      status: string;
      processed?: number;
      total?: number;
      changed?: number;
      failed?: number;
      summary?: BuildStatus["summary"];
      failureReason?: string | null;
      blocked?: BuildStatus["blocked"];
    };

function fakeClient(
  log: CallLog,
  statuses: FakeStatus[] = [],
  baselineCommits: string[] = [],
  warnings: string[] = [],
  deltaBases: string[] = [],
  skippedBuildNumber?: number,
  openComments?: OpenComments,
): IngestClient {
  let i = 0;
  return {
    async register(body) {
      log.register = body;
      // The server skipped the rebuild of an already-passed commit — no upload URL, just the prior build.
      if (skippedBuildNumber !== undefined) {
        return { outcome: "skipped", buildId: "prior1", buildNumber: skippedBuildNumber, openComments };
      }
      return {
        outcome: "upload",
        buildId: "b1",
        uploadUrl: "http://cp/api/storage/bundles/b1.tgz",
        baselineCommits,
        deltaBases,
        warnings,
        openComments,
      };
    },
    async upload(url, tgz) {
      log.uploaded = { url, tgz };
    },
    async markUploaded(buildId, ancestorShas, changedFiles) {
      log.marked = buildId;
      log.markedAncestors = ancestorShas;
      log.markedChangedFiles = changedFiles;
    },
    async getStatus() {
      log.statusPolls++;
      const s = statuses[Math.min(i++, statuses.length - 1)] ?? "running";
      const r = typeof s === "string" ? { status: s } : s;
      return { processed: 0, total: 0, changed: 0, failed: 0, ...r };
    },
  };
}

const meta: GitMeta = {
  commitSha: "abcdef1234567890",
  branch: "feat",
  prNumber: 9,
  parentShas: ["p0"],
  repoFullName: "acme/web",
  prHeadSha: null,
};

function deps(
  log: CallLog,
  statuses?: FakeStatus[],
  lines?: string[],
  opts: {
    baselineCommits?: string[];
    warnings?: string[];
    confirm?: (c: string[], head: string) => string[];
    producer?: { name: string; version: string } | null;
    deltaBases?: string[];
    delta?: (bases: string[], head: string) => Record<string, ClientDeltaEntry>;
    /** What the bundle offers skip-unchanged. Default: a Storybook built without --stats-json. */
    graph?: BundleGraph;
    /** The checkout's uncommitted files. Default: a clean checkout. */
    uncommitted?: string[] | null;
    /** When set, the fake server skips the rebuild and returns this prior build number. */
    skippedBuildNumber?: number;
    /** The open review notes the fake server reports for the branch. */
    openComments?: OpenComments;
    /** When true, bundle hashing throws - the upload must proceed without the rebuild-skip hint. */
    hashThrows?: boolean;
    /** Whether the static dir reads as a built Storybook (default true); false for a capture archive. */
    storybook?: boolean;
  } = {},
): UploadDeps {
  return {
    client: fakeClient(
      log,
      statuses,
      opts.baselineCommits ?? [],
      opts.warnings ?? [],
      opts.deltaBases ?? [],
      opts.skippedBuildNumber,
      opts.openComments,
    ),
    gitMeta: () => meta,
    // Default: every candidate is a confirmed ancestor; tests that care override `confirm`.
    confirmAncestors: opts.confirm ?? ((candidates) => candidates),
    workingTreeChanges: () => (opts.uncommitted === undefined ? [] : opts.uncommitted),
    deltaFor: (bases, head, uncommitted) => {
      log.deltaForBases = bases;
      log.deltaForUncommitted = uncommitted;
      return opts.delta ? opts.delta(bases, head) : {};
    },
    createBundle: async () => {},
    isStorybook: () => opts.storybook ?? true,
    bundleContentHash: async () => {
      if (opts.hashThrows) throw new Error("tar stream broke");
      return "v1:deadbeef";
    },
    // Default: a Storybook upload (no capture SDK); archive tests pass a producer.
    readProducer: () => opts.producer ?? null,
    bundleGraph: () => opts.graph ?? "storybook-no-graph",
    tmpFile: () => "/tmp/bundle.tgz",
    log: (m) => lines?.push(m),
    sleep: async () => {},
  };
}

const openComments: OpenComments = {
  branch: "feat",
  projectId: "p1",
  total: 1,
  textShown: true,
  notes: [
    {
      storyId: "card--default",
      title: "Card",
      name: "Default",
      viewport: "desktop",
      browser: "chromium",
      buildNumber: 2,
      reviewUrl: "https://cp/builds/b2?diff=d1",
      author: "Igor",
      body: "remove drop shadow",
      replies: 0,
    },
  ],
};

describe("runUpload", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends ci from the environment: true on a CI host, false on a local run", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const ciLog: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(ciLog, ["passed"]));
    expect(ciLog.register?.ci).toBe(true);

    vi.stubEnv("GITHUB_ACTIONS", "");
    const localLog: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(localLog, ["passed"]));
    expect(localLog.register?.ci).toBe(false);
  });

  /** Would catch the block printing after the upload line, or not at all, so an agent starting work on the
   *  branch scrolls past its notes or never sees them. */
  it("prints the branch's open review notes after the warnings and before the upload", async () => {
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb" },
      deps({ statusPolls: 0 }, ["passed"], lines, { warnings: ["⚠-source"], openComments }),
    );
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(lines).toContain("1 open review comment on branch feat - address it as part of this change:");
    expect(lines).toContain('  Card › Default (desktop, chromium), build #2, Igor: "remove drop shadow"');
    expect(at("open review comment")).toBeGreaterThan(at("⚠-source"));
    expect(at("open review comment")).toBeLessThan(at("Registered build"));
  });

  it("prints the notes on a skipped rebuild too", async () => {
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb", appUrl: "http://cp" },
      deps({ statusPolls: 0 }, [], lines, { skippedBuildNumber: 42, openComments }),
    );
    expect(lines).toContain("1 open review comment on branch feat - address it as part of this change:");
    expect(lines.findIndex((l) => l.includes("open review comment"))).toBeLessThan(
      lines.findIndex((l) => l.includes("Skipping rebuild")),
    );
  });

  it("prints no review lines when the server sends none", async () => {
    const lines: string[] = [];
    await runUpload({ staticDir: "/sb" }, deps({ statusPolls: 0 }, ["passed"], lines));
    expect(lines.some((l) => l.includes("review comment"))).toBe(false);
  });

  it("default: register -> upload -> markUploaded, then waits and reflects the verdict", async () => {
    const log: CallLog = { statusPolls: 0 };
    const res = await runUpload({ staticDir: "/sb" }, deps(log, ["running", "running", "changed"]));
    expect(res.buildId).toBe("b1");
    expect(res.status).toBe("changed");
    expect(log.register?.commitSha).toBe("abcdef1234567890");
    expect(log.register?.prNumber).toBe(9);
    expect(log.register?.autoAcceptChanges).toBe(false);
    expect(log.register?.onlyChanged).toBe(false);
    expect(log.uploaded).toEqual({ url: "http://cp/api/storage/bundles/b1.tgz", tgz: "/tmp/bundle.tgz" });
    expect(log.marked).toBe("b1");
    expect(log.statusPolls).toBe(3);
  });

  it("names what it bundles: Storybook, a capture archive, or screenshots", async () => {
    const bundlingLine = async (opts: Partial<UploadOptions>, storybook: boolean): Promise<string[]> => {
      const lines: string[] = [];
      await runUpload({ staticDir: "/dir", ...opts }, deps({ statusPolls: 0 }, ["passed"], lines, { storybook }));
      return lines.filter((l) => l.startsWith("Bundling"));
    };
    expect(await bundlingLine({}, true)).toEqual(["Bundling Storybook…"]);
    expect(await bundlingLine({}, false)).toEqual(["Bundling capture archive…"]);
    expect(await bundlingLine({ screenshots: true }, false)).toEqual(["Bundling screenshots…"]);
  });

  it("prints the watch-command hint while rendering when one is supplied, and stays silent otherwise", async () => {
    const withHint: string[] = [];
    await runUpload(
      { staticDir: "/sb", watchHint: "gh pr checks 9 --watch" },
      deps({ statusPolls: 0 }, ["running", "passed"], withHint),
    );
    expect(withHint.some((l) => l.includes("gh pr checks 9 --watch"))).toBe(true);
    expect(withHint.some((l) => l.includes("blocks until the verdict"))).toBe(true);

    const noHint: string[] = [];
    await runUpload({ staticDir: "/sb" }, deps({ statusPolls: 0 }, ["running", "passed"], noHint));
    expect(noHint.some((l) => l.includes("gh pr checks"))).toBe(false);
  });

  it("sends the proven PR head at register, and leaves the field out of the body when there is none", async () => {
    const withHead: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, { ...deps(withHead, ["passed"]), gitMeta: () => ({ ...meta, prHeadSha: "a".repeat(40) }) });
    expect(withHead.register?.prHeadSha).toBe("a".repeat(40));
    const without: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(without, ["passed"]));
    expect(JSON.parse(JSON.stringify(without.register))).not.toHaveProperty("prHeadSha");
  });

  it("sends the bundle content hash at register", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.bundleContentHash).toBe("v1:deadbeef");
  });

  it("uploads normally (no hash) when hashing throws, rather than failing the upload", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    // The hash is a pure optimization hint; a hashing failure must not abort the upload.
    const res = await runUpload({ staticDir: "/sb" }, deps(log, ["passed"], lines, { hashThrows: true }));
    expect(res.status).toBe("passed");
    expect(log.register).toBeDefined();
    expect(log.register?.bundleContentHash).toBeUndefined();
    expect(lines.some((l) => l.includes("without the rebuild-skip hint"))).toBe(true);
  });

  it("on a skipped rebuild: prints the skip line and exits clean without uploading, marking, or polling", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload({ staticDir: "/sb", appUrl: "http://cp" }, deps(log, [], lines, { skippedBuildNumber: 42 }));
    // A skip inherits the prior build's pass, so the run exits 0.
    expect(res.status).toBe("passed");
    expect(res.buildId).toBe("prior1");
    // Create/do nothing: no bundle PUT, no markUploaded, no status poll.
    expect(log.uploaded).toBeUndefined();
    expect(log.marked).toBeUndefined();
    expect(log.statusPolls).toBe(0);
    expect(lines.some((l) => l.includes("Skipping rebuild of already-passed build #42"))).toBe(true);
  });

  it("prints register warnings (e.g. App not installed) into the log without failing", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload(
      { staticDir: "/sb" },
      deps(log, ["passed"], lines, { warnings: ["GitHub App not installed on acme/web — install it: https://x"] }),
    );
    expect(res.status).toBe("passed");
    expect(lines.some((l) => l.includes("App not installed on acme/web"))).toBe(true);
  });

  it("confirms the register candidates against git ancestry and uploads only the confirmed subset", async () => {
    const log: CallLog = { statusPolls: 0 };
    const res = await runUpload(
      { staticDir: "/sb" },
      deps(log, ["passed"], undefined, {
        baselineCommits: ["anc1", "drifted2", "anc3"],
        confirm: (candidates) => candidates.filter((c) => c.startsWith("anc")),
      }),
    );
    expect(res.status).toBe("passed");
    // Only the true ancestors reach the server — the drifted default-branch commit is dropped.
    expect(log.markedAncestors).toEqual(["anc1", "anc3"]);
  });

  it("uploads an empty ancestor set when there are no candidates (first build / legacy server)", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.markedAncestors).toEqual([]);
  });

  it("forwards --auto-accept-changes as autoAcceptChanges in the register body", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb", autoAcceptChanges: true }, deps(log, ["passed"]));
    expect(log.register?.autoAcceptChanges).toBe(true);
  });

  it("skips by default when the bundle has a graph, sending the delta over the server's bases", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const base = "a".repeat(40);
    await runUpload(
      { staticDir: "/sb" },
      deps(log, ["passed"], lines, {
        graph: "graph",
        deltaBases: [base],
        delta: (bases) => ({ [bases[0] ?? ""]: { files: ["src/x.ts"], truncated: false } }),
      }),
    );
    expect(log.register?.onlyChanged).toBe(true);
    expect(log.deltaForBases).toEqual([base]);
    expect(log.markedChangedFiles).toEqual({ [base]: { files: ["src/x.ts"], truncated: false } });
    expect(lines.some((l) => l.includes("renders"))).toBe(false);
  });

  /** Would catch: a graphless default build passing silently, so the user pays for full runs believing
   *  it skips, or one that asks the server to skip what it can't decide. */
  it.each<[BundleGraph, string]>([
    ["storybook-no-graph", "storybook build --stats-json"],
    ["vitest-no-graph", "Upgrade @uiverify/vitest"],
    ["unchecked-graph", "Upgrade @uiverify/vitest"],
  ])("renders everything by default without a usable graph (%s), and says how to get one", async (graph, fix) => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"], lines, { graph, deltaBases: ["a".repeat(40)] }));
    expect(log.register?.onlyChanged).toBe(false);
    expect(log.deltaForBases).toBeUndefined();
    expect(lines.filter((l) => l.startsWith("Every ") && l.includes(fix))).toHaveLength(1);
  });

  /** Would catch: `--render-all` still carrying stories, or still letting the same-commit rebuild shortcut
   *  pass a commit without rendering it. */
  it("--render-all asks for no skipping, sends no delta and no bundle hash", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb", skip: "render-all" },
      deps(log, ["passed"], lines, { graph: "graph", deltaBases: ["a".repeat(40)], uncommitted: ["x.ts"] }),
    );
    expect(log.register?.onlyChanged).toBe(false);
    expect(log.register?.bundleContentHash).toBeUndefined();
    expect(log.deltaForBases).toBeUndefined();
    expect(lines.some((l) => l.startsWith("Every "))).toBe(false);
  });

  /** Would catch: a Playwright log telling the user to hand-write a module graph, a fix nobody reading a
   *  CI log can act on. */
  it("renders a Playwright archive without a graph in full, and says nothing about graphs", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"], lines, { graph: "archive-no-graph", deltaBases: ["a".repeat(40)] }));
    expect(log.register?.onlyChanged).toBe(false);
    expect(log.deltaForBases).toBeUndefined();
    expect(lines.some((l) => l.includes("preview-stats.json") || l.startsWith("Every "))).toBe(false);
  });

  it("says nothing about graphs for a screenshot upload or a preview check", async () => {
    for (const opts of [{ screenshots: true }, { preview: true, previewTargets: ["a--*"] }]) {
      const log: CallLog = { statusPolls: 0 };
      const lines: string[] = [];
      await runUpload({ staticDir: "/sb", ...opts }, deps(log, ["passed"], lines, { graph: "storybook-no-graph" }));
      expect(log.register?.onlyChanged).toBe(false);
      expect(lines.some((l) => l.startsWith("Every "))).toBe(false);
    }
  });

  it("reports a clean checkout as having no uncommitted changes", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.uncommittedChanges).toBe(false);
  });

  /** A build made from uncommitted edits must tell the server (it then stamps no watermark), and
   *  hand the edits to the delta even when the server offered no base, for the head's own entry. */
  it("reports uncommitted edits, names them, and passes them to the delta", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb" },
      deps(log, ["passed"], lines, { graph: "graph", uncommitted: ["a.ts", "b.ts", "c.ts", "d.ts"] }),
    );
    expect(log.register?.uncommittedChanges).toBe(true);
    expect(log.deltaForBases).toEqual([]);
    expect(log.deltaForUncommitted).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(lines.some((l) => l.startsWith("4 file(s) differ from commit abcdef1 (a.ts, b.ts, c.ts, and 1 more)"))).toBe(
      true,
    );
  });

  it("skips the uncommitted-files check for a preview check or a screenshot upload", async () => {
    for (const opts of [{ screenshots: true }, { preview: true, previewTargets: ["a--*"] }]) {
      const log: CallLog = { statusPolls: 0 };
      const lines: string[] = [];
      await runUpload({ staticDir: "/sb", ...opts }, deps(log, ["passed"], lines, { uncommitted: ["a.ts"] }));
      expect(lines.some((l) => l.includes("differ from commit"))).toBe(false);
      expect(log.register?.uncommittedChanges).toBeUndefined();
    }
  });

  it("treats a checkout git can't read as having uncommitted changes", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"], undefined, { graph: "graph", uncommitted: null }));
    expect(log.register?.uncommittedChanges).toBe(true);
    expect(log.deltaForUncommitted).toBeNull();
  });

  it("UIVERIFY_NO_DELTA=1 skips the delta step entirely", async () => {
    const log: CallLog = { statusPolls: 0 };
    const prev = process.env.UIVERIFY_NO_DELTA;
    process.env.UIVERIFY_NO_DELTA = "1";
    try {
      await runUpload({ staticDir: "/sb" }, deps(log, ["passed"], undefined, { graph: "graph", deltaBases: ["a".repeat(40)] }));
    } finally {
      if (prev === undefined) delete process.env.UIVERIFY_NO_DELTA;
      else process.env.UIVERIFY_NO_DELTA = prev;
    }
    expect(log.deltaForBases).toBeUndefined();
    expect(log.markedChangedFiles).toBeUndefined();
  });

  it("forwards preview + previewTargets in the register body for a preview check", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload(
      { staticDir: "/sb", preview: true, previewTargets: ["components-button--*", "pages-home--default"] },
      deps(log, ["changed"]),
    );
    expect(log.register?.preview).toBe(true);
    expect(log.register?.previewTargets).toEqual(["components-button--*", "pages-home--default"]);
  });

  it("a normal upload sends preview false and no targets (the body stays the CI contract)", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.preview).toBe(false);
    expect(log.register?.previewTargets).toBeUndefined();
  });

  it("logs the preview targets so the agent sees exactly what will render", async () => {
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb", preview: true, previewTargets: ["components-button--default"] },
      deps({ statusPolls: 0 }, ["changed"], lines),
    );
    expect(lines.some((l) => l.includes("Preview check") && l.includes("components-button--default"))).toBe(true);
  });

  it("forwards the detected repoFullName in the register body", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.repoFullName).toBe("acme/web");
  });

  it("forwards the bundle's capture-SDK producer as sdkName/sdkVersion in the register body", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload(
      { staticDir: "/archive" },
      deps(log, ["passed"], undefined, { producer: { name: "@uiverify/playwright", version: "1.2.3" } }),
    );
    expect(log.register?.sdkName).toBe("@uiverify/playwright");
    expect(log.register?.sdkVersion).toBe("1.2.3");
  });

  it("sends no SDK identity for a Storybook upload (no capture SDK)", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.sdkName).toBeUndefined();
    expect(log.register?.sdkVersion).toBeUndefined();
  });

  it("streams a 'Rendered X / N' line as progress advances, then a final count summary", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload(
      { staticDir: "/sb" },
      deps(
        log,
        [
          { status: "running", processed: 20, total: 200 },
          { status: "running", processed: 20, total: 200 },
          { status: "running", processed: 140, total: 200 },
          { status: "changed", processed: 200, total: 200, changed: 3, failed: 1 },
        ],
        lines,
      ),
    );
    expect(res.status).toBe("changed");
    // One line per distinct processed count (20 then 140 then the terminal 200) — not one per poll.
    expect(lines.filter((l) => l.startsWith("Rendered "))).toEqual([
      "Rendered 20 / 200…",
      "Rendered 140 / 200…",
      "Rendered 200 / 200…",
    ]);
    expect(lines).toContain("Build b1 finished: changed — 3 changed, 1 failed of 200");
  });

  it("prints the per-story verdict summary after the finished line on a terminal changed build", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com" },
      deps(
        log,
        [
          {
            status: "changed",
            total: 67,
            changed: 11,
            failed: 0,
            summary: {
              aiReview: { regressions: 1, intended: 0, reviewed: 1 },
              changedStories: [
                {
                  storyId: "components-decisionbadge--all",
                  title: "Components/DecisionBadge",
                  name: "All",
                  decision: null,
                  aiVerdict: "regression",
                  aiConfidence: "high",
                  aiSummary: "Pill fill changed.",
                },
              ],
              changedStoriesTruncated: { shown: 1, total: 11 },
              failedStories: [],
            },
          },
        ],
        lines,
      ),
    );
    const finishedAt = lines.indexOf("Build b1 finished: changed — 11 changed, 0 failed of 67");
    expect(finishedAt).toBeGreaterThanOrEqual(0);
    // The summary block follows the finished line.
    const summaryAt = lines.indexOf("Changed stories:");
    expect(summaryAt).toBeGreaterThan(finishedAt);
    expect(lines).toContain("AI review (advisory): 1 likely regression, 0 intended — 1 of 11 changed judged.");
    expect(lines).toContain("  Components/DecisionBadge › All · awaiting review · AI: likely regression (high)");
    expect(lines).toContain("      Pill fill changed.");
    expect(lines).toContain("  …and 10 more changed");
    expect(lines).toContain("Review: https://uiverify.example.com/builds/b1");
  });

  it("hands the agent a buildId selector for a preview check, since a PR or commit resolves the CI build", async () => {
    const changed: FakeStatus = {
      status: "changed",
      total: 1,
      changed: 1,
      failed: 0,
      summary: {
        aiReview: { regressions: 0, intended: 0, reviewed: 0 },
        changedStories: [],
        changedStoriesTruncated: { shown: 0, total: 1 },
        failedStories: [],
      },
    };
    const previewLines: string[] = [];
    await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com", preview: true, previewTargets: ["pages-profile--default"] },
      deps({ statusPolls: 0 }, [changed], previewLines),
    );
    expect(previewLines).toContain('  1. get_build { "buildId": "b1" } - the changed-story list, each with a diffResultId.');
    expect(previewLines.some((l) => l.includes('"prNumber"'))).toBe(false);

    const uploadLines: string[] = [];
    await runUpload({ staticDir: "/sb", appUrl: "https://uiverify.example.com" }, deps({ statusPolls: 0 }, [changed], uploadLines));
    expect(uploadLines).toContain('  1. get_build { "prNumber": 9 } - the changed-story list, each with a diffResultId.');
  });

  /** Catches a blocked build polling on to the timeout, and an older server's block being blamed on payment. */
  it("treats blocked as terminal and, with no explanation from the server, prints a generic line that tells the agent to stop", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com" },
      // 'blocked' isn't in {passed,changed,failed}; without it being terminal the poll would spin to
      // the timeout. It must stop on the first blocked tick. An older server sends no `blocked` field.
      deps(log, ["running", { status: "blocked", total: 67 }], lines),
    );
    expect(res.status).toBe("blocked");
    expect(log.statusPolls).toBe(2);
    const at = lines.indexOf(
      "Build b1 blocked: UI Verify paused it at the team's snapshot allowance or billing check before rendering anything.",
    );
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at)).toEqual([
      "Build b1 blocked: UI Verify paused it at the team's snapshot allowance or billing check before rendering anything.",
      "Retrying this build won't help until the block is lifted. Please tell the user.",
      "Review: https://uiverify.example.com/builds/b1",
    ]);
    expect(lines.some((l) => /payment/i.test(l))).toBe(false);
    // No misleading "0 changed, 0 failed" all-clear line for a build that rendered nothing.
    expect(lines.some((l) => l.includes("finished: blocked"))).toBe(false);
  });

  /** Catches the CLI dropping or rewording the server's explanation, or losing the build link after it. */
  it("prints the server's explanation of a blocked build line by line, then the build link", async () => {
    const message = [
      "UI Verify paused this build before rendering anything: your team has used (or reserved for builds still running) 9,620 of its 10,000 snapshots for this month, and this build needs 1,104. Nothing was rendered or counted. The allowance resets on December 1, 2026.",
      "Likely cause: this project has no accepted baseline on `main` yet, so pull request builds often have nothing to compare against.",
      "What to do: 1. Get a baseline onto `main`. 2. To raise the limit, upgrade the team's plan from its Usage page in UI Verify, or book a call at https://uiverify.ai/talk-to-us.",
      "Retrying this build won't help until the allowance resets or is raised. Please tell the user.",
    ].join("\n");
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com" },
      deps(log, [{ status: "blocked", total: 1104, blocked: { message } }], lines),
    );
    expect(res.status).toBe("blocked");
    const at = lines.indexOf("Build b1 blocked.");
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at)).toEqual(["Build b1 blocked.", ...message.split("\n"), "Review: https://uiverify.example.com/builds/b1"]);
  });

  it("prints the server's reason on a build that failed as a whole", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb" },
      deps(log, [{ status: "failed", failureReason: "The upload has no index.json at its root." }], lines),
    );
    expect(lines).toContain("Reason: The upload has no index.json at its root.");
  });

  it("prints no summary block on a passed build", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb" },
      deps(log, [{ status: "passed", total: 67, changed: 0, failed: 0 }], lines),
    );
    expect(lines.some((l) => l === "Changed stories:")).toBe(false);
    expect(lines.some((l) => l.startsWith("AI review"))).toBe(false);
  });

  it("prints the build permalink when an appUrl is set", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    await runUpload({ staticDir: "/sb", appUrl: "https://uiverify.example.com/" }, deps(log, ["passed"], lines));
    expect(lines.some((l) => l.includes("https://uiverify.example.com/builds/b1"))).toBe(true);
  });
});

describe("runUpload progress", () => {
  const opts: UploadOptions = { staticDir: "storybook-static" };

  /** Catches a failure being reported under the wrong step, or a run whose build already reached the server
   *  being reported at all. */
  it.each([
    ["git", (d: UploadDeps) => ({ ...d, gitMeta: () => { throw new Error("fatal: not a git repository"); } })],
    ["archive", (d: UploadDeps) => ({ ...d, createBundle: async () => { throw new Error("tar failed"); } })],
    ["register", (d: UploadDeps) => ({ ...d, client: { ...d.client, register: async () => { throw new Error("401"); } } })],
    ["upload", (d: UploadDeps) => ({ ...d, client: { ...d.client, upload: async () => { throw new Error("403"); } } })],
    ["upload", (d: UploadDeps) => ({ ...d, client: { ...d.client, markUploaded: async () => { throw new Error("502"); } } })],
  ] as const)("is at %s when that step throws", async (stage, breakDeps) => {
    const progress: UploadProgress = { stage: "git", producer: null, project: null };
    await expect(runUpload(opts, { ...breakDeps(deps({ statusPolls: 0 }, ["passed"])), progress })).rejects.toThrow();
    expect(progress.stage).toBe(stage);
  });

  it("is done once the bundle is marked uploaded, and keeps the producer it read", async () => {
    const progress: UploadProgress = { stage: "git", producer: null, project: null };
    const producer = { name: "@uiverify/vitest", version: "1.6.2" };
    const d = deps({ statusPolls: 0 }, [{ status: "running" }, "passed"], [], { producer });
    const d2: UploadDeps = { ...d, client: { ...d.client, getStatus: async () => { throw new Error("poll failed"); } }, progress };
    await expect(runUpload(opts, d2)).rejects.toThrow("poll failed");
    expect(progress).toEqual({ stage: "done", producer, project: null });
  });
});
describe("runUpload signed in", () => {
  const changed: FakeStatus = {
    status: "changed",
    total: 1,
    changed: 1,
    failed: 0,
    summary: {
      aiReview: null,
      changedStories: [{ storyId: "a", title: "A", name: "X", decision: null, aiVerdict: null, aiConfidence: null, aiSummary: null }],
      changedStoriesTruncated: null,
      failedStories: [],
    },
  };

  /** The server answers register with the project the build landed in, as it does for a signed-in upload. */
  function withProject(d: UploadDeps, project: { id: string; team: string; slug: string; created: boolean }): UploadDeps {
    const inner = d.client;
    return {
      ...d,
      client: {
        ...inner,
        async register(body) {
          const reg = await inner.register(body);
          return reg.outcome === "upload" ? { ...reg, project } : reg;
        },
      },
    };
  }

  it("sends --project and the capture shape, and the upstream remote from git", async () => {
    const log: CallLog = { statusPolls: 0 };
    const d = deps(log, ["passed"]);
    await runUpload(
      { staticDir: "/sb", project: "acme/web", captureShape: "storybook" },
      { ...d, gitMeta: () => ({ ...meta, upstreamRepoFullName: "upstream-org/web" }) },
    );
    expect(log.register).toMatchObject({ project: "acme/web", captureShape: "storybook", upstreamRepoFullName: "upstream-org/web" });
  });

  /** Would catch: `--confirm-new` parsed but never reaching the server, so "none of these" can't create. */
  it("sends --confirm-new only when given", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb", project: "acme/web", confirmNew: "abc123" }, deps(log, ["passed"]));
    expect(log.register).toMatchObject({ project: "acme/web", confirmNew: "abc123" });
    const plain: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(plain, ["passed"]));
    expect(plain.register?.confirmNew).toBeUndefined();
  });

  /** Would catch: a signed-in upload, whose project the server picked, never saying where the build went. */
  it("names the project the server picked, and says when it created it", async () => {
    const created: string[] = [];
    await runUpload({ staticDir: "/sb" }, withProject(deps({ statusPolls: 0 }, ["passed"], created), { id: "p1", team: "acme", slug: "web", created: true }));
    expect(created).toContain("Created project acme/web");

    const existing: string[] = [];
    await runUpload({ staticDir: "/sb" }, withProject(deps({ statusPolls: 0 }, ["passed"], existing), { id: "p1", team: "acme", slug: "web", created: false }));
    expect(existing).toContain("Project acme/web");
    expect(existing.some((l) => l.startsWith("Created project"))).toBe(false);
  });

  /** Would catch: a first signed-in upload that created the team and project without saying so, or without the
   *  dashboard link, or a server that predates `teamCreated`/`url` breaking the line. */
  it("says what the first upload created, with the dashboard link", () => {
    const url = "https://uiverify.ai/dashboard/teams/acme/projects/web";
    const base = { id: "p1", team: "acme", slug: "web" };
    expect(projectLine({ ...base, created: true, teamCreated: true, url })).toBe(
      `Created team acme and project acme/web: ${url}`,
    );
    expect(projectLine({ ...base, created: true, teamCreated: false, url })).toBe(`Created project acme/web: ${url}`);
    expect(projectLine({ ...base, created: false, teamCreated: false, url })).toBe(`Project acme/web: ${url}`);
    expect(projectLine({ ...base, created: true })).toBe("Created project acme/web");
  });

  /** Would catch: a signed-in upload's agent told to use a project API key it doesn't have, or handed a
   *  selector a cross-team browser login can't resolve. */
  it("points a signed-in upload's agent at the browser-login MCP with a project-scoped selector", async () => {
    const lines: string[] = [];
    await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com", signedIn: true },
      withProject(deps({ statusPolls: 0 }, [changed], lines), { id: "proj_1", team: "acme", slug: "web", created: false }),
    );
    expect(lines).toContain(
      "  Endpoint: https://uiverify.example.com/mcp (sign in with your UI Verify account in the browser when your MCP client asks)",
    );
    expect(lines).toContain('  1. get_build { "projectId": "proj_1", "prNumber": 9 } - the changed-story list, each with a diffResultId.');

    const keyLines: string[] = [];
    await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com" },
      withProject(deps({ statusPolls: 0 }, [changed], keyLines), { id: "proj_1", team: "acme", slug: "web", created: false }),
    );
    expect(keyLines).toContain("  Endpoint: https://uiverify.example.com/api/mcp (authenticate with your project API key)");
    expect(keyLines).toContain('  1. get_build { "prNumber": 9 } - the changed-story list, each with a diffResultId.');
  });
});
