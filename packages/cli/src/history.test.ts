import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deltaFor } from "./git";
import {
  type HistoryGraph,
  MAX_HISTORY_LINKS,
  addRevListLine,
  fitUploadedBody,
  forkRunMerge,
  historyStep,
  matchOffered,
  newHistoryGraph,
  parseConfigList,
  readHistory,
  secretsOf,
  stripCredentials,
} from "./history";

const g = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

function tmpDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `uiverify-${name}-`)));
}

/** Every file under `.git`, path and content: what "the checkout was never written" is checked against. */
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const visit = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}\0`);
      if (st.isDirectory()) visit(p);
      else h.update(fs.readFileSync(p));
    }
  };
  visit(dir);
  return h.digest("hex");
}

/** A deterministic fast-import stream: `n` commits, the k-th with parents `parents(k)` (1-based marks). */
function fastImport(repo: string, n: number, parents: (k: number) => number[], blobs: (k: number) => Buffer | null = () => null): Map<number, string> {
  const chunks: Buffer[] = [];
  for (let k = 1; k <= n; k++) {
    const msg = `c${k}`;
    const ps = parents(k);
    let header = `commit refs/heads/main\nmark :${k}\ncommitter t <t@t> ${1_700_000_000 + k} +0000\ndata ${msg.length}\n${msg}\n`;
    if (ps[0] !== undefined) header += `from :${ps[0]}\n`;
    for (const p of ps.slice(1)) header += `merge :${p}\n`;
    chunks.push(Buffer.from(header));
    const blob = blobs(k);
    if (blob) chunks.push(Buffer.from(`M 644 inline big-${k}.bin\ndata ${blob.length}\n`), blob, Buffer.from("\n"));
    chunks.push(Buffer.from("\n"));
  }
  const marks = path.join(os.tmpdir(), `uiverify-marks-${process.pid}-${Date.now()}`);
  execFileSync("git", ["fast-import", "--quiet", `--export-marks=${marks}`], { cwd: repo, input: Buffer.concat(chunks) });
  const out = new Map<number, string>();
  for (const line of fs.readFileSync(marks, "utf8").split("\n")) {
    const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
    if (m) out.set(Number(m[1]), m[2] ?? "");
  }
  fs.rmSync(marks, { force: true });
  return out;
}

/** A bare "remote" serving partial fetches over `file://`. */
function bareRemote(root: string, n: number, parents: (k: number) => number[], blobs?: (k: number) => Buffer | null) {
  const remote = path.join(root, "remote.git");
  g(root, "init", "-q", "--bare", remote);
  const marks = fastImport(remote, n, parents, blobs);
  g(remote, "config", "uploadpack.allowFilter", "true");
  return { remote, url: `file://${remote}`, marks, sha: (k: number): string => marks.get(k) ?? "" };
}

