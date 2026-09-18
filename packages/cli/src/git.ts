import { execFileSync } from "node:child_process";

/**
 * Git metadata for a build. The parsing helpers are pure (unit-tested); `collectGitMeta` runs git +
 * reads CI env. Env overrides win so CI can supply the true PR head branch / number, which a
 * detached-HEAD checkout doesn't know.
 */
export interface GitMeta {
  commitSha: string;
  branch: string;
  prNumber: number | null;
  parentShas: string[];
  /** The repo's full name — `owner/repo` (GitHub) or `workspace/repo_slug` (Bitbucket) — learned from
   *  CI env or the git remote. Host-agnostic: the remote parse works for any host. Empty only when it
   *  can't be determined (no remote) — the server keeps whatever it already had. */
  repoFullName: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run git, swallowing a non-zero exit (e.g. no `origin` remote) into null instead of throwing. */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Parents from `git log -1 --format=%P` ("sha1 sha2" for a merge). */
export function parseParents(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Branch, preferring CI env over the git fallback: an explicit `BRANCH` override, then the head branch
 * each host's PR pipeline exposes (GitHub Actions `GITHUB_HEAD_REF`, Bitbucket Pipelines
 * `BITBUCKET_BRANCH`), then the local `git` branch — which a detached-HEAD CI checkout doesn't know.
 */
export function branchFromEnv(env: NodeJS.ProcessEnv, fallback: string): string {
  return env.BRANCH || env.GITHUB_HEAD_REF || env.BITBUCKET_BRANCH || fallback;
}

/**
 * PR number from an explicit `PR_NUMBER` override, else the host's PR-pipeline env: GitHub Actions'
 * ref (`refs/pull/<n>/merge`) or Bitbucket Pipelines' `BITBUCKET_PR_ID`. `null` off a PR (both are
 * only set on PR-triggered runs), so the build posts against a branch, not a PR.
 */
export function prNumberFromEnv(env: NodeJS.ProcessEnv): number | null {
  const explicit = env.PR_NUMBER;
  if (explicit) {
    const n = Number(explicit);
    return Number.isFinite(n) ? n : null;
  }
  const gh = (env.GITHUB_REF ?? "").match(/^refs\/pull\/(\d+)\//);
  if (gh) return Number(gh[1]);
  if (env.BITBUCKET_PR_ID) {
    const n = Number(env.BITBUCKET_PR_ID);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The command to watch this PR's checks to completion — what an agent that opened the PR should run
 * instead of hand-rolling a `gh pr checks … | jq` poll. GitHub Actions only (`gh pr checks --watch` is a
 * GitHub CLI feature) and only on a PR-triggered run; `null` otherwise, so the caller prints nothing when
 * there's no PR to watch. `--watch` blocks until every check is terminal and exits non-zero if any failed.
 */
export function ciWatchCommand(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_ACTIONS !== "true") return null;
  const pr = prNumberFromEnv(env);
  return pr !== null ? `gh pr checks ${pr} --watch` : null;
}

/**
 * Extract `owner/repo` from a git remote URL. Handles the SSH (`git@github.com:owner/repo.git`),
 * HTTPS (`https://github.com/owner/repo.git`), and `ssh://` forms — the host/port/scheme are dropped
 * and the last two path segments win. Returns null when there aren't two segments to take.
 */
export function parseRepoFromRemote(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  const parts = cleaned.replace(/:/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  return owner && repo ? `${owner}/${repo}` : null;
}

/** The repo full name, preferring an explicit override, then each host's CI env (GitHub Actions
 *  `GITHUB_REPOSITORY`, Bitbucket Pipelines `BITBUCKET_REPO_FULL_NAME`), then the git remote. */
export function repoFullNameFromEnv(env: NodeJS.ProcessEnv, remoteUrl: string | null): string {
  const fromEnv = env.UIVERIFY_REPO || env.GITHUB_REPOSITORY || env.BITBUCKET_REPO_FULL_NAME;
  if (fromEnv) return fromEnv;
  return (remoteUrl && parseRepoFromRemote(remoteUrl)) || "";
}

function isShallowRepo(cwd: string): boolean {
  return gitOrNull(["rev-parse", "--is-shallow-repository"], cwd) === "true";
}

/**
 * The true git ancestors of `headSha` among `candidates`, computed from the LOCAL repo — a
 * client-side baseline model. The server returns the (sparse) commits a baseline could come from;
 * here we keep only those the head actually descends from, so a branch that is merely *behind*
 * the default branch never inherits a baseline blessed on a commit it doesn't contain.
 *
 * Returns `[]` for a **shallow** checkout — `git rev-list` can't see history there, so reporting "no
 * confirmed ancestors" would wrongly reject every real ancestor; the server instead falls back to its
 * unconditional inheritance (the safe pre-gate behaviour). Run CI with full history (`fetch-depth: 0`)
 * to get the gated, over-flag-free resolution. A candidate not present locally is simply absent from
 * `rev-list`, so it's treated as a non-ancestor — correct (it can't be an ancestor if it's not here).
 */
export function confirmAncestors(candidates: string[], headSha: string, cwd: string): string[] {
  if (candidates.length === 0) return [];
  if (isShallowRepo(cwd)) return [];
  const out = gitOrNull(["rev-list", headSha], cwd);
  if (out === null) return [];
  const reachable = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  return candidates.filter((c) => reachable.has(c));
}

/** One base commit's changed-file delta against the head, as sent advisory on the uploaded call. A
 *  `truncated` entry means "I could not read this base" (never "nothing changed") and carries a reason. */
export interface ClientDeltaEntry {
  files: string[];
  truncated: boolean;
  reason?: DeltaReason;
  /** The base was absent locally and fetched by SHA. */
  fetched?: boolean;
}

type DeltaReason = "not-fetched" | "fetch-failed" | "head-missing" | "git-error" | "budget" | "cap";

const DELTA_STEP_BUDGET_MS = 60_000;
const DELTA_CALL_TIMEOUT_MS = 20_000;
const DELTA_MAX_FETCHES = 4;
const DELTA_MAX_PATHS_PER_BASE = 10_000;
const DELTA_MAX_PATH_LEN = 4_096;
const DELTA_MAX_TOTAL_BYTES = 1_048_576; // 1 MiB — keep the request body small
// Above DELTA_MAX_TOTAL_BYTES so a genuinely huge delta overflows into the `cap` branch below rather
// than surfacing as Node's ENOBUFS (which would be filed under `git-error`, the undiagnosable bucket).
const DELTA_MAXBUFFER = 64 * 1024 * 1024;

/** Run git for the delta step: never prompt (fail fast on a missing credential), never lazy-fetch trees
 *  from a promisor remote (that network I/O would burn the step budget), bounded output. Returns null on
 *  any non-zero exit / timeout so the caller classifies it. */
function gitDeltaOrNull(args: string[], cwd: string, timeoutMs: number): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
      maxBuffer: DELTA_MAXBUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
    });
  } catch {
    return null;
  }
}

