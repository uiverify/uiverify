import os from "node:os";
import path from "node:path";
import type { IngestClient } from "./client";
import type { ClientDeltaEntry, GitMeta } from "./git";
import { formatVerdictSummary } from "./summary";

/**
 * The `uiverify upload` flow: collect git metadata, zip the static bundle, register the build, PUT the
 * bundle, mark it uploaded, print the build URL, then **wait**: poll the build status every ~2s, stream
 * a live "Rendered X / N" progress line until the build finishes, and reflect the gate verdict
 * (changed/failed) in the exit code. Collaborators are injected so the flow is unit-tested with a fake
 * client (no network/git).
 */
export interface UploadOptions {
  staticDir: string;
  /** Dashboard base URL (UI Verify's origin) — used to print the build's permalink. */
  appUrl?: string;
  /** Auto-accept this build's changed snapshots as the new baseline (pass on merges to main). */
  autoAcceptChanges?: boolean;
  /**
   * Skip-unchanged: render only the stories this commit's changed files could affect and carry the
   * rest forward. Opt-in per build. The whole decision runs server-side off the uploaded bundle's
   * dependency graph — a bundle built without Storybook's `--stats-json` carries no graph, so the
   * server renders everything even with this on.
   */
  onlyChanged?: boolean;
  /** Run as an interactive preview check (`uiverify check`): the build renders only `previewTargets`,
   *  diffs against the real CI baseline, posts no GitHub check, and never advances a CI baseline. */
  preview?: boolean;
  /** The exact command to watch this PR's checks to completion (`ciWatchCommand`), printed once while the
   *  build renders so an agent watching from outside CI copies it instead of hand-rolling a poll. Absent
   *  off a GitHub PR run. */
  watchHint?: string;
  /** The agent's explicit render targets for a preview check (story-id globs / exact ids). Replaces the
   *  dep-graph closure server-side; only meaningful with `preview: true`. */
  previewTargets?: string[];
  /** Whether the bundle carries a dependency graph (Storybook with --stats-json, or a Vitest archive) —
   *  computed at the call site (where the file sniff already lives). Only a graph-carrying `--only-changed`
   *  upload computes and sends the client delta; false skips it. */
  bundleHasGraph?: boolean;
}