/** A checkout made the way `actions/checkout` makes one: depth 1, the commit fetched by sha. */
function actionsCheckout(root: string, url: string, sha: string, opts: { blobless?: boolean; name?: string } = {}): string {
  const co = path.join(root, opts.name ?? "co");
  fs.mkdirSync(co);
  g(co, "init", "-q");
  g(co, "remote", "add", "origin", url);
  const filter = opts.blobless ? ["--filter=blob:none"] : [];
  g(co, "-c", "protocol.version=2", "fetch", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", ...filter, "origin", `+${sha}:refs/remotes/origin/main`);
  g(co, "checkout", "-q", "--force", "-B", "main", "refs/remotes/origin/main");
  return co;
}

const linear = (k: number): number[] => (k > 1 ? [k - 1] : []);

/** A PATH entry whose `git` logs its argv (and can lie about its version) before running the real one. */
function gitShim(root: string, opts: { version?: string } = {}): { log: () => string[]; restore: () => void } {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = path.join(root, "shim");
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "argv.log");
  const lie = opts.version ? `if [ "$1" = version ]; then echo "git version ${opts.version}"; exit 0; fi\n` : "";
  fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\n${lie}exec '${real}' "$@"\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before ?? ""}`;
  return {
    log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
    restore: () => {
      process.env.PATH = before;
    },
  };
}

/** A PATH whose `git fetch` (or the git command `on` names) hangs in a child it starts (as a remote helper would),
 *  recording that child's pid. */
function hungFetchShim(root: string, name: string, on = "fetch"): { path: string; started: () => number[]; survivors: () => Promise<number[]> } {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const pids = path.join(dir, "pids");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh\ncase " $* " in *" ${on} "*) sleep 600 & echo $! >> '${pids}'; wait; exit 1;; esac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const started = (): number[] => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    path: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    started,
    survivors: async () => {
      expect(started().length).toBeGreaterThan(0);
      for (let i = 0; i < 20 && started().some(alive); i++) await new Promise((r) => setTimeout(r, 100));
      const left = started().filter(alive);
      for (const pid of left) process.kill(pid, "SIGKILL");
      return left;
    },
  };
}

// ---- The graph: links against a brute-force oracle ---------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Each matched commit's nearest matched ancestors, from full ancestor sets: none of the cleverness under test. */
function oracleLinks(graph: HistoryGraph, offered: Set<string>): { shas: string[]; links: number[][] } {
  const memo = new Map<number, Set<number>>();
  const ancestorsOf = (v: number): Set<number> => {
    const known = memo.get(v);
    if (known) return known;
    const out = new Set<number>();
    for (const p of graph.parents[v] ?? []) {
      out.add(p);
      for (const a of ancestorsOf(p)) out.add(a);
    }
    memo.set(v, out);
    return out;
  };
  const shas = graph.order.map((i) => graph.shas[i] ?? "").filter((s) => offered.has(s));
  const pos = new Map(shas.map((s, i) => [s, i]));
  const links = shas.map((sha) => {
    const v = graph.index.get(sha) ?? -1;
    const matched = [...ancestorsOf(v)].filter((a) => offered.has(graph.shas[a] ?? ""));
    const nearest = matched.filter((a) => !matched.some((b) => b !== a && ancestorsOf(b).has(a)));
    return nearest.map((a) => pos.get(graph.shas[a] ?? "") ?? -1).sort((x, y) => x - y);
  });
  return { shas, links };
}

describe("matchOffered", () => {
  /** Would catch: a merge's frontier not reduced to an antichain (both a commit and its own ancestor linked). */
  it("links a merge only to the nearest matched commit of each line", () => {
    // d merges b and c; c descends from b; offered: b, c, a (the root).
    const graph = newHistoryGraph();
    for (const line of ["d c b", "c b", "b a", "a"]) addRevListLine(graph, line);
    expect(matchOffered(graph, ["a", "b", "c", "d"])).toEqual({ shas: ["d", "c", "b", "a"], links: [[1], [2], [3], []] });
    expect(matchOffered(graph, ["a", "b", "c"])).toEqual({ shas: ["c", "b", "a"], links: [[1], [2], []] });
    expect(matchOffered(graph, ["x"])).toEqual({ shas: [], links: [] });
  });

  /** Would catch any wrong link on a real merge-heavy history: octopus merges, criss-cross merges, offered
   *  commits on parallel lines, read through the same `rev-list` the CLI streams. */
  it("matches a brute-force oracle on a merge-heavy graph", async () => {
    const root = tmpDir("oracle");
    try {
      const random = rng(7);
      const n = 400;
      const repo = path.join(root, "repo.git");
      g(root, "init", "-q", "--bare", repo);
      const tips = new Set<number>();
      const marks = fastImport(repo, n, (k) => {
        if (k === 1) return [];
        const ps = new Set<number>([k - 1 - Math.floor(random() * Math.min(k - 1, 12))]);
        const r = random();
        if (r < 0.3) ps.add(1 + Math.floor(random() * (k - 1)));
        if (r < 0.08) ps.add(1 + Math.floor(random() * (k - 1)));
        if (k === n) for (const t of tips) ps.add(t);
        for (const p of ps) tips.delete(p);
        tips.add(k);
        return [...ps];
      });
      const head = marks.get(n) ?? "";
      const read = await readHistory(repo, head, { shallow: false });
      if (read.kind !== "read") throw new Error(read.reason);
      for (const share of [0.05, 0.3, 0.9]) {
        const offered = [...marks.values()].filter(() => random() < share);
        const got = matchOffered(read.graph, offered);
        expect(got).toEqual(oracleLinks(read.graph, new Set(offered)));
        got.links.forEach((l, i) => l.forEach((j) => expect(j).toBeGreaterThan(i)));
      }
      expect(oracleLinks(read.graph, new Set(marks.values())).links.some((l) => l.length >= 3)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- A full clone ------------------------------------------------------------------------------------------

describe("historyStep on a full clone (real git)", () => {
  let root: string;
  let repo: string;
  let sha: (k: number) => string;
  beforeAll(() => {
    root = tmpDir("full");
    const r = bareRemote(root, 30_000, linear);
    repo = path.join(root, "clone");
    g(root, "clone", "-q", "--no-checkout", r.url, repo);
    sha = r.sha;
  }, 60_000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Would catch: the walk read through a buffered `execFileSync` (its 1 MiB buffer overflows past ~25,600
   *  commits, and today's code then silently sends no ancestry at all). */
  it("walks a 30,000-commit history and sends its contained offer, in offer order", async () => {
    const other = "e".repeat(40);
    const out = await historyStep(repo, { offered: [sha(10), other, sha(29_990), sha(1)], commit: sha(30_000), fetchHistory: false, pushBefore: null });
    expect(out.ancestorShas).toEqual([sha(10), sha(29_990), sha(1)]);
    expect(out.history).toEqual({ shas: [sha(29_990), sha(10), sha(1)], links: [[1], [2], []], truncated: false });
    expect(out.historyRead).toMatchObject({ mode: "local", fetchedBytes: null });
    expect(out.fetchedCommits).toBeUndefined();
  }, 60_000);

  it("reads nothing when nothing was offered and no push needs it", async () => {
    const shim = gitShim(root);
    try {
      expect(await historyStep(repo, { offered: [], commit: sha(30_000), fetchHistory: true, pushBefore: null })).toEqual({ ancestorShas: [], shallow: false });
      expect(shim.log()).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a full clone's walk failing (the commit isn't here) reported as an empty read, which
   *  would claim "contains none of the offer". */
  it("reports a failed walk as unavailable, with no ancestry", async () => {
    const out = await historyStep(repo, { offered: [sha(1)], commit: "d".repeat(40), fetchHistory: false, pushBefore: null });
    expect(out.ancestorShas).toEqual([]);
    expect(out.history).toMatchObject({ unavailable: expect.any(String) });
    expect(out.historyRead?.mode).toBe("failed");
  });

  /** Would catch: the local walk refusing a commit that isn't 40 lowercase hex (a short or upper-case
   *  `COMMIT_SHA`), which the walk it replaced accepted, so a full clone's ancestry would drop to none. */
  it("walks a full clone from a short or upper-case commit", async () => {
    for (const commit of [sha(30_000).slice(0, 12), sha(30_000).toUpperCase()]) {
      const out = await historyStep(repo, { offered: [sha(10)], commit, fetchHistory: false, pushBefore: null });
      expect(out.ancestorShas).toEqual([sha(10)]);
      expect(out.historyRead?.mode).toBe("local");
    }
  }, 60_000);

  /** Would catch: a GitLab push's undecided `forced` left undecided by a complete local walk. */
  it("decides a push's forced from a complete walk", async () => {
    const step = (pushBefore: string) => historyStep(repo, { offered: [], commit: sha(30_000), fetchHistory: false, pushBefore });
    expect((await step(sha(29_000))).pushForced).toBe(false);
    expect((await step("d".repeat(40))).pushForced).toBe(true);
  }, 60_000);
});

// ---- A shallow checkout ------------------------------------------------------------------------------------

describe("historyStep on a shallow checkout (real git)", () => {
  let root: string;
  let url: string;
  let sha: (k: number) => string;
  const N = 60;
  // Commits 1..40 on main; 41..50 a side line from 20; 51 merges 40 and 50; 52..60 on main.
  const parents = (k: number): number[] => (k === 41 ? [20] : k === 51 ? [40, 50] : linear(k));
  beforeAll(() => {
    root = tmpDir("shallow");
    const r = bareRemote(root, N, parents);
    url = r.url;
    sha = r.sha;
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const offered = (): string[] => [sha(5), sha(45), sha(30), sha(58), "e".repeat(40)];
  const expected = () => ({ shas: [sha(58), sha(45), sha(30), sha(5)], links: [[1, 2], [3], [3], []], truncated: false });

  it.each([{ blobless: false }, { blobless: true }])(
    "fetches the full ordered, linked history without writing the checkout (blobless: $blobless)",
    async ({ blobless }) => {
      const co = actionsCheckout(root, url, sha(N), { blobless, name: `co-${blobless}` });
      const before = hashTree(path.join(co, ".git"));
      const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual(expected());
      expect(out.ancestorShas).toEqual([]);
      expect(out.historyRead?.mode).toBe("fetched");
      expect(out.historyRead?.fetchedBytes).toBeGreaterThan(0);
      expect(out.fetchedCommits).toBe(N);
      expect(hashTree(path.join(co, ".git"))).toBe(before);
    },
  );

  /** Would catch: an inherited `GIT_COMMON_DIR` (set by a hook or a worktree-aware wrapper) pointing the
   *  temporary repository's fetch at the checkout's object store, writing a pack into it. */
  it("doesn't write the checkout when GIT_COMMON_DIR points at it", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-common-dir" });
    const before = hashTree(path.join(co, ".git"));
    process.env.GIT_COMMON_DIR = path.join(co, ".git");
    try {
      const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual(expected());
    } finally {
      delete process.env.GIT_COMMON_DIR;
    }
    expect(hashTree(path.join(co, ".git"))).toBe(before);
  });

  /** Would catch: a shallow checkout refusing a short or upper-case `COMMIT_SHA` it has locally, sending no
   *  history where a fetch would have read one. */
  it("fetches from a short or upper-case commit", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-short-commit" });
    for (const commit of [sha(N).slice(0, 12), sha(N).toUpperCase()]) {
      const out = await historyStep(co, { offered: offered(), commit, fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual(expected());
    }
  });

  /** Would catch: a timed-out fetch killing only git, leaving what git started (over HTTP without protocol v2,
   *  the remote helper's fetch-pack) downloading into the temporary repository after the CLI gave up. */
  it("kills everything a timed-out fetch started", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-hung-fetch" });
    const hung = hungFetchShim(root, "hung-timeout");
    const before = process.env.PATH;
    process.env.PATH = hung.path;
    try {
      const out = await readHistory(co, sha(N), { shallow: true, budgetMs: 2_000 });
      expect(out).toMatchObject({ kind: "unavailable", reason: "reading the git history took longer than 2 s" });
    } finally {
      process.env.PATH = before;
    }
    expect(await hung.survivors()).toEqual([]);
  });

  /** Would catch: git, in its own process group, left fetching when the CLI is cancelled (Ctrl-C, a CI
   *  cancel, a closed terminal) because the signal wasn't passed on, the temporary repository holding part of
   *  the history left behind, or the CLI no longer dying of the signal. */
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("passes %s on to a running fetch, then dies of it", async (signal) => {
    const co = actionsCheckout(root, url, sha(N), { name: `co-${signal}` });
    const hung = hungFetchShim(root, `hung-${signal}`);
    const script = `import { readHistory } from ${JSON.stringify(path.resolve(__dirname, "history.ts"))};
