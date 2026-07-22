import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  branchFromEnv,
  confirmAncestors,
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
