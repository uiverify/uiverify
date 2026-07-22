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