await readHistory(${JSON.stringify(co)}, ${JSON.stringify(sha(N))}, { shallow: true, budgetMs: 60_000 });`;
    const tmp = path.join(root, `tmp-${signal}`);
    fs.mkdirSync(tmp);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, PATH: hung.path, TMPDIR: tmp },
      stdio: "ignore",
    });
    while (hung.started().length === 0) await new Promise((r) => setTimeout(r, 50));
    child.kill(signal);
    const [, died] = await new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (code, sig) => r([code, sig])));
    expect(died).toBe(signal);
    expect(await hung.survivors()).toEqual([]);
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith("uiverify-history-"))).toEqual([]);
  }, 30_000);

  /** Would catch: a full commit sha the shallow checkout lacks (a pull request's head under its merge commit)
   *  refused, though the remote serves it. */
  it("fetches from a full commit the checkout doesn't have", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-absent-commit" });
    const out = await readHistory(co, sha(40), { shallow: true });
    expect(out).toMatchObject({ kind: "read", mode: "fetched" });
  });

  /** Would catch: a shallow checkout fetching although the server didn't ask (the flag is the only way to stop
   *  the new per-build cost), or sending a history nobody asked for. */
  it("fetches nothing and sends no history when the server didn't ask", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-not-asked" });
    const shim = gitShim(root);
    try {
      const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: false, pushBefore: null });
      expect(out).toEqual({ ancestorShas: [], shallow: true });
      expect(shim.log().filter((l) => l.includes("fetch"))).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a shared temp path, or anything written into the checkout, breaking a second upload running
   *  at the same time, or the skip-unchanged diff after it. */
  it("serves two uploads in parallel, and deltaFor still works after", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-parallel" });
    const input = { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null };
    const [a, b] = await Promise.all([historyStep(co, input), historyStep(co, input)]);
    expect(a.history).toEqual(expected());
    expect(b.history).toEqual(expected());
    const delta = deltaFor([sha(58)], sha(N), co, []);
    expect(delta[sha(58)]).toMatchObject({ truncated: false });
  });

  /** Would catch: the fetch run without the checkout's own resolved config: here the remote is reachable only
   *  through an `insteadOf` in a file included for this checkout's git dir alone, which a separate repository
   *  wouldn't load by itself, carrying an auth header that must never reach a command line. */
  it("fetches through config the checkout includes conditionally, with no secret on argv", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-include" });
    const secretHeader = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==";
    const included = path.join(root, "include-config");
    fs.writeFileSync(included, `[url "${url}"]\n\tinsteadOf = https://bogus.invalid/acme/web.git\n[http "https://bogus.invalid/"]\n\textraheader = ${secretHeader}\n`);
    g(co, "config", "remote.origin.url", "https://bogus.invalid/acme/web.git");
    g(co, "config", `includeIf.gitdir:${fs.realpathSync(path.join(co, ".git"))}.path`, included);
    const shim = gitShim(root);
    try {
      const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual(expected());
      const argv = shim.log().join("\n");
      expect(argv).toContain("fetch");
      expect(argv).not.toContain(secretHeader);
      expect(argv).not.toContain("eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==");
      expect(argv).not.toContain(url);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: an ssh-key checkout's `core.sshCommand` (local config, the only way to the remote) not
   *  reaching the temporary repository's fetch. */
  it("fetches over ssh through the checkout's core.sshCommand", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-ssh" });
    g(path.join(root, "remote.git"), "config", "uploadpack.allowAnySHA1InWant", "true");
    const fakeSsh = path.join(root, "fake-ssh");
    fs.writeFileSync(fakeSsh, '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n', { mode: 0o755 });
    g(co, "config", "remote.origin.url", `ssh://fakehost${path.join(root, "remote.git")}`);
    g(co, "config", "core.sshCommand", fakeSsh);
    g(co, "config", "ssh.variant", "simple");
    const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
    expect(out.history).toEqual(expected());
  });

  /** Would catch: a commit the CI made locally (`not our ref` on the remote) ending the read, instead of
   *  walking from its parents with the commit itself prepended. */
  it("walks a local merge commit from its parents", async () => {
    const co = actionsCheckout(root, url, sha(40), { name: "co-merge" });
    g(co, "fetch", "-q", "--no-tags", "--depth=1", "origin", sha(50));
    const merge = g(co, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${sha(40)}^{tree}`, "-p", sha(40), "-p", sha(50), "-m", "ci merge");
    g(co, "checkout", "-q", "--detach", merge);
    const out = await historyStep(co, { offered: [sha(45), sha(30), sha(5), merge], commit: merge, fetchHistory: true, pushBefore: null });
    expect(out.history).toEqual({ shas: [merge, sha(45), sha(30), sha(5)], links: [[1, 2], [3], [3], []], truncated: false });
    expect(out.historyRead?.mode).toBe("fetched");
  });

  /** Would catch: the reported git version not checked, so an old git runs a fetch whose config it can't
   *  isolate (`GIT_CONFIG_GLOBAL` needs 2.32). */
  it("reports a git older than 2.32 as unavailable, naming it", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-oldgit" });
    const shim = gitShim(path.join(root, "old"), { version: "2.30.1" });
    try {
      const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual({ unavailable: expect.stringContaining("git 2.30 is older than 2.32") });
      expect(out.historyRead?.mode).toBe("failed");
      expect(shim.log().filter((l) => l.includes("fetch"))).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a credential in the remote URL or an auth header reaching the stored reason. */
  it("reports a failed fetch with no credential in the reason", async () => {
    const co = actionsCheckout(root, url, sha(N), { name: "co-badremote" });
    const token = "ghs_FAKEtoken1234567890abcdef";
    const header = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0dmFsdWU=";
    g(co, "config", "remote.origin.url", `https://x-access-token:${token}@127.0.0.1:9/acme/${token}.git`);
    g(co, "config", "http.https://127.0.0.1:9/.extraheader", header);
    const out = await historyStep(co, { offered: offered(), commit: sha(N), fetchHistory: true, pushBefore: null });
    const reason = out.history && "unavailable" in out.history ? out.history.unavailable : "";
    expect(reason).not.toBe("");
    expect(reason).not.toContain(token);
    expect(reason).not.toContain("c2VjcmV0dmFsdWU");
    expect(out.historyRead?.mode).toBe("failed");
  });
});