/**
 * Compute each base commit's changed-file delta against `head` with local git, for `--only-changed`.
 * The server names the base commits to diff against in the register response; the CLI diffs them here
 * and sends the raw file lists with the upload (the render decision stays server-side — this client
 * only reports what git says changed). Never throws: every failure becomes a per-base
 * `{ truncated: true, reason }` entry, so the upload can't be failed by the diff step. Diffs local
 * bases first, then fetches up to {@link DELTA_MAX_FETCHES} absent ones by SHA, under a
 * {@link DELTA_STEP_BUDGET_MS} step budget (each git call capped to the smaller of 20s and the budget
 * remaining, so the step never overruns).
 */
export function deltaFor(bases: string[], head: string, cwd: string): Record<string, ClientDeltaEntry> {
  const out: Record<string, ClientDeltaEntry> = {};
  if (bases.length === 0) return out;
  // Run from the repo root so paths are root-relative on every git version (no dependency on --no-relative).
  const root = gitOrNull(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
  const start = Date.now();
  const callTimeout = (): number => Math.min(DELTA_CALL_TIMEOUT_MS, DELTA_STEP_BUDGET_MS - (Date.now() - start));

  const headPresent = gitDeltaOrNull(["cat-file", "-e", `${head}^{commit}`], root, callTimeout()) !== null;
  const hasOrigin = gitOrNull(["remote", "get-url", "origin"], root) !== null;
  const shallow = isShallowRepo(root);
  let fetches = 0;
  let totalBytes = 0;

  for (const base of bases) {
    const trunc = (reason: DeltaReason, fetched?: boolean): void => {
      out[base] = fetched ? { files: [], truncated: true, reason, fetched } : { files: [], truncated: true, reason };
    };
    if (!headPresent) {
      trunc("head-missing");
      continue;
    }
    if (callTimeout() <= 0) {
      trunc("budget");
      continue;
    }

    let fetched = false;
    const present = gitDeltaOrNull(["cat-file", "-e", `${base}^{commit}`], root, callTimeout()) !== null;
    if (!present) {
      if (!hasOrigin || fetches >= DELTA_MAX_FETCHES) {
        trunc("not-fetched");
        continue;
      }
      fetches += 1;
      // A --depth=1 fetch into a full clone turns it shallow, so only shallow clones pass --depth (a full
      // clone fetches the SHA plain and stays full); GitHub serves a commit by SHA whether or not a ref
      // still reaches it, so this is also the force-push recovery path.
      const fetchArgs = shallow ? ["fetch", "--depth=1", "origin", base] : ["fetch", "origin", base];
      if (gitDeltaOrNull(fetchArgs, root, callTimeout()) === null) {
        trunc("fetch-failed");
        continue;
      }
      fetched = true;
    }

    if (callTimeout() <= 0) {
      trunc("budget", fetched);
      continue;
    }
    // Pinned so nothing in the customer's repo/runner can narrow the diff: a `.gitmodules` `ignore = all`
    // or a runner-global `diff.ignoreSubmodules = all` would silently drop a submodule pointer bump — the
    // one shape that would be a false "nothing changed". --no-renames makes a rename a delete + add. The
    // trailing `--` keeps a root file named like a sha from being read as a path.
    const raw = gitDeltaOrNull(
      // prettier-ignore
      ["-c", "diff.ignoreSubmodules=none", "-c", "diff.renames=false", "diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", base, head, "--"],
      root,
      callTimeout(),
    );
    if (raw === null) {
      trunc(callTimeout() <= 0 ? "budget" : "git-error", fetched);
      continue;
    }
    const files = raw.split("\0").filter(Boolean);
    const bytes = files.reduce((n, f) => n + f.length + 1, 0);
    if (files.length > DELTA_MAX_PATHS_PER_BASE || files.some((f) => f.length > DELTA_MAX_PATH_LEN) || totalBytes + bytes > DELTA_MAX_TOTAL_BYTES) {
      trunc("cap", fetched);
      continue;
    }
    totalBytes += bytes;
    out[base] = fetched ? { files, truncated: false, fetched: true } : { files, truncated: false };
  }
  return out;
}

export function collectGitMeta(cwd: string, env: NodeJS.ProcessEnv = process.env): GitMeta {
  const commitSha = env.COMMIT_SHA || git(["rev-parse", "HEAD"], cwd);
  const headBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return {
    commitSha,
    branch: branchFromEnv(env, headBranch),
    prNumber: prNumberFromEnv(env),
    parentShas: parseParents(git(["log", "-1", "--format=%P"], cwd)),
    repoFullName: repoFullNameFromEnv(env, gitOrNull(["remote", "get-url", "origin"], cwd)),
  };
}
