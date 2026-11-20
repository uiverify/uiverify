import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localPushForced, pushFactsFromCi } from "./push";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const build = { branch: "main", commitSha: A, head: A };
const never = (): boolean | null => {
  throw new Error("forced must not be checked");
};

describe("pushFactsFromCi on GitHub Actions", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };
  const event = { ref: "refs/heads/main", after: A, before: B, forced: true, created: false };

  it("reports the push event's facts for the build's own commit on its branch", () => {
    expect(pushFactsFromCi(env, build, () => event, never)).toEqual({ before: B, forced: true, created: false });
  });

  it("reports a created branch with no before", () => {
    const created = { ...event, before: ZERO, forced: false, created: true };
    expect(pushFactsFromCi(env, build, () => created, never)).toEqual({ before: null, forced: false, created: true });
  });

  /** Would catch: facts about another ref or commit becoming a wrong rewrite record of this branch. */
  it.each([
    { name: "a tag push", env, event: { ...event, ref: "refs/tags/v1" }, b: build },
    { name: "a push of another branch", env, event: { ...event, ref: "refs/heads/other" }, b: build },
    { name: "a ref moved past the build's commit", env, event: { ...event, after: B }, b: build },
    { name: "a COMMIT_SHA override away from HEAD", env, event, b: { ...build, head: B } },
    { name: "an unreadable HEAD", env, event, b: { ...build, head: null } },
    { name: "a manual run", env: { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }, event, b: build },
    { name: "a pull request event", env: { ...env, GITHUB_EVENT_NAME: "pull_request" }, event, b: build },
    { name: "a payload with a malformed before", env, event: { ...event, before: "abc" }, b: build },
    { name: "a payload without forced", env, event: { ...event, forced: undefined }, b: build },
    { name: "no payload", env, event: null, b: build },
  ])("reports nothing for $name", ({ env: e, event: ev, b }) => {
    expect(pushFactsFromCi(e, b, () => ev, never)).toBeNull();
  });
});

describe("pushFactsFromCi on GitLab", () => {
  const env = {
    GITLAB_CI: "true",
    CI_PIPELINE_SOURCE: "push",
    CI_COMMIT_BRANCH: "main",
    CI_COMMIT_SHA: A,
    CI_COMMIT_BEFORE_SHA: B,
  };

  it("decides forced from the checkout, passing it the replaced tip", () => {
    const asked: string[] = [];
    const facts = pushFactsFromCi(env, build, () => null, (before) => (asked.push(before), false));
    expect(facts).toEqual({ before: B, forced: false, created: false });
    expect(asked).toEqual([B]);
  });

  it("keeps an undecided forced as null", () => {
    expect(pushFactsFromCi(env, build, () => null, () => null)).toEqual({ before: B, forced: null, created: false });
  });

  it("reports a created branch without asking the checkout", () => {
    expect(pushFactsFromCi({ ...env, CI_COMMIT_BEFORE_SHA: ZERO }, build, () => null, never)).toEqual({
      before: null,
      forced: false,
      created: true,
    });
  });

  it.each([
    { name: "a tag pipeline", env: { ...env, CI_COMMIT_BRANCH: undefined } },
    { name: "a merge request pipeline", env: { ...env, CI_PIPELINE_SOURCE: "merge_request_event" } },
    { name: "another branch than the reported one", env: { ...env, CI_COMMIT_BRANCH: "other" } },
    { name: "a pipeline commit other than the build's", env: { ...env, CI_COMMIT_SHA: B } },
    { name: "no before", env: { ...env, CI_COMMIT_BEFORE_SHA: undefined } },
  ])("reports nothing for $name", ({ env: e }) => {
    expect(pushFactsFromCi(e, build, () => null, never)).toBeNull();
  });

  it("reports nothing outside a known CI", () => {
    expect(pushFactsFromCi({}, build, () => null, never)).toBeNull();
  });
});

const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const visit = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      h.update(p);
      if (st.isDirectory()) visit(p);
      else h.update(fs.readFileSync(p));
    }
  };
  visit(dir);
  return h.digest("hex");
}

describe("localPushForced (real git)", () => {
  let root: string;
  let origin: string;
  const commits: string[] = [];
  let sideTip: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-push-")));
    origin = path.join(root, "origin");
    fs.mkdirSync(origin);
    g(origin, "init", "-q", "-b", "main");
    g(origin, "config", "user.email", "t@example.com");
    g(origin, "config", "user.name", "t");
    g(origin, "config", "uploadpack.allowFilter", "true");
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(origin, "f.txt"), `v${i}\n`);
      g(origin, "add", "f.txt");
      g(origin, "commit", "-q", "-m", `c${i}`);
      commits.push(g(origin, "rev-parse", "HEAD"));
    }
    g(origin, "checkout", "-q", "-b", "side", commits[2] ?? "");
    fs.writeFileSync(path.join(origin, "side.txt"), "side\n");
    g(origin, "add", "side.txt");
    g(origin, "commit", "-q", "-m", "side");
    sideTip = g(origin, "rev-parse", "HEAD");
    g(origin, "checkout", "-q", "main");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const tip = (): string => commits[5] ?? "";
  const clone = (name: string, ...flags: string[]): string => {
    const dir = path.join(root, name);
    g(root, "clone", "-q", ...flags, `file://${origin}`, dir);
    return dir;
  };

  it("answers false for an ordinary push, even on a shallow checkout", () => {
    const co = clone("shallow-ff", "--depth=3", "--branch=main");
    expect(localPushForced(co, commits[3] ?? "", tip())).toBe(false);
  });

  it("answers true on a complete clone when the replaced tip isn't an ancestor", () => {
    const co = clone("full", "--no-single-branch");
    expect(localPushForced(co, sideTip, tip())).toBe(true);
  });

  it("answers true on a complete clone that never saw the replaced tip", () => {
    const co = clone("full-single", "--single-branch", "--branch=main");
    expect(localPushForced(co, "c".repeat(40), tip())).toBe(true);
  });

  /** Would catch: a shallow checkout that lacks the replaced tip read as a forced push, when the tip may just be
   *  older than the checkout's depth. */
  it("can't tell on a shallow checkout that lacks the replaced tip", () => {
    const co = clone("shallow-old", "--depth=1", "--branch=main");
    expect(localPushForced(co, commits[1] ?? "", tip())).toBeNull();
  });

  /** Would catch: the check run in a partial clone, where a git that ignores `GIT_NO_LAZY_FETCH` fetches a
   *  missing commit on demand, writing a pack into the customer's `.git`, and a complete-looking clone then
   *  answers "forced" for a tip it merely hasn't downloaded. */
  it("never asks a partial clone, leaving its .git untouched", () => {
    const co = clone("blobless", "--filter=blob:none", "--branch=main");
    const before = hashTree(path.join(co, ".git"));
    expect(localPushForced(co, "c".repeat(40), tip())).toBeNull();
    expect(hashTree(path.join(co, ".git"))).toBe(before);
  });
});
