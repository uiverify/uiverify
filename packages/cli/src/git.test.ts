import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  branchFromEnv,
  ciWatchCommand,
  confirmAncestors,
  deltaFor,
  parseParents,
  parseRepoFromRemote,
  prNumberFromEnv,
  repoFullNameFromEnv,
} from "./git";

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

// confirmAncestors talks to a real local git repo (it IS the git seam — no point faking git here).
describe("confirmAncestors (real git)", () => {
  let dir: string;
  const sha = (rev: string): string => execFileSync("git", ["rev-parse", rev], { cwd: dir, encoding: "utf8" }).trim();
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-git-test-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-q", "-m", "c0"); // fork base
    git("checkout", "-q", "-b", "feat");
    git("commit", "--allow-empty", "-q", "-m", "feat1"); // feature head (behind main below)
    // main advances past the fork point with a commit the feature branch does NOT contain.
    git("checkout", "-q", "main");
    git("commit", "--allow-empty", "-q", "-m", "main-drift");
    git("checkout", "-q", "feat");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps candidates in the head's ancestry, drops commits the head doesn't contain", () => {
    const base = sha("main~1"); // c0 — the fork point, an ancestor of feat
    const featHead = sha("feat");
    const drift = sha("main"); // main-drift — NOT in feat's ancestry
    const got = confirmAncestors([base, drift, "0".repeat(40)], featHead, dir);
    expect(got).toContain(base); // fork point: a true ancestor
    expect(got).not.toContain(drift); // default-branch drift: rejected
    expect(got).not.toContain("0".repeat(40)); // unknown commit: rejected
  });

  it("returns [] for empty candidates without touching git", () => {
    expect(confirmAncestors([], sha("feat"), dir)).toEqual([]);
  });
});

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
    const out = deltaFor([base], head, dir);
    const entry = out[base];
    expect(entry?.truncated).toBe(false);
    expect(entry?.fetched).toBeUndefined();
    expect([...(entry?.files ?? [])].sort()).toEqual(["bar.txt", "foo.txt", "keep.txt", "renamed.txt"]);
  });

  it("reports an absent base with no origin as not-fetched, never an error", () => {
    const out = deltaFor(["b".repeat(40)], head, dir);
    expect(out["b".repeat(40)]).toEqual({ files: [], truncated: true, reason: "not-fetched" });
  });

  it("reports every base head-missing when the head commit is not present", () => {
    const missingHead = "f".repeat(40);
    const out = deltaFor([base], missingHead, dir);
    expect(out[base]).toEqual({ files: [], truncated: true, reason: "head-missing" });
  });

  it("treats a base/head as revisions even when a working-tree file is named like the base sha", () => {
    // The trailing `--` in the diff argv keeps `git` from reading a sha-named path as ambiguous.
    write(base, "decoy");
    git("add", "-A");
    git("commit", "-q", "-m", "sha-named file");
    const head2 = sha("HEAD");
    const out = deltaFor([base], head2, dir);
    expect(out[base]?.truncated).toBe(false);
    expect(out[base]?.files).toContain(base);
  });

  it("returns nothing for an empty base list without touching git", () => {
    expect(deltaFor([], head, dir)).toEqual({});
  });
});
