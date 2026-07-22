import { describe, it, expect } from "vitest";
import type { BuildStatus, IngestClient, RegisterBody } from "./client";
import type { GitMeta } from "./git";
import { runUpload, type UploadDeps } from "./upload";

interface CallLog {
  register?: RegisterBody;
  uploaded?: { url: string; tgz: string };
  marked?: string;
  markedAncestors?: string[];
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
    };

function fakeClient(
  log: CallLog,
  statuses: FakeStatus[] = [],
  baselineCommits: string[] = [],
  warnings: string[] = [],
): IngestClient {
  let i = 0;
  return {
    async register(body) {
      log.register = body;
      return { buildId: "b1", uploadUrl: "http://cp/api/storage/bundles/b1.tgz", baselineCommits, warnings };
    },
    async upload(url, tgz) {
      log.uploaded = { url, tgz };
    },
    async markUploaded(buildId, ancestorShas) {
      log.marked = buildId;
      log.markedAncestors = ancestorShas;
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
};

function deps(
  log: CallLog,
  statuses?: FakeStatus[],
  lines?: string[],
  opts: { baselineCommits?: string[]; warnings?: string[]; confirm?: (c: string[], head: string) => string[] } = {},
): UploadDeps {
  return {
    client: fakeClient(log, statuses, opts.baselineCommits ?? [], opts.warnings ?? []),
    gitMeta: () => meta,
    // Default: every candidate is a confirmed ancestor; tests that care override `confirm`.
    confirmAncestors: opts.confirm ?? ((candidates) => candidates),
    createBundle: async () => {},
    tmpFile: () => "/tmp/bundle.tgz",
    log: (m) => lines?.push(m),
    sleep: async () => {},
  };
}

describe("runUpload", () => {
  it("default: register -> upload -> markUploaded, then waits and reflects the verdict", async () => {
    const log: CallLog = { statusPolls: 0 };
    const res = await runUpload({ staticDir: "/sb" }, deps(log, ["running", "running", "changed"]));
    expect(res.buildId).toBe("b1");
    expect(res.status).toBe("changed");
    expect(log.register?.commitSha).toBe("abcdef1234567890");
    expect(log.register?.prNumber).toBe(9);
    expect(log.register?.autoAcceptChanges).toBe(false);
    expect(log.uploaded).toEqual({ url: "http://cp/api/storage/bundles/b1.tgz", tgz: "/tmp/bundle.tgz" });
    expect(log.marked).toBe("b1");
    expect(log.statusPolls).toBe(3);
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

  it("forwards the detected repoFullName in the register body", async () => {
    const log: CallLog = { statusPolls: 0 };
    await runUpload({ staticDir: "/sb" }, deps(log, ["passed"]));
    expect(log.register?.repoFullName).toBe("acme/web");
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

  it("treats blocked as terminal — stops polling and reports the quota/payment block", async () => {
    const log: CallLog = { statusPolls: 0 };
    const lines: string[] = [];
    const res = await runUpload(
      { staticDir: "/sb", appUrl: "https://uiverify.example.com" },
      // 'blocked' isn't in {passed,changed,failed}; without it being terminal the poll would spin to
      // the timeout. It must stop on the first blocked tick.
      deps(log, ["running", { status: "blocked", total: 67 }], lines),
    );
    expect(res.status).toBe("blocked");
    expect(log.statusPolls).toBe(2);
    expect(lines.some((l) => l.startsWith("Build b1 blocked — shot quota reached or payment required."))).toBe(true);
    // No misleading "0 changed, 0 failed" all-clear line for a build that rendered nothing.
    expect(lines.some((l) => l.includes("finished: blocked"))).toBe(false);
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
