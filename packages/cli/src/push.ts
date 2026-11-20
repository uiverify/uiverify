import { spawnSync } from "node:child_process";
import type { PushFacts } from "./client";
import { FULL_SHA, checkoutGitEnv, isRecord } from "./git";

const ZERO_SHA = "0".repeat(40);

export interface PushBuild {
  /** The branch the CLI reports. */
  branch: string;
  /** The build's commit (`COMMIT_SHA` or HEAD). */
  commitSha: string;
  /** The real `git rev-parse HEAD`; null when it couldn't be read. */
  head: string | null;
}

/**
 * The facts of the CI push this build is the tip of, or null unless CI env proves they describe exactly this
 * commit on the reported branch: facts about another commit or ref would become a wrong rewrite record that
 * can't be told apart later. A tag push, a manual or scheduled run and a PR event report nothing.
 *
 * GitHub Actions reads the push event payload (a re-run reads the original one, so it reports the same facts).
 * GitLab names only the tip the push replaced, so `checkForced(before)` decides `forced` from the checkout,
 * null when it can't tell.
 */
export function pushFactsFromCi(
  env: NodeJS.ProcessEnv,
  build: PushBuild,
  readEvent: () => unknown,
  checkForced: (before: string) => boolean | null,
): PushFacts | null {
  if (build.head === null || build.commitSha !== build.head) return null;
  if (env.GITHUB_ACTIONS === "true") {
    if (env.GITHUB_EVENT_NAME !== "push") return null;
    const event = readEvent();
    if (!isRecord(event) || event.ref !== `refs/heads/${build.branch}` || event.after !== build.commitSha) return null;
    const { before, forced, created } = event;
    if (typeof before !== "string" || !FULL_SHA.test(before) || typeof forced !== "boolean" || typeof created !== "boolean") {
      return null;
    }
    return { before: before === ZERO_SHA ? null : before, forced, created };
  }
  if (env.GITLAB_CI === "true") {
    if (env.CI_PIPELINE_SOURCE !== "push" || !env.CI_COMMIT_BRANCH || env.CI_COMMIT_BRANCH !== build.branch) return null;
    if (env.CI_COMMIT_SHA !== build.commitSha) return null;
    const before = env.CI_COMMIT_BEFORE_SHA;
    if (!before || !FULL_SHA.test(before)) return null;
    if (before === ZERO_SHA) return { before: null, forced: false, created: true };
    return { before, forced: checkForced(before), created: false };
  }
  return null;
}

function gitStatus(args: string[], cwd: string): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    env: { ...checkoutGitEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/**
 * Whether the push that replaced `before` with `commit` was forced, from the checkout alone: false when
 * `before` is an ancestor of `commit` (definite even on a shallow checkout), true when the checkout is complete
 * and it isn't, null otherwise. A partial clone is never asked: git would fetch a missing commit on demand,
 * writing into the customer's `.git`, and answer from whatever it got.
 */
export function localPushForced(cwd: string, before: string, commit: string): boolean | null {
  const partial = gitStatus(["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"], cwd);
  if (partial.status !== 1) return null;
  const isAncestor = gitStatus(["merge-base", "--is-ancestor", before, commit], cwd).status;
  if (isAncestor === 0) return false;
  if (gitStatus(["rev-parse", "--is-shallow-repository"], cwd).stdout.trim() !== "false") return null;
  if (isAncestor === 1) return true;
  // A complete clone holds every ancestor of `commit`, so a `before` it lacks isn't one.
  return gitStatus(["cat-file", "-e", `${before}^{commit}`], cwd).status === 0 ? null : true;
}