// ---- A fork pull request uploaded by the /docs fork recipe ----------------------------------------------

describe("historyStep for a fork recipe's upload (real git)", () => {
  let root: string;
  let remote: string;
  let url: string;
  let sha: (k: number) => string;
  // The base repo: main is 1..10; the fork branched from 5 (11..13, its head 13), and main moved on to 10.
  const parents = (k: number): number[] => (k === 11 ? [5] : linear(k));
  const head = (): string => sha(13);
  const RUN_CREATED = 1_800_000_000;
  beforeAll(() => {
    root = tmpDir("fork");
    const r = bareRemote(root, 13, parents);
    remote = r.remote;
    url = r.url;
    sha = r.sha;
    g(remote, "update-ref", "refs/heads/main", sha(10));
    g(remote, "update-ref", "refs/pull/7/head", head());
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** GitHub's test merge of the PR: parents [base, second], made at `at` (seconds). */
  function testMerge(base: string, second: string, at: number): string {
    return execFileSync("git", ["commit-tree", `${second}^{tree}`, "-p", base, "-p", second, "-m", "Merge into main"], {
      cwd: remote,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` },
    }).trim();
  }
  const setMergeRef = (merge: string): void => void g(remote, "update-ref", "refs/pull/7/merge", merge);

  /** The recipe's checkout: objects only, every commit of the head, no blobs, HEAD at the head. */
  function recipeCheckout(name: string): string {
    const co = path.join(root, name);
    fs.mkdirSync(co);
    g(co, "init", "-q");
    g(co, "remote", "add", "origin", url);
    g(co, "fetch", "-q", "--filter=blob:none", "--no-tags", "origin", head());
    g(co, "update-ref", "HEAD", head());
    return co;
  }
  const run = (mergeSha: string, createdAt = RUN_CREATED) => ({ mergeSha, createdAt: new Date(createdAt * 1000) });
  // Main's approvals pinned to 8 (after the fork point) and 3 (before it); 12 is the head's own; one unknown.
  const offered = (): string[] => [sha(8), sha(3), sha(12), "e".repeat(40)];
  const headOnly = () => ({ shas: [sha(12), sha(3)], links: [[1], []], truncated: false });

  /** Would catch: a fork recipe's upload sending only its head's history, so main's approval at 8, which the
   *  rendered merge contains, reads as behind and the build is compared with main's look at the fork point. */
  it("adds the base its run's test merge was made on, keeping the ancestry the head's alone", async () => {
    setMergeRef(testMerge(sha(10), head(), RUN_CREATED - 30));
    const co = recipeCheckout("co-proved");
    const before = hashTree(path.join(co, ".git"));
    const merge = await forkRunMerge(co, { pr: 7, createdAt: new Date(RUN_CREATED * 1000) });
    expect(merge).toMatchObject({ mergeSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: merge });
    expect(out.history).toEqual({ shas: [sha(12), sha(8), sha(3)], links: [[2], [2], []], truncated: false });
    expect(out.ancestorShas).toEqual([sha(3), sha(12)]);
    expect(out.historyRead).toMatchObject({ mode: "fetched" });
    expect(out.runBase).toEqual({ added: true });
    expect(out.fetchedCommits).toBe(13);
    expect(hashTree(path.join(co, ".git"))).toBe(before);
  });

  /** Would catch: the proof skipped, so a merge GitHub remade after the run (on a base the pixels lack), or a
   *  merge of some other commit, lends the build a base it never rendered. */
  it.each([
    { name: "made after the run", merge: () => testMerge(sha(10), head(), RUN_CREATED + 1), reason: "GitHub remade the pull request's merge after the run" },
    { name: "of another commit", merge: () => testMerge(sha(10), sha(12), RUN_CREATED - 30), reason: "the pull request's merge isn't of this build's commit" },
    { name: "with the head first", merge: () => testMerge(head(), sha(10), RUN_CREATED - 30), reason: "the pull request's merge isn't of this build's commit" },
  ])("falls back to the head's complete history for a merge $name", async ({ merge, reason }) => {
    const sha_ = merge();
    const co = recipeCheckout(`co-${reason.length}-${sha_.slice(0, 6)}`);
    const out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: run(sha_) });
    expect(out.history).toEqual(headOnly());
    expect(out.ancestorShas).toEqual([sha(3), sha(12)]);
    expect(out.historyRead?.mode).toBe("local");
    expect(out.historyRead?.fetchedBytes).toBeGreaterThan(0);
    expect(out.runBase).toEqual({ missed: reason });
  });

  /** Would catch: the CLI reading the merge ref after register (whose read of the PR can make GitHub remake it on
   *  the base's newest tip), or refetching it by name: the merge the CLI named is fetched by its sha. */
  it("reads the merge the ref named, after GitHub moved the ref on", async () => {
    setMergeRef(testMerge(sha(9), head(), RUN_CREATED - 30));
    const co = recipeCheckout("co-superseded");
    const merge = await forkRunMerge(co, { pr: 7, createdAt: new Date(RUN_CREATED * 1000) });
    setMergeRef(testMerge(sha(10), head(), RUN_CREATED + 60));
    const out = await historyStep(co, { offered: [sha(10), sha(8), sha(3)], commit: head(), fetchHistory: true, pushBefore: null, forkRun: merge });
    expect(out.history).toEqual({ shas: [sha(8), sha(3)], links: [[1], []], truncated: false });
    expect(out.historyRead?.mode).toBe("fetched");
  });

  /** Would catch: a hung step of the merge read holding the upload, or leaving it a truncated history, or the
   *  deadline reported as that step's own failure (a hung `config` read as "couldn't read the configuration"); the
   *  head's complete history goes instead, and nothing the step started outlives it. */
  it.each(["fetch", "config --list"])("falls back to the head's complete history when the merge read's %s times out", async (on) => {
    const merge = testMerge(sha(10), head(), RUN_CREATED - 30);
    const co = recipeCheckout(`co-hung-${on.length}`);
    const hung = hungFetchShim(root, `fork-hung-${on.length}`, on);
    const before = process.env.PATH;
    process.env.PATH = hung.path;
    let out;
    try {
      out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: run(merge), budgetMs: 4_000 });
    } finally {
      process.env.PATH = before;
    }
    expect(out.history).toEqual(headOnly());
    expect(out.historyRead?.mode).toBe("local");
    expect(out.runBase).toEqual({ missed: expect.stringMatching(/^reading the pull request's merge took longer than \d+ s$/) });
    expect(await hung.survivors()).toEqual([]);
  });

  /** Would catch: the merge read paying a network round trip when the server didn't ask for fetched history
   *  (the cost the team flag keeps dark), or for an upload that isn't a fork run's. */
  it.each([
    { name: "the server didn't ask", fetchHistory: false, fork: true },
    { name: "the upload isn't a fork run's", fetchHistory: true, fork: false },
  ])("reads only the head, with no fetch, when $name", async ({ fetchHistory, fork }) => {
    const merge = testMerge(sha(10), head(), RUN_CREATED - 30);
    const co = recipeCheckout(`co-quiet-${String(fetchHistory)}-${String(fork)}`);
    const shim = gitShim(root);
    try {
      const out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory, pushBefore: null, forkRun: fork ? run(merge) : null });
      expect(out.history).toEqual(headOnly());
      expect(out.historyRead?.mode).toBe("local");
      expect(out.runBase).toBeUndefined();
      expect(shim.log().filter((l) => l.includes("fetch") || l.includes("ls-remote"))).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a shallow checkout's missing parents read as the end of the history, sending a base line cut at
   *  the checkout's depth as if complete, or the head's own fetch left out of the bytes the build reports. */
  it("reads both lines in full from a shallow checkout", async () => {
    const merge = testMerge(sha(10), head(), RUN_CREATED - 30);
    const co = actionsCheckout(root, url, head(), { name: "co-shallow-fork" });
    const out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: run(merge) });
    expect(out.history).toEqual({ shas: [sha(12), sha(8), sha(3)], links: [[2], [2], []], truncated: false });
    expect(out.ancestorShas).toEqual([]);
    expect(out.historyRead?.mode).toBe("fetched");
    expect(out.runBase).toEqual({ added: true });
    // Both reads' fetches count: the head's own as well as the merge's (all a full clone fetches).
    const headAlone = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null });
    const mergeAlone = await historyStep(recipeCheckout("co-shallow-fork-bytes"), { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: run(merge) });
    const headBytes = headAlone.historyRead?.fetchedBytes ?? 0;
    expect(headBytes).toBeGreaterThan(0);
    expect(out.historyRead?.fetchedBytes ?? 0).toBeGreaterThan((mergeAlone.historyRead?.fetchedBytes ?? Infinity) + headBytes / 2);
  });

  /** Would catch: a PR with no merge (it conflicts with its base), or a merge read that never started (the head's
   *  read used the time), sending the head's history with no word of why, so the base's changes since the fork
   *  point show as the PR's unexplained. */
  it.each([
    { name: "the PR has no merge", forkRun: { missed: "the pull request has no merge with its base (it conflicts, or it is closed)" }, budgetMs: undefined },
    { name: "the head's read used the time", forkRun: null, budgetMs: 1_500 },
  ])("falls back with a reason when $name", async ({ forkRun, budgetMs }) => {
    const co = recipeCheckout(`co-missed-${String(budgetMs)}`);
    const shim = gitShim(root);
    try {
      const fork = forkRun ?? run(testMerge(sha(10), head(), RUN_CREATED - 30));
      const out = await historyStep(co, { offered: offered(), commit: head(), fetchHistory: true, pushBefore: null, forkRun: fork, budgetMs });
      expect(out.history).toEqual(headOnly());
      expect(out.historyRead?.mode).toBe("local");
      expect(out.runBase).toEqual({ missed: forkRun?.missed ?? "reading the head's own history used up the time for it" });
      expect(shim.log().filter((l) => l.includes("fetch"))).toEqual([]);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: the merge read lending a full clone's objects to its temporary repository, which makes git copy
   *  every object they reach (files included) into it: on a big repo, the whole object store into the runner's temp. */
  it("copies none of a full clone's files", async () => {
    const big = path.join(root, "big");
    fs.mkdirSync(big);
    const r = bareRemote(big, 13, parents, (k) => (k === 3 ? randomBytes(400_000) : null));
    g(r.remote, "update-ref", "refs/pull/7/head", r.sha(13));
    const merge = execFileSync("git", ["commit-tree", `${r.sha(13)}^{tree}`, "-p", r.sha(10), "-p", r.sha(13), "-m", "Merge"], {
      cwd: r.remote,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_COMMITTER_DATE: `@${RUN_CREATED - 30} +0000` },
    }).trim();
    const co = path.join(big, "clone");
    g(big, "clone", "-q", r.url, co);
    g(co, "fetch", "-q", "origin", r.sha(13));
    const out = await historyStep(co, { offered: [r.sha(8), r.sha(3)], commit: r.sha(13), fetchHistory: true, pushBefore: null, forkRun: run(merge) });
    expect(out.runBase).toEqual({ added: true });
    expect(out.historyRead?.fetchedBytes ?? Infinity).toBeLessThan(100_000);
  });

  /** Would catch: the merge ref read from a remote other than the one the merge is then fetched from, a missing
   *  ref (a PR that conflicts with its base has none) or an unreachable remote reported as a merge. */
  it("names the merge ref's sha, or why there is none", async () => {
    const merge = testMerge(sha(10), head(), RUN_CREATED - 30);
    setMergeRef(merge);
    const co = recipeCheckout("co-lookup");
    const facts = { pr: 7, createdAt: new Date(RUN_CREATED * 1000) };
    g(co, "remote", "add", "upstream", `file://${path.join(root, "missing.git")}`);
    expect(await forkRunMerge(co, facts)).toEqual({ mergeSha: merge, createdAt: facts.createdAt });
    expect(await forkRunMerge(co, { ...facts, pr: 8 })).toEqual({ missed: "the pull request has no merge with its base (it conflicts, or it is closed)" });
    g(co, "remote", "rename", "origin", "base");
    expect(await forkRunMerge(co, facts)).toEqual({ missed: "the checkout has no remote to read the pull request's merge from" });
    g(co, "remote", "remove", "base");
    expect(await forkRunMerge(co, facts)).toEqual({ missed: "couldn't ask the remote for the pull request's merge" });
  });
});

describe("historyStep against hosts that limit partial fetches (real git)", () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Would catch: the "filtering not recognized" warning ignored, so a host without filter support makes
   *  every build download the whole repository, file contents included, into the runner's temp disk. */
  it("stops at a host without filter support, having fetched almost nothing", async () => {
    root = tmpDir("nofilter");
    const big = (k: number): Buffer | null => (k % 5 === 0 ? randomBytes(3_000_000) : null);
    const r = bareRemote(root, 20, linear, big);
    g(r.remote, "config", "uploadpack.allowFilter", "false");
    const co = actionsCheckout(root, r.url, r.sha(20));
    const shim = gitShim(root);
    try {
      const out = await historyStep(co, { offered: [r.sha(3)], commit: r.sha(20), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual({ unavailable: "this git host doesn't support partial fetches" });
      expect(out.historyRead?.fetchedBytes ?? 0).toBeLessThan(1_000_000);
      expect(shim.log().filter((l) => l.includes(" fetch "))).toHaveLength(1);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a host that refuses `tree:0` (but serves other filters) reported as having no history. */
  it("retries with blob:none when the host refuses the tree filter", async () => {
    root = tmpDir("notree");
    const r = bareRemote(root, 20, linear);
    g(r.remote, "config", "uploadpackfilter.tree.allow", "false");
    const co = actionsCheckout(root, r.url, r.sha(20));
    const shim = gitShim(root);
    try {
      const out = await historyStep(co, { offered: [r.sha(3), r.sha(12)], commit: r.sha(20), fetchHistory: true, pushBefore: null });
      expect(out.history).toEqual({ shas: [r.sha(12), r.sha(3)], links: [[1], []], truncated: false });
      expect(out.historyRead?.mode).toBe("fetched");
      expect(shim.log().some((l) => l.includes("--filter=blob:none"))).toBe(true);
    } finally {
      shim.restore();
    }
  });

  /** Would catch: a fork run's merge read skipping the filter checks the head's own read makes (a full clone reads
   *  its head locally, so nothing else probes the host): without filters it would download the whole repository,
   *  files included, and a host that refuses only `tree:0` would cost every fork build its base. */
  it.each([
    { name: "has no filter support", config: ["uploadpack.allowFilter", "false"], runBase: { missed: "this git host doesn't support partial fetches" } },
    { name: "refuses the tree filter", config: ["uploadpackfilter.tree.allow", "false"], runBase: { added: true } },
  ])("reads a fork run's merge from a host that $name", async ({ config, runBase }) => {
    root = tmpDir("forkfilter");
    const big = (k: number): Buffer | null => (k % 5 === 0 ? randomBytes(3_000_000) : null);
    const r = bareRemote(root, 13, (k) => (k === 11 ? [5] : linear(k)), big);
    const merge = execFileSync("git", ["commit-tree", `${r.sha(13)}^{tree}`, "-p", r.sha(10), "-p", r.sha(13), "-m", "Merge"], {
      cwd: r.remote,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_COMMITTER_DATE: "@1700000100 +0000" },
    }).trim();
    g(r.remote, "update-ref", "refs/pull/7/head", r.sha(13));
    g(r.remote, "update-ref", "refs/pull/7/merge", merge);
    const co = path.join(root, "clone");
    g(root, "clone", "-q", r.url, co);
    g(co, "fetch", "-q", "origin", r.sha(13));
    g(r.remote, "config", config[0] ?? "", config[1] ?? "");
    const forkRun = { mergeSha: merge, createdAt: new Date(1_700_000_100_000) };
    const out = await historyStep(co, { offered: [r.sha(8), r.sha(3)], commit: r.sha(13), fetchHistory: true, pushBefore: null, forkRun });
    expect(out.runBase).toEqual(runBase);
    expect(out.historyRead?.fetchedBytes ?? 0).toBeLessThan(1_000_000);
  });

  /** Would catch: a failed full fetch ending the read instead of falling back to a bounded one, a bounded read
   *  not marked truncated, or a truncated walk deciding a push's forced (a depth-5000 walk lacking `before`
   *  proves nothing). */
  it("falls back to a bounded fetch, truncated, when the full one fails", async () => {
    root = tmpDir("fallback");
    const r = bareRemote(root, 5100, linear);
    const packDir = path.join(r.remote, "objects", "pack");
    const moved = path.join(root, "packs");
    fs.renameSync(packDir, moved);
    fs.mkdirSync(packDir);
    const pack = fs.readdirSync(moved).find((f) => f.endsWith(".pack")) ?? "";
    execFileSync("git", ["unpack-objects", "-q"], { cwd: r.remote, input: fs.readFileSync(path.join(moved, pack)) });
    const broken = r.sha(30);
    fs.rmSync(path.join(r.remote, "objects", broken.slice(0, 2), broken.slice(2)));
    const co = actionsCheckout(root, r.url, r.sha(5100));
    const out = await historyStep(co, { offered: [r.sha(5000), r.sha(200), r.sha(31)], commit: r.sha(5100), fetchHistory: true, pushBefore: r.sha(31) });
    expect(out.history).toEqual({ shas: [r.sha(5000), r.sha(200)], links: [[1], []], truncated: true });
    expect(out.historyRead?.mode).toBe("fallback");
    expect(out.pushForced).toBeUndefined();
    // A fork run's base is added only to a complete history, and the build is told why not.
    const forkRun = { mergeSha: "a".repeat(40), createdAt: new Date() };
    const fork = await historyStep(co, { offered: [r.sha(5000), r.sha(200)], commit: r.sha(5100), fetchHistory: true, pushBefore: null, forkRun });
    expect(fork.history).toMatchObject({ truncated: true });
    expect(fork.runBase).toEqual({ missed: "the head's own history was cut short" });
  }, 60_000);
});

// ---- Pure parts --------------------------------------------------------------------------------------------

describe("stripCredentials", () => {
  /** Would catch any credential form the reason could carry passing through to the server. */
  it.each([
    ["fatal: unable to access 'https://oauth2:glpat-abcdefghij1234@gitlab.com/a/b.git/'", ["glpat-abcdefghij1234", "oauth2:"]],
    ["remote: x-access-token:ghs_abcdefghijklmnop rejected", ["ghs_abcdefghijklmnop"]],
    ["header Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX2FiYw== refused", ["eC1hY2Nlc3MtdG9rZW46Z2hzX2FiYw=="]],
    ["Bearer abcdef.123456.ghi refused", ["abcdef.123456.ghi"]],
    ["using github_pat_11ABCDEFG0abcdefghijkl and ghp_0123456789abcdef", ["github_pat_11ABCDEFG0", "ghp_0123456789abcdef"]],
    ["ssh: Could not resolve s3cr3t-held-value-here", ["s3cr3t-held-value-here"]],
  ])("strips %s", (text, secrets) => {
    const out = stripCredentials(text, ["s3cr3t-held-value-here"]);
    for (const s of secrets) expect(out).not.toContain(s);
  });

  it("keeps a message without credentials readable", () => {
    expect(stripCredentials("fatal: couldn't find remote ref main")).toBe("fatal: couldn't find remote ref main");
  });
});

describe("secretsOf", () => {
  /** Would catch: holding an `insteadOf` value (the public URL it rewrites) as a secret, which turns every later
   *  log line that names the host into `***`. */
  it("holds an insteadOf key's token-bearing base, not the public URL it replaces", () => {
    const secrets = secretsOf("url.https://x-access-token:ghs_abcdef123456@github.com/.insteadof", "https://github.com/");
    expect(secrets).toContain("https://x-access-token:ghs_abcdef123456@github.com/");
    expect(secrets).toContain("ghs_abcdef123456");
    expect(secrets).not.toContain("https://github.com/");
  });

  it("holds a remote URL whole, and its password", () => {
    const secrets = secretsOf("remote.origin.url", "https://user:s3cretpassword@git.example.com/r.git");
    expect(secrets).toEqual(expect.arrayContaining(["https://user:s3cretpassword@git.example.com/r.git", "s3cretpassword"]));
  });
});

describe("parseConfigList", () => {
  /** Would catch: the checkout's shape (bare, worktree, partial-clone extensions) or its include directives
   *  copied into the temporary repository, where git would refuse or misread them. */
  it("drops include directives and the keys that describe the checkout's own shape", () => {
    const raw = [
      "core.bare\nfalse",
      "core.worktree\n/x",
      "core.repositoryformatversion\n1",
      "extensions.partialclone\norigin",
      "remote.origin.promisor\ntrue",
      "remote.origin.partialclonefilter\nblob:none",
      "includeif.gitdir:/x/.git.path\n/y",
      "include.path\n/z",
      "remote.origin.url\nhttps://h/r.git",
      "http.https://h/.extraheader\nAUTHORIZATION: basic x\ny",
    ].join("\0");
    expect(parseConfigList(`${raw}\0`)).toEqual([
      ["remote.origin.url", "https://h/r.git"],
      ["http.https://h/.extraheader", "AUTHORIZATION: basic x\ny"],
    ]);
  });
});

describe("fitUploadedBody", () => {
  const sha = (i: number): string => i.toString(16).padStart(40, "0");

  /** Would catch: a body past the serverless limit sent anyway (a 413 fails the step before the server could
   *  drop the field), or the full clone's ancestry dropped along with the oversized history. */
  it("replaces an oversized history, keeping the ancestry", () => {
    const shas = Array.from({ length: 20_000 }, (_, i) => sha(i));
    const body = {
      ancestorShas: shas,
      history: { shas, links: shas.map((_, i) => (i + 1 < shas.length ? [i + 1] : [])), truncated: false },
      changedFiles: { [sha(1)]: { files: ["x".repeat(3_000_000)], truncated: false } },
    };
    const fitted = fitUploadedBody(body);
    expect(fitted.history).toEqual({ unavailable: "history too large to send (20000 commits, 19999 links)" });
    expect(fitted.ancestorShas).toBe(shas);
  });

  it("replaces an over-linked history", () => {
    const shas = Array.from({ length: 500 }, (_, i) => sha(i));
    const links = shas.map((_, i) => Array.from({ length: 500 - i - 1 }, (_, j) => i + 1 + j));
    const total = links.reduce((n, l) => n + l.length, 0);
    expect(total).toBeGreaterThan(MAX_HISTORY_LINKS);
    expect(fitUploadedBody({ ancestorShas: [], history: { shas, links, truncated: false } }).history).toEqual({
      unavailable: `history too large to send (500 commits, ${total} links)`,
    });
  });

  it("leaves a body that fits alone", () => {
    const body = { ancestorShas: [sha(1)], history: { shas: [sha(1)], links: [[]], truncated: false } };
    expect(fitUploadedBody(body)).toBe(body);
  });
});