export interface UploadDeps {
  client: IngestClient;
  gitMeta: () => GitMeta;
  /** Filter the server's candidate baseline commits to the head's true local git ancestors —
   *  injected so the upload flow is unit-tested without a real repo. */
  confirmAncestors: (candidates: string[], headSha: string) => string[];
  /** Compute the skip-unchanged changed-file delta for the server's offered `deltaBases` with local git —
   *  injected like `confirmAncestors` so the upload flow is unit-tested without a real repo. */
  deltaFor: (bases: string[], headSha: string) => Record<string, ClientDeltaEntry>;
  createBundle: (dir: string, out: string) => Promise<void>;
  /** The deterministic content hash of the built `.tgz`, computed after `createBundle`. Sent at register
   *  so the server can skip the rebuild of an already-passed commit. Injected so the flow is unit-tested
   *  without hashing a real archive. */
  bundleContentHash: (tgzPath: string) => Promise<string>;
  /** The capture SDK that produced the bundle, read from the finalized manifest after `createBundle`.
   *  Injected so the flow is unit-tested without a real archive; null for a Storybook upload. */
  readProducer: (staticDir: string) => { name: string; version: string } | null;
  tmpFile: () => string;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

// `blocked` (shot-quota / payment hard-pause) never renders and never advances, so from the poll's
// vantage it is terminal — including it stops a blocked build from polling to the timeout below.
const TERMINAL = new Set(["passed", "changed", "failed", "blocked"]);

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 60 * 60 * 1000;

export async function runUpload(opts: UploadOptions, deps: UploadDeps): Promise<{ buildId: string; status?: string }> {
  // The story list is no longer read here — the server enumerates it (and the per-story render
  // params) from the uploaded bundle.
  const meta = deps.gitMeta();
  const pr = meta.prNumber ? ` · PR #${meta.prNumber}` : "";
  deps.log(`Commit ${meta.commitSha.slice(0, 7)} on ${meta.branch}${pr}`);
  if (opts.preview) {
    const targets = opts.previewTargets ?? [];
    deps.log(`Preview check - rendering ${targets.length} target(s): ${targets.join(", ")}`);
  }

  const tgz = deps.tmpFile();
  deps.log("Bundling Storybook…");
  await deps.createBundle(opts.staticDir, tgz);

  // Read after createBundle: it finalizes the archive manifest (index.json), which carries the producer.
  const producer = deps.readProducer(opts.staticDir);
  // Hash the finalized bundle so the server can skip the rebuild of an already-passed commit when this is
  // a byte-identical re-upload of one it already rendered + accepted (computed after createBundle so the
  // finalized index.json is included). The hash is a pure optimization hint: if hashing somehow fails,
  // omit it and upload normally (the server just won't consider the skip) rather than failing the upload
  // over an optimization. This is why the wire field is optional.
  let bundleContentHash: string | undefined;
  try {
    bundleContentHash = await deps.bundleContentHash(tgz);
  } catch (e) {
    deps.log(`Could not hash the bundle (${e instanceof Error ? e.message : String(e)}); uploading without the rebuild-skip hint.`);
  }

  deps.log("Registering build…");
  const reg = await deps.client.register({
    commitSha: meta.commitSha,
    branch: meta.branch,
    prNumber: meta.prNumber,
    parentShas: meta.parentShas,
    autoAcceptChanges: opts.autoAcceptChanges ?? false,
    onlyChanged: opts.onlyChanged ?? false,
    // Preview check: the agent's targets replace the graph closure server-side (empty/absent on a
    // normal upload). Sent only when this is a preview run so the body stays the normal contract otherwise.
    preview: opts.preview ?? false,
    previewTargets: opts.preview ? (opts.previewTargets ?? []) : undefined,
    repoFullName: meta.repoFullName || undefined,
    sdkName: producer?.name,
    sdkVersion: producer?.version,
    bundleContentHash,
  });

  // The server skipped the rebuild of an already-passed commit: this exact commit already has a green
  // check + a dashboard build from the prior run, so there is nothing to upload, mark, or poll. Print and
  // exit clean (status `passed`). A build only reaches here on a byte-identical re-upload of a
  // fully-accepted build at the same commit; the dashboard's Re-run button forces a fresh capture.
  if (reg.outcome === "skipped") {
    const buildUrl = opts.appUrl ? `${opts.appUrl.replace(/\/$/, "")}/builds/${reg.buildId}` : reg.buildId;
    deps.log(`Skipping rebuild of already-passed build #${reg.buildNumber} (same commit, nothing changed): ${buildUrl}`);
    return { buildId: reg.buildId, status: "passed" };
  }
  const { buildId, uploadUrl, baselineCommits, deltaBases, warnings } = reg;
  // Advisory, non-blocking — e.g. the GitHub App isn't installed on the repo. Print loudly so the
  // "it did nothing on my PR" case is explained right in the CI log; never affects the exit code.
  for (const w of warnings) deps.log(`⚠ ${w}`);

  // Confirm which candidate baselines are true git ancestors of this head, locally — so a branch
  // behind the default branch doesn't inherit the default branch's drifted baseline. Empty for a
  // shallow checkout; the server then resolves the legacy way (and CI should use fetch-depth: 0).
  const ancestorShas = deps.confirmAncestors(baselineCommits, meta.commitSha);
  if (baselineCommits.length > 0) {
    deps.log(`Confirmed ${ancestorShas.length} / ${baselineCommits.length} baseline commits in git ancestry`);
  }

  // Skip-unchanged: for a graph-carrying `--only-changed` upload, diff the base commits the server named
  // against HEAD with local git and send the file lists with the upload. `UIVERIFY_NO_DELTA=1` opts a
  // runner out entirely. Never fails the upload — `deltaFor` turns every git error into a truncated entry.
  let changedFiles: Record<string, ClientDeltaEntry> | undefined;
  if (opts.onlyChanged && opts.bundleHasGraph && deltaBases.length > 0) {
    if (process.env.UIVERIFY_NO_DELTA === "1") {
      deps.log("Skipping changed-file delta (UIVERIFY_NO_DELTA=1)");
    } else {
      changedFiles = deps.deltaFor(deltaBases, meta.commitSha);
      const entries = Object.values(changedFiles);
      const fetched = entries.filter((e) => e.fetched).length;
      const unreadable = entries.filter((e) => e.truncated).length;
      deps.log(`Diffed HEAD against ${entries.length} baseline commit(s) (${fetched} fetched, ${unreadable} unreadable)`);
    }
  }

  deps.log(`Registered build ${buildId} — uploading bundle…`);
  await deps.client.upload(uploadUrl, tgz);
  await deps.client.markUploaded(buildId, ancestorShas, changedFiles);
  const buildUrl = opts.appUrl ? `${opts.appUrl.replace(/\/$/, "")}/builds/${buildId}` : buildId;
  deps.log(`Build uploaded: ${buildUrl}`);

  deps.log(`Waiting for build ${buildId} to render and diff…`);
  // This step already blocks until the verdict (its exit code is the result), so an agent that opened the
  // PR need only wait on this job — not invent a `gh pr checks … | jq` poll. Hand it the canonical
  // watch command once, up front, where it's visible while the build is still rendering.
  if (opts.watchHint) {
    deps.log(`This check blocks until the verdict — its exit code is the result.`);
    deps.log(`Watching from your terminal or coding agent? Run: ${opts.watchHint}`);
  }
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastProcessed = -1;
  for (let i = 0; i < MAX_WAIT_MS / POLL_INTERVAL_MS; i++) {
    const s = await deps.client.getStatus(buildId);
    // Stream a "Rendered X / N" line, but only when the count advances — so a slow
    // 2s poll on a large build doesn't spam an identical line into the CI log every tick.
    if (s.total > 0 && s.processed !== lastProcessed) {
      lastProcessed = s.processed;
      deps.log(`Rendered ${s.processed} / ${s.total}…`);
    }
    if (TERMINAL.has(s.status)) {
      // A blocked build rendered nothing, so its 0/0 counts would read as a misleading "all clear" —
      // say why it stopped and point at the dashboard instead.
      if (s.status === "blocked") {
        deps.log(`Build ${buildId} blocked — shot quota reached or payment required. Review: ${buildUrl}`);
        return { buildId, status: s.status };
      }
      const detail = s.total > 0 ? ` — ${s.changed} changed, ${s.failed} failed of ${s.total}` : "";
      deps.log(`Build ${buildId} finished: ${s.status}${detail}`);
      // On a red verdict, print the per-story summary AND the agent MCP handoff so an agent reading the
      // CI log sees what changed and exactly how to resolve it. UI Verify's PR check is a bare commit
      // status now (no body), so this log is the agent's only recipe. `passed` prints nothing;
      // `summary` is absent on an older server, so this no-ops there. Exit code is unchanged.
      if (s.summary && (s.status === "changed" || s.status === "failed")) {
        const agent = opts.appUrl
          ? { mcpUrl: `${opts.appUrl.replace(/\/$/, "")}/api/mcp`, selector: agentSelector(meta) }
          : undefined;
        for (const line of formatVerdictSummary(s.summary, buildUrl, agent)) deps.log(line);
      }
      return { buildId, status: s.status };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for build ${buildId}`);
}

/** The MCP selector that addresses this build - its PR if it has one, else its commit. */
function agentSelector(meta: GitMeta): string {
  return meta.prNumber !== null ? `{ "prNumber": ${meta.prNumber} }` : `{ "commitSha": "${meta.commitSha}" }`;
}

export function defaultTmpFile(): string {
  return path.join(os.tmpdir(), `uiverify-bundle-${process.pid}-${Date.now()}.tgz`);
}
