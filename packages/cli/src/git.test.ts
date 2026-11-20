import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  branchFromEnv,
  ciWatchCommand,
  collectGitMeta,
  deltaFor,
  forkRunFromCi,
  outputMayBePublic,
  workingTreeChanges,
  parseCommitParents,
  parseHostFromRemote,
  parseParents,
  parseRepoFromRemote,
  prHeadShaFromCi,
  prNumberFromEnv,
  remoteRepos,
  reportRemoteRepos,
  repoFullNameFromEnv,
  resolveSshHostAlias,
} from "./git";

/** The delta exactly as the upload computes it: the checkout's uncommitted list first, then the bases. */
function delta(
  bases: string[],
  head: string,
  cwd: string,
  opts: { exclude?: string; env?: NodeJS.ProcessEnv } = { env: {} },
): ReturnType<typeof deltaFor> {
  return deltaFor(bases, head, cwd, workingTreeChanges(head, cwd, opts));
}

describe("outputMayBePublic", () => {
  it.each([
    { CI: "true" },
    { TF_BUILD: "True" },
    { JENKINS_URL: "https://ci" },
    { TEAMCITY_VERSION: "2024.1" },
    { GITHUB_ACTIONS: "true" },
    { GITLAB_CI: "true" },
    { BUILDKITE: "true" },
    { CIRCLECI: "true" },
    { BITBUCKET_BUILD_NUMBER: "12" },
    { CODEBUILD_BUILD_ID: "proj:abc" },
    { BUILD_ID: "b-1", PROJECT_ID: "my-project" },
  ])("is true on a CI host (%o)", (env) => {
    expect(outputMayBePublic(env)).toBe(true);
  });

  /** Would catch a container check creeping in, or Cloud Build's generic BUILD_ID matching alone (Jenkins and
   *  plenty of local tools set it): both would withhold review text from the edit loop that needs it. */
  it.each([
    {},
    { BUILD_ID: "b-1" },
    { PROJECT_ID: "my-project" },
    { REMOTE_CONTAINERS: "true", CODESPACES: "true", container: "docker", HOME: "/home/node" },
  ])("is false for a local or devcontainer-like environment (%o)", (env) => {
    expect(outputMayBePublic(env)).toBe(false);
  });
});

describe("git", () => {
  it("parseParents splits the %P output and drops blanks", () => {
    expect(parseParents("abc def")).toEqual(["abc", "def"]);
    expect(parseParents("only")).toEqual(["only"]);
    expect(parseParents("   ")).toEqual([]);
  });

  it("branchFromEnv prefers BRANCH, then GITHUB_HEAD_REF, then BITBUCKET_BRANCH, then the git fallback", () => {
    expect(branchFromEnv({ BRANCH: "feat" }, "fb")).toBe("feat");
    expect(branchFromEnv({ GITHUB_HEAD_REF: "pr-branch" }, "fb")).toBe("pr-branch");
    expect(branchFromEnv({ BITBUCKET_BRANCH: "bb-branch" }, "fb")).toBe("bb-branch");
    expect(branchFromEnv({ GITHUB_HEAD_REF: "gh", BITBUCKET_BRANCH: "bb" }, "fb")).toBe("gh");
    expect(branchFromEnv({}, "fb")).toBe("fb");
  });

  it("prNumberFromEnv reads the override, the GitHub pull ref, or the Bitbucket PR id", () => {
    expect(prNumberFromEnv({ PR_NUMBER: "42" })).toBe(42);
    expect(prNumberFromEnv({ GITHUB_REF: "refs/pull/7/merge" })).toBe(7);
    expect(prNumberFromEnv({ BITBUCKET_PR_ID: "9" })).toBe(9);
    expect(prNumberFromEnv({ GITHUB_REF: "refs/pull/7/merge", BITBUCKET_PR_ID: "9" })).toBe(7);
    expect(prNumberFromEnv({ BITBUCKET_PR_ID: "nope" })).toBeNull();
    expect(prNumberFromEnv({ GITHUB_REF: "refs/heads/main" })).toBeNull();
    expect(prNumberFromEnv({})).toBeNull();
  });

  it("ciWatchCommand returns the gh watch command only on a GitHub Actions PR run", () => {
    expect(ciWatchCommand({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1900/merge" })).toBe(
      "gh pr checks 1900 --watch",
    );
    expect(ciWatchCommand({ GITHUB_ACTIONS: "true", PR_NUMBER: "42" })).toBe("gh pr checks 42 --watch");
    // Not GitHub Actions (e.g. a Bitbucket PR, or a local run) — `gh pr checks` doesn't apply.
    expect(ciWatchCommand({ BITBUCKET_PR_ID: "9" })).toBeNull();
    expect(ciWatchCommand({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1900/merge", BITBUCKET_PR_ID: "9" })).toBe(
      "gh pr checks 1900 --watch",
    );
    // On GitHub Actions but a branch push (no PR) — nothing to watch.
    expect(ciWatchCommand({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" })).toBeNull();
    expect(ciWatchCommand({})).toBeNull();
  });

  it("parseRepoFromRemote handles ssh, https, and trailing .git/slash forms", () => {
    expect(parseRepoFromRemote("git@github.com:acme/web.git")).toBe("acme/web");
    expect(parseRepoFromRemote("https://github.com/acme/web.git")).toBe("acme/web");
    expect(parseRepoFromRemote("https://github.com/acme/web")).toBe("acme/web");
    expect(parseRepoFromRemote("ssh://git@github.com/acme/web.git")).toBe("acme/web");
    expect(parseRepoFromRemote("https://github.com/acme/web/")).toBe("acme/web");
    expect(parseRepoFromRemote("not-a-url")).toBeNull();
    expect(parseRepoFromRemote("")).toBeNull();
  });

  it("parseRepoFromRemote handles a Bitbucket remote too (host-agnostic)", () => {
    expect(parseRepoFromRemote("git@bitbucket.org:acme/web.git")).toBe("acme/web");
    expect(parseRepoFromRemote("https://user@bitbucket.org/acme/web.git")).toBe("acme/web");
  });

  it("repoFullNameFromEnv prefers UIVERIFY_REPO, then GITHUB_REPOSITORY, then BITBUCKET_REPO_FULL_NAME, then remote", () => {
    expect(repoFullNameFromEnv({ UIVERIFY_REPO: "o/override" }, "git@github.com:o/remote.git")).toBe("o/override");
    expect(repoFullNameFromEnv({ GITHUB_REPOSITORY: "o/actions" }, "git@github.com:o/remote.git")).toBe("o/actions");
    expect(repoFullNameFromEnv({ BITBUCKET_REPO_FULL_NAME: "acme/web" }, "git@bitbucket.org:o/remote.git")).toBe(
      "acme/web",
    );
    expect(repoFullNameFromEnv({}, "git@bitbucket.org:acme/web.git")).toBe("acme/web");
    expect(repoFullNameFromEnv({}, null)).toBe("");
  });
});

// deltaFor talks to a real local git repo (it IS the git seam — no point faking git here).
describe("deltaFor (real git)", () => {
  let dir: string;
  let base: string;
  let head: string;
  const sha = (rev: string): string => execFileSync("git", ["rev-parse", rev], { cwd: dir, encoding: "utf8" }).trim();
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  const write = (name: string, content: string): void => fs.writeFileSync(path.join(dir, name), content);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-delta-test-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    write("foo.txt", "1");
    write("keep.txt", "k");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    base = sha("HEAD");
    // head: rename foo.txt -> renamed.txt (a real rename), modify keep.txt, add bar.txt.
    fs.rmSync(path.join(dir, "foo.txt"));
    write("renamed.txt", "1");
    write("keep.txt", "k2");
    write("bar.txt", "new");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    head = sha("HEAD");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists changed/added/deleted files for a local base, treating a rename as delete + add", () => {
    const out = delta([base], head, dir);
    const entry = out[base];
    expect(entry?.truncated).toBe(false);
    expect(entry?.fetched).toBeUndefined();
    expect([...(entry?.files ?? [])].sort()).toEqual(["bar.txt", "foo.txt", "keep.txt", "renamed.txt"]);
  });

  it("reports an absent base with no origin as not-fetched, never an error", () => {
    const out = delta(["b".repeat(40)], head, dir);
    expect(out["b".repeat(40)]).toEqual({ files: [], truncated: true, reason: "not-fetched" });
  });

  it("reports every base head-missing when the head commit is not present", () => {
    const missingHead = "f".repeat(40);
    const out = delta([base], missingHead, dir);
    expect(out[base]).toEqual({ files: [], truncated: true, reason: "head-missing" });
  });

  it("treats a base/head as revisions even when a working-tree file is named like the base sha", () => {
    // The trailing `--` in the diff argv keeps `git` from reading a sha-named path as ambiguous.
    write(base, "decoy");
    git("add", "-A");
    git("commit", "-q", "-m", "sha-named file");
    const head2 = sha("HEAD");
    const out = delta([base], head2, dir);
    expect(out[base]?.truncated).toBe(false);
    expect(out[base]?.files).toContain(base);
  });

  it("returns nothing for an empty base list on a clean checkout without touching git", () => {
    expect(deltaFor([], head, dir, [])).toEqual({});
  });

  /** A clean checkout holds exactly the commit, so a story verified at `head` has nothing to be checked
   *  against, and an entry for it would only cost a slot. */
  it("sends no entry for the head when the checkout is clean", () => {
    const current = sha("HEAD");
    expect(Object.keys(delta([base], current, dir))).toEqual([base]);
  });
});

describe("deltaFor uncommitted edits (real git)", () => {
  let dir: string;
  let base: string;
  let head: string;
  const sha = (rev: string): string => execFileSync("git", ["rev-parse", rev], { cwd: dir, encoding: "utf8" }).trim();
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  const write = (name: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-dirty-test-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    write(".gitignore", "ignored.log\n");
    write("Button.tsx", "1");
    write("Card.tsx", "1");
    write("staged.tsx", "1");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    base = sha("HEAD");
    write("committed.tsx", "1");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    head = sha("HEAD");
    // Uncommitted on top of head: an unstaged edit, a staged edit, an untracked file, an ignored file, and
    // an untracked upload dir.
    write("Button.tsx", "2");
    write("staged.tsx", "2");
    git("add", "staged.tsx");
    write("New.tsx", "1");
    write("ignored.log", "x");
    write("storybook-static/iframe.html", "<html>");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Would catch: the delta diffing commit against commit only, so a story changed by an edit that isn't
   *  committed yet is carried forward from a baseline that predates the edit. */
  it("adds staged, unstaged and untracked edits to every base's list", () => {
    const out = delta([base, head], head, dir, { exclude: path.join(dir, "storybook-static"), env: {} });
    expect(out[base]?.truncated).toBe(false);
    expect([...(out[base]?.files ?? [])].sort()).toEqual(["Button.tsx", "New.tsx", "committed.tsx", "staged.tsx"]);
    expect([...(out[head]?.files ?? [])].sort()).toEqual(["Button.tsx", "New.tsx", "staged.tsx"]);
  });

  it("leaves out ignored files and the upload dir", () => {
    const files = delta([base], head, dir, { exclude: path.join(dir, "storybook-static"), env: {} })[base]?.files ?? [];
    expect(files).not.toContain("ignored.log");
    expect(files.some((f) => f.startsWith("storybook-static/"))).toBe(false);
  });

  /** Would catch: the upload dir excluded as a glob, so a bracket in its name would also drop unrelated
   *  edits (`dist[prod]` matching a root file named `distp`). */
  it("excludes the upload dir literally, not as a pattern", () => {
    write("dist[prod]/iframe.html", "<html>");
    write("distp", "1");
    try {
      const files = delta([base], head, dir, { exclude: path.join(dir, "dist[prod]"), env: {} })[base]?.files ?? [];
      expect(files).toContain("distp");
      expect(files.some((f) => f.startsWith("dist[prod]/"))).toBe(false);
    } finally {
      fs.rmSync(path.join(dir, "dist[prod]"), { recursive: true, force: true });
      fs.rmSync(path.join(dir, "distp"), { force: true });
    }
  });

  it("lists an untracked upload dir when no exclude is given", () => {
    expect(delta([base], head, dir, { env: {} })[base]?.files).toContain("storybook-static/iframe.html");
  });

  /** Would catch two opposite mistakes. Listing what a CI step left behind (an un-ignored failure
   *  screenshot) makes the server answer with a full render on every build; dropping an edit an agent or a
   *  CI step made to a tracked file carries forward a story the bundle shows changed. */
  it.each([{ CI: "true" }, { TF_BUILD: "True" }, { JENKINS_URL: "https://ci" }, { TEAMCITY_VERSION: "2024.1" }])(
    "adds edited tracked files but no untracked ones in CI (%o)",
    (env) => {
      const out = delta([base], head, dir, { exclude: path.join(dir, "storybook-static"), env });
      expect(out[base]?.truncated).toBe(false);
      expect([...(out[base]?.files ?? [])].sort()).toEqual(["Button.tsx", "committed.tsx", "staged.tsx"]);
    },
  );

  /** Would catch `isCi` widened to the hosts `outputMayBePublic` adds: skip-unchanged would then stop counting
   *  untracked files on those hosts. */
  it.each([{ GITHUB_ACTIONS: "true" }, { GITLAB_CI: "true" }, { BUILDKITE: "true" }, { CIRCLECI: "true" }])(
    "still lists untracked files when only a host-specific variable is set (%o)",
    (env) => {
      const out = delta([base], head, dir, { exclude: path.join(dir, "storybook-static"), env });
      expect(out[base]?.files).toContain("New.tsx");
    },
  );

  /** Re-uploading a commit whose stories are already verified at it. The server decides that group
   *  from an entry keyed by the head, so it must hold the uncommitted edits, and only those. */
  it("sends the uncommitted edits as an entry keyed by the head, ahead of the bases", () => {
    const out = delta([base], head, dir, { exclude: path.join(dir, "storybook-static"), env: {} });
    expect(Object.keys(out)).toEqual([head, base]);
    expect([...(out[head]?.files ?? [])].sort()).toEqual(["Button.tsx", "New.tsx", "staged.tsx"]);
    expect(out[head]?.truncated).toBe(false);
  });

  it("sends the head entry even when the server offered no bases", () => {
    const out = delta([], head, dir, { exclude: path.join(dir, "storybook-static"), env: {} });
    expect(Object.keys(out)).toEqual([head]);
  });

  /** Would catch: a checkout git can't read being sent as clean, which carries the at-head group blind. */
  it("marks every entry, the head's too, unreadable when the uncommitted list can't be read", () => {
    expect(deltaFor([base], head, dir, null)).toEqual({
      [head]: { files: [], truncated: true, reason: "git-error" },
      [base]: { files: [], truncated: true, reason: "git-error" },
    });
  });

  /** Would catch: the working tree compared to HEAD rather than to `head`, so with a `COMMIT_SHA` that names
   *  an earlier commit, what changed between that commit and the checkout was in neither list. */
  it("covers what changed between `head` and the checked-out commit", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-override-"));
    const g = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      g("init", "-q", "-b", "main");
      g("config", "user.email", "t@t.t");
      g("config", "user.name", "t");
      fs.writeFileSync(path.join(repo, "a.ts"), "1");
      g("add", "-A");
      g("commit", "-q", "-m", "base");
      const b = g("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "named.ts"), "1");
      g("add", "-A");
      g("commit", "-q", "-m", "the commit COMMIT_SHA names");
      const named = g("rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "later.ts"), "1");
      g("add", "-A");
      g("commit", "-q", "-m", "the checked-out commit");
      expect([...(delta([b], named, repo, { env: {} })[b]?.files ?? [])].sort()).toEqual(["later.ts", "named.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("deltaFor without a checkout (real git)", () => {
  let src: string;
  let dir: string;
  let base: string;
  let head: string;
  const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeAll(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-nocheckout-src-"));
    run(src, "init", "-q", "-b", "main");
    run(src, "config", "user.email", "t@t.t");
    run(src, "config", "user.name", "t");
    fs.writeFileSync(path.join(src, "a.ts"), "1");
    fs.writeFileSync(path.join(src, "package.json"), "{}");
    run(src, "add", "-A");
    run(src, "commit", "-q", "-m", "base");
    base = run(src, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(src, "y.ts"), "1");
    run(src, "add", "-A");
    run(src, "commit", "-q", "-m", "head");
    head = run(src, "rev-parse", "HEAD");
    // The documented fork-PR upload: commits fetched as objects, HEAD pointed at them, nothing checked out.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-nocheckout-"));
    run(dir, "init", "-q");
    run(dir, "fetch", "-q", src, "main");
    run(dir, "update-ref", "HEAD", head);
  });
  afterAll(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Would catch: an empty index read as "every tracked file deleted", which put the whole repo (and its
   *  lockfile) into every base's list and made every fork PR render in full. */
  it("adds nothing for an empty index, where no checkout exists to have edits", () => {
    expect(delta([base], head, dir, { env: {} })[base]).toEqual({ files: ["y.ts"], truncated: false });
  });

  /** Would catch: an empty index read as "no edits" when files are on disk — a checkout unstaged wholesale
   *  (`git rm -r --cached .`), where a file deleted since can't be seen at all. */
  it("reports every base unreadable for an empty index with files on disk", () => {
    const unstaged = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-unstaged-"));
    try {
      run(unstaged, "init", "-q");
      run(unstaged, "fetch", "-q", src, "main");
      run(unstaged, "update-ref", "HEAD", head);
      run(unstaged, "reset", "-q", "--hard", "HEAD");
      run(unstaged, "rm", "-r", "-q", "--cached", ".");
      fs.rmSync(path.join(unstaged, "a.ts"));
      expect(delta([base], head, unstaged, { env: {} })[base]).toEqual({ files: [], truncated: true, reason: "git-error" });
    } finally {
      fs.rmSync(unstaged, { recursive: true, force: true });
    }
  });
});

describe("prHeadShaFromCi on GitHub Actions", () => {
  const H = "a".repeat(40);
  const M = "b".repeat(40);
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: M };
  const event = { pull_request: { number: 7, head: { sha: H } } };
  const prHeadShaFromEvent = (e: NodeJS.ProcessEnv, head: string, pr: number | null, read: () => unknown): string | null =>
    prHeadShaFromCi(e, head, [], pr, read);

  it("reads the payload only on a GitHub Actions pull_request or pull_request_target run", () => {
    let reads = 0;
    const read = (): unknown => {
      reads += 1;
      return event;
    };
    expect(prHeadShaFromEvent({ ...env, GITHUB_ACTIONS: undefined }, M, 7, read)).toBeNull();
    expect(prHeadShaFromEvent({ ...env, GITHUB_EVENT_NAME: "push" }, M, 7, read)).toBeNull();
    expect(prHeadShaFromEvent(env, M, null, read)).toBeNull();
    expect(reads).toBe(0);
    expect(prHeadShaFromEvent(env, M, 7, read)).toBe(H);
  });

  it("rejects a payload without a full lowercase head sha", () => {
    const at = (sha: unknown): string | null =>
      prHeadShaFromEvent(env, M, 7, () => ({ pull_request: { number: 7, head: { sha } } }));
    expect(at(H.toUpperCase())).toBeNull();
    expect(at(H.slice(0, 39))).toBeNull();
    expect(at(42)).toBeNull();
    expect(prHeadShaFromEvent(env, M, 7, () => ({ pull_request: { number: 7 } }))).toBeNull();
    expect(prHeadShaFromEvent(env, M, 7, () => null)).toBeNull();
  });
});

describe("forkRunFromCi", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_run" };
  const created = "2026-11-20T10:00:00Z";
  const payload = (run: Record<string, unknown> = {}, repository: unknown = { full_name: "acme/web" }) => ({
    workflow_run: { event: "pull_request", created_at: created, head_repository: { full_name: "someone/web" }, ...run },
    repository,
  });

  /** Would catch: the merge ref read for a `workflow_run` upload whose capture didn't render GitHub's test merge
   *  (a same-repo run, a `pull_request_target` run, a push), lending its build a base it never rendered. */
  it("names a fork's pull_request run, and nothing else", () => {
    expect(forkRunFromCi(env, 7, () => payload())).toEqual({ pr: 7, createdAt: new Date(created) });
    expect(forkRunFromCi(env, 7, () => payload({ head_repository: { full_name: "acme/web" } }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({ event: "pull_request_target" }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({ event: "push" }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({ head_repository: null }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({}, null))).toBeNull();
  });

  /** Would catch: a missing or unreadable run time taken as "now", which would pass any merge GitHub remade. */
  it("names nothing without the run's creation time", () => {
    expect(forkRunFromCi(env, 7, () => payload({ created_at: undefined }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({ created_at: "yesterday" }))).toBeNull();
    expect(forkRunFromCi(env, 7, () => payload({ created_at: 1_800_000_000 }))).toBeNull();
  });

  it("reads the payload only on a workflow_run upload for a pull request", () => {
    let reads = 0;
    const read = (): unknown => {
      reads += 1;
      return payload();
    };
    expect(forkRunFromCi({ ...env, GITHUB_EVENT_NAME: "pull_request" }, 7, read)).toBeNull();
    expect(forkRunFromCi(env, null, read)).toBeNull();
    expect(reads).toBe(0);
    expect(forkRunFromCi(env, 7, () => null)).toBeNull();
  });
});

describe("prHeadShaFromCi on Bitbucket and GitLab", () => {
  const C = "c".repeat(40);
  const T = "d".repeat(40);
  const MERGE = "e".repeat(40);
  const CHILD = "f".repeat(40);
  const bitbucket = { BITBUCKET_PR_ID: "12", BITBUCKET_COMMIT: C };
  const gitlab = { GITLAB_CI: "true", CI_MERGE_REQUEST_EVENT_TYPE: "merged_result", CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: C };
  const never = (): unknown => {
    throw new Error("only GitHub Actions has an event payload");
  };

  /** Would catch: the proof dropped (any env-named commit sent), a single-parent child of C accepted as proof
   *  (a job that commits on top renders code C never had), or the COMMIT_SHA override check skipped. */
  it.each([
    { name: "Bitbucket, HEAD is the PR commit", env: bitbucket, head: C, parents: [T], want: C },
    { name: "Bitbucket, HEAD is a merge of it", env: bitbucket, head: MERGE, parents: [T, C], want: C },
    { name: "Bitbucket, HEAD is a plain child of it", env: bitbucket, head: CHILD, parents: [C], want: null },
    { name: "Bitbucket, a merge without it", env: bitbucket, head: MERGE, parents: [T, CHILD], want: null },
    { name: "Bitbucket off a PR", env: { BITBUCKET_COMMIT: C }, head: C, parents: [T], want: null },
    { name: "GitLab merged result", env: gitlab, head: MERGE, parents: [T, C], want: C },
    { name: "GitLab merge train", env: { ...gitlab, CI_MERGE_REQUEST_EVENT_TYPE: "merge_train" }, head: MERGE, parents: [T, C], want: C },
    { name: "GitLab detached MR pipeline", env: { ...gitlab, CI_MERGE_REQUEST_EVENT_TYPE: "detached" }, head: C, parents: [T], want: null },
    { name: "GitLab, a plain child", env: gitlab, head: CHILD, parents: [C], want: null },
    { name: "GitLab vars outside GitLab CI", env: { ...gitlab, GITLAB_CI: undefined }, head: C, parents: [T], want: null },
    { name: "a COMMIT_SHA override that isn't HEAD", env: { ...bitbucket, COMMIT_SHA: C }, head: MERGE, parents: [T, C], want: null },
    { name: "a short commit", env: { ...bitbucket, BITBUCKET_COMMIT: "c".repeat(12) }, head: "c".repeat(12), parents: [], want: null },
    { name: "no HEAD", env: bitbucket, head: null, parents: [], want: null },
  ])("$name", ({ env, head, parents, want }) => {
    expect(prHeadShaFromCi(env, head, parents, 12, never)).toBe(want);
  });

  it("parseCommitParents reads the parent lines of the header only", () => {
    const object = `tree ${T}\nparent ${C}\nparent ${MERGE}\nauthor a <a> 1 +0000\n\nparent ${CHILD} in the message\n`;
    expect(parseCommitParents(object)).toEqual([C, MERGE]);
    expect(parseCommitParents(`tree ${T}\nauthor a <a> 1 +0000\n\nroot`)).toEqual([]);
  });
});

/** Would catch: the parents read with `git log --format=%P`, which a depth-1 checkout leaves empty, so a
 *  CI merge on a shallow Bitbucket checkout could never prove its PR head. */
describe("collectGitMeta prHeadSha on a depth-1 merge checkout (real git)", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-bbmerge-"));
    const g = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(root, "src"));
    const src = path.join(root, "src");
    g(src, "init", "-q", "-b", "main");
    g(src, "config", "user.email", "t@t.t");
    g(src, "config", "user.name", "t");
    g(src, "commit", "--allow-empty", "-q", "-m", "base");
    g(src, "checkout", "-q", "-b", "feat");
    g(src, "commit", "--allow-empty", "-q", "-m", "pr head");
    g(src, "checkout", "-q", "main");
    g(src, "commit", "--allow-empty", "-q", "-m", "target");
    g(src, "merge", "-q", "--no-ff", "-m", "ci merge", "feat");
    g(root, "clone", "-q", "--depth=1", `file://${src}`, "co");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("proves the PR head from the merge's own commit object", () => {
    const co = path.join(root, "co");
    const head = execFileSync("git", ["rev-parse", "feat"], { cwd: path.join(root, "src"), encoding: "utf8" }).trim();
    const meta = collectGitMeta(co, { BITBUCKET_PR_ID: "3", BITBUCKET_COMMIT: head, BITBUCKET_BRANCH: "feat" });
    expect(meta.parentShas).toEqual([]);
    expect(meta.prHeadSha).toBe(head);
  });
});

// The checkout shapes a real runner produces, over a real repo: B is the base tip, H the PR head, M
// GitHub's test merge of H into B, N a commit pushed onto the PR after the event was written.
describe("collectGitMeta prHeadSha (real git)", () => {
  let dir: string;
  let eventFile: string;
  let B: string;
  let H: string;
  let M: string;
  let N: string;
  const g = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const at = (sha: string, env: NodeJS.ProcessEnv): string | null => {
    g("checkout", "-q", "--detach", sha);
    return collectGitMeta(dir, env).prHeadSha;
  };
  const pr = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_SHA: M,
    GITHUB_EVENT_PATH: eventFile,
    ...over,
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-prhead-"));
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("remote", "add", "origin", "https://github.com/acme/web.git");
    g("commit", "--allow-empty", "-q", "-m", "fork point");
    g("checkout", "-q", "-b", "feat");
    g("commit", "--allow-empty", "-q", "-m", "pr head");
    H = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    g("commit", "--allow-empty", "-q", "-m", "base tip");
    B = g("rev-parse", "HEAD");
    g("merge", "-q", "--no-ff", "-m", "test merge", "feat");
    M = g("rev-parse", "HEAD");
    g("checkout", "-q", "feat");
    g("commit", "--allow-empty", "-q", "-m", "pushed after the event");
    N = g("rev-parse", "HEAD");
    eventFile = path.join(dir, "..", `${path.basename(dir)}-event.json`);
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7, head: { sha: H } } }));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(eventFile, { force: true });
  });

  /** Would catch: the `HEAD === GITHUB_SHA` clause dropped, so the default pull_request checkout (the
   *  event's own test merge) reports no head and its check lands on the merge commit. */
  it("sends the head on the event's merge-ref checkout", () => {
    expect(at(M, pr())).toBe(H);
  });

  /** Would catch: the `HEAD === head.sha` clause dropped (a workflow that checks out the PR head). */
  it("sends the head on a head checkout", () => {
    expect(at(H, pr())).toBe(H);
    expect(at(H, pr({ COMMIT_SHA: H }))).toBe(H);
  });

  /** Would catch: the merge-commit clause applied to pull_request_target, whose GITHUB_SHA is the base tip
   *  the default checkout renders, so the check would name a head that was never rendered. */
  it("sends nothing on a pull_request_target base-tip checkout, even with PR_NUMBER set", () => {
    const target = pr({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REF: "refs/heads/main", GITHUB_SHA: B, PR_NUMBER: "7" });
    expect(at(B, target)).toBeNull();
  });

  /** Would catch: the override clause dropped, or the commit match read from COMMIT_SHA instead of HEAD:
   *  here COMMIT_SHA names H while the tree on disk is the merge commit. */
  it("sends nothing when COMMIT_SHA differs from HEAD", () => {
    expect(at(M, pr({ COMMIT_SHA: H }))).toBeNull();
  });

  /** Would catch: accepting the payload's head whatever is checked out, after the PR moved past it. */
  it("sends nothing when the checkout is newer than the payload's head", () => {
    expect(at(N, pr())).toBeNull();
  });

  it("sends nothing when a COMMIT_SHA override matches neither the head nor the merge commit", () => {
    expect(at(N, pr({ COMMIT_SHA: N }))).toBeNull();
  });

  /** Would catch: the payload's PR number not compared with the PR the build reports. */
  it("sends nothing when the payload is for another PR", () => {
    expect(at(M, pr({ GITHUB_REF: "refs/pull/8/merge" }))).toBeNull();
  });

  it("sends nothing when the event file is missing or not JSON", () => {
    expect(at(M, pr({ GITHUB_EVENT_PATH: path.join(dir, "missing.json") }))).toBeNull();
    const bad = path.join(dir, "..", `${path.basename(dir)}-bad.json`);
    fs.writeFileSync(bad, "{not json");
    try {
      expect(at(M, pr({ GITHUB_EVENT_PATH: bad }))).toBeNull();
    } finally {
      fs.rmSync(bad, { force: true });
    }
    expect(at(M, pr({ GITHUB_EVENT_PATH: undefined }))).toBeNull();
  });

  /** Would catch: the GITHUB_ACTIONS gate dropped, so any CI that exports a stray event path reports a head. */
  it("sends nothing off GitHub Actions", () => {
    expect(at(M, pr({ GITHUB_ACTIONS: undefined }))).toBeNull();
  });
});

describe("collectGitMeta remotes (real git)", () => {
  let dir: string;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-git-remotes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-q", "-m", "c0");
    git("remote", "add", "origin", "git@github.com:me/web.git");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Would catch: a fork checkout never telling the server which repo it forked from. */
  it("reports the upstream remote's repo beside origin's, and nothing when there is no upstream", () => {
    expect(collectGitMeta(dir, {}).upstreamRepoFullName).toBeUndefined();
    git("remote", "add", "upstream", "https://github.com/acme/web.git");
    const meta = collectGitMeta(dir, {});
    expect(meta.repoFullName).toBe("me/web");
    expect(meta.upstreamRepoFullName).toBe("acme/web");
    expect(reportRemoteRepos(dir, {})).toEqual({ repoFullName: "me/web", upstreamRepoFullName: "acme/web" });
  });

  /** Would catch: the server treating a private GitLab or Bitbucket repo as GitHub's because the CLI sent no host,
   *  or a remote's token / port / path leaking into the host. */
  it.each<[string, string | null]>([
    ["git@github.com:me/web.git", "github.com"],
    ["ssh://git@ssh.github.com:443/me/web.git", "ssh.github.com"],
    ["https://gitlab-ci-token:SECRET@gitlab.com/me/web.git", "gitlab.com"],
    ["https://GitLab.com:8443/me/web", "gitlab.com"],
    ["http://proxy@127.0.0.1:41234/git/me/web", "127.0.0.1"],
    ["ssh://git@[::1]:2222/me/web.git", "::1"],
    ["git@bitbucket.org:me/web.git", "bitbucket.org"],
    ["/home/me/web", null],
    ["file:///home/me/web", null],
    ["file://127.0.0.1/srv/acme/web", null],
    ["file://fileserver/repos/web", null],
    ["C:\\src\\web", null],
    ["", null],
  ])("reads the host of the remote %s as %s", (remote, host) => {
    expect(parseHostFromRemote(remote)).toBe(host);
  });

  /** Would catch: a GitHub maintainer's `Host github-work` ssh alias reading as a non-GitHub host (it would lose the
   *  plan), or the resolver running for the common github.com remote or an https one. */
  it("resolves an ssh alias, but not for GitHub's own hosts or an https remote", () => {
    const asked: string[] = [];
    const resolve = (h: string) => {
      asked.push(h);
      return h === "github-work" ? "github.com" : h;
    };
    expect(parseHostFromRemote("git@github-work:me/web.git", resolve)).toBe("github.com");
    expect(parseHostFromRemote("ssh://git@github-work/me/web.git", resolve)).toBe("github.com");
    expect(parseHostFromRemote("git@github.com:me/web.git", resolve)).toBe("github.com");
    expect(parseHostFromRemote("https://gitlab.com/me/web.git", resolve)).toBe("gitlab.com");
    expect(asked).toEqual(["github-work", "github-work"]);
    expect(parseHostFromRemote("git@lab:me/web.git", (h) => h)).toBe("lab");
  });

  /** Runs `fn` with a stub `ssh` first on PATH, which maps `github-work` to github.com, fails for `broken`, and
   *  answers any other host as `<host>.via-ssh`; `fn` gets the stub's path. */
  function withStubSsh(fn: (ssh: string) => void): void {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vt-ssh-"));
    const ssh = path.join(bin, "ssh");
    fs.writeFileSync(
      ssh,
      '#!/bin/sh\n[ "$3" = broken ] && exit 255\nh="$3.via-ssh"; [ "$3" = github-work ] && h=github.com\nprintf "user git\\nhostname %s\\nport 22\\n" "$h"\n',
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    try {
      fn(ssh);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  /** Would catch: `ssh -G`'s `hostname` line misread, a missing or failing `ssh` throwing out of the upload instead of
   *  falling back to the alias, or a host that reads as an ssh option reaching `ssh`. */
  it("resolves an alias through ssh -G and falls back to it when ssh can't", () => {
    withStubSsh((ssh) => {
      expect(resolveSshHostAlias("github-work")).toBe("github.com");
      expect(resolveSshHostAlias("broken")).toBe("broken");
      expect(resolveSshHostAlias("-oProxyCommand=x")).toBe("-oProxyCommand=x");
      fs.rmSync(ssh);
      const savedPath = process.env.PATH;
      process.env.PATH = path.dirname(ssh);
      try {
        expect(resolveSshHostAlias("github-work")).toBe("github-work");
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });

  /** Would catch: the upload no longer resolving an ssh alias (a GitHub maintainer's `git@github-work:` remote would
   *  then be sent as a non-GitHub host and lose the plan), or the failure report starting to send the host. */
  it("resolves origin's ssh alias for the upload, and the failure report names no host", () => {
    git("remote", "set-url", "origin", "git@github-work:me/web.git");
    try {
      withStubSsh(() => {
        expect(collectGitMeta(dir, {})).toMatchObject({ repoFullName: "me/web", repoHost: "github.com" });
        expect(reportRemoteRepos(dir, {})).not.toHaveProperty("repoHost");
      });
    } finally {
      git("remote", "set-url", "origin", "git@github.com:me/web.git");
    }
  });

  /** Would catch: the host coming from a different source than the repo name (a GitHub Actions run on GHES sent as
   *  github.com, an explicit UIVERIFY_REPO taking a mismatched origin's host), or the CI-named repos reading origin. */
  it("takes the host from the same source as the repo name", () => {
    const origin = "git@gitlab.com:me/web.git";
    const asked: string[][] = [];
    const read = (args: string[]): string | null => {
      asked.push(args);
      return args[0] === "remote" ? origin : null;
    };
    const host = (env: NodeJS.ProcessEnv) => remoteRepos(env, read).repoHost;
    expect(host({})).toBe("gitlab.com");
    expect(host({ UIVERIFY_REPO: "ME/web" })).toBe("gitlab.com");
    expect(host({ UIVERIFY_REPO: "other/repo" })).toBeNull();
    asked.length = 0;
    expect(host({ GITHUB_REPOSITORY: "acme/web" })).toBe("github.com");
    expect(host({ GITHUB_REPOSITORY: "acme/web", GITHUB_SERVER_URL: "https://ghe.acme.com" })).toBe("ghe.acme.com");
    expect(host({ BITBUCKET_REPO_FULL_NAME: "acme/web" })).toBe("bitbucket.org");
    expect(asked.filter((a) => a[0] === "remote")).toEqual([]);
    expect(remoteRepos({}, () => null)).toMatchObject({ repoFullName: "", repoHost: null });
  });

  /** Would catch: a failure report naming a different repository than register would have (the server would
   *  then look for the wrong project). */
  it("names the repository the way register does, CI env first, without asking git for origin then", () => {
    const asked: string[][] = [];
    const read = (args: string[]): string | null => {
      asked.push(args);
      return args[0] === "remote" ? "git@github.com:me/web.git" : null;
    };
    expect(remoteRepos({ GITHUB_REPOSITORY: "acme/web" }, read)).toMatchObject({ repoFullName: "acme/web", upstreamRepoFullName: undefined });
    expect(asked).toEqual([["config", "--get", "remote.upstream.url"]]);
    expect(remoteRepos({}, read).repoFullName).toBe("me/web");
  });

  /** Would catch: the report's git read losing its timeout (a hung git would hold the exit up without limit)
   *  or its quiet stderr (git's own error printed into the user's output). */
  it.skipIf(process.platform === "win32")("gives up on a hung git within its timeout, printing nothing", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-fake-git-"));
    try {
      fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'fatal: hung' >&2\nsleep 5\n", { mode: 0o755 });
      const script = `import { reportRemoteRepos } from ${JSON.stringify(path.resolve(__dirname, "git.ts"))};
process.stdout.write(JSON.stringify(reportRemoteRepos(process.argv[1], {})));`;
      const started = Date.now();
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, bin], {
        cwd: __dirname,
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: os.homedir() },
        encoding: "utf8",
      });
      expect(Date.now() - started).toBeLessThan(4500);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual({ repoFullName: "" });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 20_000);

  it("reads nothing outside a checkout, without throwing", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-no-git-"));
    try {
      expect(reportRemoteRepos(outside, {})).toEqual({ repoFullName: "", upstreamRepoFullName: undefined });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
