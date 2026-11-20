import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { HistoryReadStats, UploadedBody, UploadedHistory } from "./client";
import { FULL_SHA, type ForkRunFacts, checkoutGitEnv, isShallowRepo, parseCommitParents, repoRoot } from "./git";
import { holdSecret, redact } from "./redact";

/**
 * The build's git history, read for baseline matching: which of the commits the server offered the build's
 * commit contains, in topological order, with the graph between them. A full clone is walked where it stands;
 * a shallow checkout's missing history is fetched (commits, or commits and trees where the host refuses a tree
 * filter) into a temporary bare repository, and so is a fork run's test merge for its base's line, whatever the
 * checkout, so the customer's checkout is never written. Nothing here fails the upload: every failure becomes an `unavailable`
 * reason with no credential in it.
 */

export const HISTORY_BUDGET_MS = 120_000;
// Leaves the bounded fallback at least 40 s on the large repositories it exists for.
const PRIMARY_FETCH_MS = 80_000;
const FALLBACK_DEPTH = 5000;
const MIN_GIT = { major: 2, minor: 32 };
const MAX_REASON = 500;
const STDERR_KEEP = 16_384;

export const MAX_UPLOADED_BODY_BYTES = 3_500_000;
export const MAX_HISTORY_LINKS = 100_000;

// ---- The graph ---------------------------------------------------------------------------------------------

/** `rev-list --parents` output with shas interned to indexes on first sight. */
export interface HistoryGraph {
  shas: string[];
  index: Map<string, number>;
  /** By index; undefined for a commit seen only as a parent. */
  parents: (Int32Array | undefined)[];
  /** Listed commits' indexes, in rev-list's order (children before parents). */
  order: number[];
}

export function newHistoryGraph(): HistoryGraph {
  return { shas: [], index: new Map(), parents: [], order: [] };
}

function intern(graph: HistoryGraph, sha: string): number {
  const known = graph.index.get(sha);
  if (known !== undefined) return known;
  const i = graph.shas.length;
  graph.shas.push(sha);
  graph.parents.push(undefined);
  graph.index.set(sha, i);
  return i;
}

/** Adds one `<sha> <parent>...` line; a commit listed twice keeps its first listing. */
export function addRevListLine(graph: HistoryGraph, line: string): void {
  const [sha, ...parents] = line.trim().split(" ");
  if (!sha) return;
  const i = intern(graph, sha);
  if (graph.parents[i] !== undefined) return;
  graph.parents[i] = Int32Array.from(parents.filter(Boolean), (p) => intern(graph, p));
  graph.order.push(i);
}

export function graphContains(graph: HistoryGraph, sha: string): boolean {
  const i = graph.index.get(sha);
  return i !== undefined && graph.parents[i] !== undefined;
}

const NO_FRONTIER = new Int32Array(0);

/**
 * The offered commits the graph contains, newest first, each with its nearest contained offered ancestors
 * (`links[i]`, indexes into `shas`, all > i). One pass from the oldest commit carries each commit's frontier of
 * nearest matched ancestors; along a linear chain the frontier is shared by reference, and at a merge the
 * union is reduced to an antichain with each matched commit's ancestor bitset (at most matched² bits).
 */
export function matchOffered(graph: HistoryGraph, offered: string[]): { shas: string[]; links: number[][] } {
  const offeredSet = new Set(offered);
  const matchOf = new Int32Array(graph.shas.length).fill(-1);
  const shas: string[] = [];
  for (const i of graph.order) {
    const sha = graph.shas[i];
    if (sha !== undefined && offeredSet.has(sha)) {
      matchOf[i] = shas.length;
      shas.push(sha);
    }
  }
  const words = (shas.length + 31) >>> 5;
  const ancestors: Uint32Array[] = new Array(shas.length);
  const links: number[][] = new Array(shas.length);
  const frontier: (Int32Array | undefined)[] = new Array(graph.shas.length);
  const isAncestor = (a: number, of: number): boolean => ((ancestors[of]?.[a >>> 5] ?? 0) & (1 << (a & 31))) !== 0;

  for (let k = graph.order.length - 1; k >= 0; k--) {
    const v = graph.order[k] ?? 0;
    const parents = graph.parents[v] ?? NO_FRONTIER;
    let nearest: Int32Array;
    if (parents.length === 0) nearest = NO_FRONTIER;
    else if (parents.length === 1) nearest = frontier[parents[0] ?? 0] ?? NO_FRONTIER;
    else {
      const union = new Set<number>();
      for (const p of parents) for (const m of frontier[p] ?? NO_FRONTIER) union.add(m);
      const all = [...union];
      nearest = Int32Array.from(all.filter((m) => !all.some((other) => other !== m && isAncestor(m, other))));
    }
    const id = matchOf[v] ?? -1;
    if (id < 0) {
      frontier[v] = nearest;
      continue;
    }
    const bits = new Uint32Array(words);
    for (const m of nearest) {
      bits[m >>> 5] = (bits[m >>> 5] ?? 0) | (1 << (m & 31));
      const theirs = ancestors[m];
      if (theirs) for (let w = 0; w < words; w++) bits[w] = (bits[w] ?? 0) | (theirs[w] ?? 0);
    }
    ancestors[id] = bits;
    links[id] = Array.from(nearest).sort((a, b) => a - b);
    frontier[v] = Int32Array.of(id);
  }
  return { shas, links };
}

// ---- Running git -------------------------------------------------------------------------------------------

interface GitRun {
  code: number | null;
  stderr: string;
  killed: "timeout" | "abort" | null;
}

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const onCancel: (() => void)[] = [];

function cancelled(signal: NodeJS.Signals): void {
  for (const s of FORWARDED_SIGNALS) process.off(s, cancelled);
  for (const undo of onCancel.splice(0).reverse()) {
    try {
      undo();
    } catch {
      // Best effort: the process is going down either way.
    }
  }
  process.kill(process.pid, signal);
}

/** Runs `undo` if a Ctrl-C, CI cancel or hangup ends the CLI before the returned release is called; the most
 *  recent first, so a git run is killed before the repository it writes is removed. The signal then ends the
 *  CLI as it would have. */
function untilReleased(undo: () => void): () => void {
  if (onCancel.length === 0) for (const s of FORWARDED_SIGNALS) process.once(s, cancelled);
  onCancel.push(undo);
  return () => {
    const at = onCancel.indexOf(undo);
    if (at >= 0) onCancel.splice(at, 1);
    if (onCancel.length === 0) for (const s of FORWARDED_SIGNALS) process.off(s, cancelled);
  };
}

/** Runs git with its stdout streamed line by line, killed past `timeoutMs` or as soon as its stderr matches
 *  `abortOn`. Never rejects. */
function runGit(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onLine?: (line: string) => void; abortOn?: RegExp },
): Promise<GitRun> {
  return new Promise((resolve) => {
    if (opts.timeoutMs <= 0) {
      resolve({ code: null, stderr: "", killed: "timeout" });
      return;
    }
    let stderr = "";
    let killed: GitRun["killed"] = null;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let release = (): void => {};
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve({ code, stderr, killed });
    };
    // Its own process group, so a kill reaches the helpers git starts too: over HTTP without protocol v2 the
    // remote helper's fetch-pack keeps downloading into the temporary repository until its RPC ends, killed git
    // or not. Windows has no process groups to kill, and a detached child there opens a console.
    const group = process.platform !== "win32";
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", opts.onLine ? "pipe" : "ignore", "pipe"],
      detached: group,
    });
    const killGroup = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const kill = (why: "timeout" | "abort"): void => {
      if (killed) return;
      killed = why;
      killGroup();
    };
    // Outside the CLI's group, git misses the Ctrl-C, CI cancel or hangup the CLI gets, so the CLI passes it on.
    if (group) release = untilReleased(killGroup);
    timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
      if (opts.abortOn?.test(stderr)) kill("abort");
    });
    const { onLine } = opts;
    if (onLine && child.stdout) readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
    child.on("error", (e) => {
      stderr += e.message;
      finish(null);
    });
    // A killed git's helper can hold the inherited stderr open a moment longer; its exit is the answer.
    child.on("exit", (code) => {
      if (killed) finish(code);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---- Credentials -------------------------------------------------------------------------------------------

const CREDENTIAL_KEY =
  /^(?:http\.(?:.*\.)?extraheader|remote\..*\.(?:url|pushurl)|url\..*\.(?:insteadof|pushinsteadof)|core\.sshcommand|credential\..*)$/i;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const TOKEN_SHAPES =
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)|x-access-token:[^\s@'"]+|\b(?:basic|bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi;

/** The secrets a config entry can carry: a credential-bearing key's value, or for an `insteadOf` key its URL
 *  base (the URL with the token in it; the value is the public URL it replaces), and the password of any URL
 *  among them. */
export function secretsOf(key: string, value: string): string[] {
  if (!CREDENTIAL_KEY.test(key)) return [];
  const urlBase = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/i.exec(key)?.[1];
  const out = [urlBase ?? value];
  for (const text of new Set([value, ...out])) {
    for (const m of text.matchAll(/:\/\/([^\s/@]+)@/g)) {
      const userinfo = m[1] ?? "";
      out.push(userinfo, ...userinfo.split(":"));
    }
  }
  return out.filter((s) => s.length >= 8);
}

/** Removes every credential from a message about to leave the CLI: the values the step itself handed git, the
 *  secrets the run holds, then URL userinfo and the token shapes git hosts issue. */
export function stripCredentials(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return redact(out).replace(URL_USERINFO, "$1***@").replace(TOKEN_SHAPES, "***");
}

function reasonFrom(stderr: string, secrets: string[], fallback: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  const clean = last ? stripCredentials(last, secrets).replace(/[\u0000-\u001f\u007f]/g, " ") : fallback;
  return clean.slice(0, MAX_REASON);
}

// ---- Config for the temporary repository -------------------------------------------------------------------

const EXCLUDED_KEY =
  /^(?:include\..*|includeif\..*|core\.bare|core\.worktree|core\.repositoryformatversion|extensions\..*|remote\..*\.partialclonefilter|remote\..*\.promisor)$/i;

/** The checkout's resolved configuration (`config --list --includes -z`), minus the keys that describe the
 *  checkout's own shape or point at files git would refuse to include from the environment. */
export function parseConfigList(raw: string): [string, string][] {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((entry): [string, string] => {
      const nl = entry.indexOf("\n");
      return nl < 0 ? [entry, ""] : [entry.slice(0, nl), entry.slice(nl + 1)];
    })
    .filter(([key]) => !EXCLUDED_KEY.test(key));
}

// The checkout's git environment, none of it meant for the temporary repository: most point git at the
// checkout's own files (its object store, its shallow list, its grafts) or narrow what it sees (a ref namespace,
// replace refs). The `-c` parameters are already in `config --list`, so keeping them would send each twice.
const ENV_REMOVED = [
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_SYSTEM",
];

/** An environment where `config` is git's only configuration: no system or global file, nothing inherited. */
function isolatedEnv(config: [string, string][]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (ENV_REMOVED.includes(key) || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  const entries: [string, string][] = [...config, ["maintenance.auto", "false"], ["gc.auto", "0"], ["fetch.writeCommitGraph", "false"]];
  entries.forEach(([key, value], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
  });
  return {
    ...env,
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

function remoteName(config: [string, string][]): string | null {
  const names = new Set(config.flatMap(([key]) => /^remote\.(.+)\.url$/i.exec(key)?.[1] ?? []));
  if (names.has("origin")) return "origin";
  return names.size === 1 ? ([...names][0] ?? null) : null;
}

export function parseGitVersion(raw: string): { major: number; minor: number } | null {
  const m = /git version (\d+)\.(\d+)/.exec(raw);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
  } catch {
    // A directory that vanished or can't be read counts what was read.
  }
  return total;
}

// ---- Reading the history -----------------------------------------------------------------------------------

export type HistoryRead =
  | { kind: "read"; graph: HistoryGraph; mode: "local" | "fetched" | "fallback"; truncated: boolean; fetchedBytes: number | null }
  | { kind: "unavailable"; reason: string; fetchedBytes: number | null };

const FILTER_IGNORED = /filtering not recognized by server/;
const FILTER_REFUSED = /filter '[^']*' not supported/;
const NOT_OUR_REF = /not our ref|unadvertised object|couldn't find remote ref/i;

async function walk(
  roots: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; gitDir?: string },
  graph: HistoryGraph,
): Promise<GitRun> {
  const args = [...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []), "rev-list", "--topo-order", "--parents", ...roots, "--"];
  return runGit(args, { ...opts, onLine: (line) => addRevListLine(graph, line) });
}

const timedOut = (budgetMs: number): string => `reading the git history took longer than ${Math.round(budgetMs / 1000)} s`;

/** Walks the history of `commit`: in place on a full clone, else fetched into a temporary bare repository. */
export async function readHistory(cwd: string, commit: string, opts: { shallow: boolean; budgetMs?: number }): Promise<HistoryRead> {
  const budgetMs = opts.budgetMs ?? HISTORY_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const left = (): number => deadline - Date.now();
  if (commit.startsWith("-")) return { kind: "unavailable", reason: "the build's commit is not a commit", fetchedBytes: null };
  if (!opts.shallow) {
    const graph = newHistoryGraph();
    const run = await walk([commit], { cwd, env: checkoutGitEnv(), timeoutMs: left() }, graph);
    if (run.killed) return { kind: "unavailable", reason: timedOut(budgetMs), fetchedBytes: null };
    if (run.code !== 0) return { kind: "unavailable", reason: reasonFrom(run.stderr, [], "git rev-list failed"), fetchedBytes: null };
    return { kind: "read", graph, mode: "local", truncated: false, fetchedBytes: null };
  }
  // A fetch asks the remote for this exact object, so it needs the full sha. A full one may name a commit the
  // checkout lacks (a pull request's head under its merge commit); a short one only the checkout can spell out.
  let full = commit.toLowerCase();
  if (!FULL_SHA.test(full)) {
    const resolved = await checkoutOutput(["rev-parse", "--verify", `${commit}^{commit}`], cwd, left());
    full = resolved.out.trim();
    if (!resolved.ok || !FULL_SHA.test(full)) {
      return { kind: "unavailable", reason: "the build's commit is not a full commit sha, nor one the checkout has", fetchedBytes: null };
    }
  }
  return fetchHistory(cwd, full, { budgetMs, left, primaryUntil: Date.now() + Math.min(PRIMARY_FETCH_MS, budgetMs) });
}

async function checkoutOutput(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  let out = "";
  const run = await runGit(args, { cwd, env: { ...checkoutGitEnv(), GIT_TERMINAL_PROMPT: "0" }, timeoutMs, onLine: (l) => (out += `${l}\n`) });
  return { ok: run.code === 0 && !run.killed, out };
}

/** A temporary bare repository that fetches with the checkout's own configuration (passed through the environment,
 *  never written), and what reading through it needs. */
interface TempRepository {
  tmp: string;
  /** The environment fetches run in: the checkout's config, nothing else. */
  env: NodeJS.ProcessEnv;
  /** The environment local reads run in: no config at all. */
  bare: NodeJS.ProcessEnv;
  remote: string;
  secrets: string[];
  bytes: () => number;
}

/** Runs `work` in a new temporary repository and removes it after, or says why one couldn't be made. */
async function withTempRepository<T>(
  cwd: string,
  left: () => number,
  work: (repo: TempRepository) => Promise<T>,
  /** The reason any of its own steps fails with once `left()` has run out, when the caller has one. */
  timedOut?: string,
): Promise<T | { kind: "unavailable"; reason: string; fetchedBytes: number | null }> {
  const unavailable = (reason: string) => ({
    kind: "unavailable" as const,
    reason: timedOut !== undefined && left() <= 0 ? timedOut : reason,
    fetchedBytes: null,
  });
  const version = await checkoutOutput(["version"], cwd, left());
  const parsed = parseGitVersion(version.out);
  if (!parsed || parsed.major < MIN_GIT.major || (parsed.major === MIN_GIT.major && parsed.minor < MIN_GIT.minor)) {
    const named = parsed ? `${parsed.major}.${parsed.minor}` : "an unknown version";
    return unavailable(`git ${named} is older than 2.32, which reading the git history without touching the checkout needs`);
  }
  // `-z` keeps a value with a newline in it one entry; the list follows every include the checkout's git does.
  let raw = "";
  const listed = await runGit(["config", "--list", "--includes", "-z"], {
    cwd,
    env: checkoutGitEnv(),
    timeoutMs: left(),
    onLine: (l) => (raw += `${l}\n`),
  });
  if (listed.code !== 0) return unavailable("couldn't read the checkout's git configuration");
  const config = parseConfigList(raw.replace(/\n$/, ""));
  const secrets = config.flatMap(([key, value]) => secretsOf(key, value));
  for (const s of secrets) holdSecret(s);
  const remote = remoteName(config);
  if (remote === null) return unavailable("the checkout has no remote to fetch its history from");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-history-"));
  const removeTmp = (): void => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  const releaseTmp = untilReleased(removeTmp);
  try {
    const bare = isolatedEnv([]);
    const init = await runGit(["init", "--bare", "-q", tmp], { cwd, env: bare, timeoutMs: left() });
    if (init.code !== 0) return unavailable(reasonFrom(init.stderr, secrets, "couldn't create a temporary repository"));
    return await work({ tmp, env: isolatedEnv(config), bare, remote, secrets, bytes: () => dirBytes(path.join(tmp, "objects")) });
  } finally {
    releaseTmp();
    removeTmp();
  }
}

async function fetchHistory(
  cwd: string,
  commit: string,
  budget: { budgetMs: number; left: () => number; primaryUntil: number },
): Promise<HistoryRead> {
  return withTempRepository(cwd, budget.left, async ({ tmp, env, bare, remote, secrets, bytes }): Promise<HistoryRead> => {
    const unavailable = (reason: string, fetchedBytes: number | null = null): HistoryRead => ({ kind: "unavailable", reason, fetchedBytes });
    const fetch = (filter: string, roots: string[], timeoutMs: number, depth?: number): Promise<GitRun> =>
      runGit(
        [`--git-dir=${tmp}`, "fetch", "--no-tags", "--no-write-fetch-head", `--filter=${filter}`, ...(depth ? [`--depth=${depth}`] : []), remote, ...roots],
        { cwd, env, timeoutMs, abortOn: FILTER_IGNORED },
      );
    const ignoredFilter = (run: GitRun): boolean => run.killed === "abort";

    let roots = [commit];
    let prefix: string | null = null;
    let filter = "tree:0";
    const primaryLeft = (): number => Math.min(budget.primaryUntil - Date.now(), budget.left());
    let run = await fetch(filter, roots, primaryLeft());
    if (ignoredFilter(run)) return unavailable("this git host doesn't support partial fetches", bytes());
    if (run.code !== 0 && !run.killed && FILTER_REFUSED.test(run.stderr)) {
      filter = "blob:none";
      run = await fetch(filter, roots, primaryLeft());
      if (ignoredFilter(run)) return unavailable("this git host doesn't support partial fetches", bytes());
    }
    if (run.code !== 0 && !run.killed && NOT_OUR_REF.test(run.stderr)) {
      // A commit the CI made locally (a merge, a commit on top) isn't on the remote; its parents are.
      const object = await checkoutOutput(["cat-file", "-p", commit], cwd, budget.left());
      const parents = object.ok ? parseCommitParents(object.out) : [];
      if (parents.length > 0) {
        roots = parents;
        prefix = [commit, ...parents].join(" ");
        run = await fetch(filter, roots, primaryLeft());
        if (ignoredFilter(run)) return unavailable("this git host doesn't support partial fetches", bytes());
      }
    }
    let mode: "fetched" | "fallback" = "fetched";
    if (run.code !== 0 || run.killed) {
      const primaryError = run.stderr;
      if (budget.left() <= 0) return unavailable(timedOut(budget.budgetMs), bytes());
      run = await fetch(filter, roots, budget.left(), FALLBACK_DEPTH);
      if (ignoredFilter(run)) return unavailable("this git host doesn't support partial fetches", bytes());
      if (run.killed) return unavailable(timedOut(budget.budgetMs), bytes());
      if (run.code !== 0) return unavailable(reasonFrom(run.stderr || primaryError, secrets, "git fetch failed"), bytes());
      mode = "fallback";
    }

    const graph = newHistoryGraph();
    if (prefix !== null) addRevListLine(graph, prefix);
    const walked = await walk(roots, { cwd, env: bare, timeoutMs: budget.left(), gitDir: tmp }, graph);
    if (walked.killed) return unavailable(timedOut(budget.budgetMs), bytes());
    if (walked.code !== 0) return unavailable(reasonFrom(walked.stderr, secrets, "git rev-list failed"), bytes());
    let shallowAnswer = "";
    const shallow = await runGit([`--git-dir=${tmp}`, "rev-parse", "--is-shallow-repository"], {
      cwd,
      env: bare,
      timeoutMs: Math.max(1, budget.left()),
      onLine: (l) => (shallowAnswer = l),
    });
    const truncated = shallow.code !== 0 || shallowAnswer.trim() !== "false";
    return { kind: "read", graph, mode, truncated, fetchedBytes: bytes() };
  });
}

// ---- A fork pull request's base --------------------------------------------------------------------------

/** The fork run a `workflow_run` upload carries (`forkRunFromCi`), with the test merge its PR's merge ref named
 *  before register read the PR (a read of a PR can make GitHub remake the ref on the base's current tip). */
export interface ForkRun {
  createdAt: Date;
  mergeSha: string;
}

const FORK_RUN_LOOKUP_MS = 15_000;
const RUN_BASE_MAX_MS = 60_000;
const RUN_BASE_MIN_MS = 1_000;
const COMMITTER_TIME = /^committer .* (\d+) [+-]\d{4}$/m;

/** Why a fork run's PR named no test merge to read: it then gets its head's own history. */
export interface ForkRunMissed {
  missed: string;
}

/** The sha `refs/pull/<pr>/merge` names on the checkout's remote now (`git ls-remote`, which writes nothing), or why
 *  there is none to read (the PR conflicts with its base, the remote can't be asked). Never throws. */
export async function forkRunMerge(cwd: string, run: ForkRunFacts): Promise<ForkRun | ForkRunMissed> {
  const root = repoRoot(cwd) ?? cwd;
  const env = { ...checkoutGitEnv(), GIT_TERMINAL_PROMPT: "0" };
  const names: string[] = [];
  const remotes = await runGit(["remote"], { cwd: root, env, timeoutMs: FORK_RUN_LOOKUP_MS, onLine: (l) => names.push(l.trim()) });
  const remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
  if (remotes.code !== 0 || remote === undefined) return { missed: "the checkout has no remote to read the pull request's merge from" };
  let line = "";
  const listed = await runGit(["ls-remote", remote, `refs/pull/${run.pr}/merge`], {
    cwd: root,
    env,
    timeoutMs: FORK_RUN_LOOKUP_MS,
    onLine: (l) => (line ||= l),
  });
  if (listed.code !== 0 || listed.killed) return { missed: "couldn't ask the remote for the pull request's merge" };
  const sha = line.split("\t")[0]?.trim().toLowerCase() ?? "";
  return FULL_SHA.test(sha) ? { createdAt: run.createdAt, mergeSha: sha } : { missed: "the pull request has no merge with its base (it conflicts, or it is closed)" };
}

type RunBase = { kind: "read"; graph: HistoryGraph; fetchedBytes: number } | { kind: "unavailable"; reason: string; fetchedBytes: number | null };

/**
 * The history of what a fork run rendered: the walk from the build's commit and from the base the run's test merge
 * was made on. The merge counts as the run's only when GitHub made it no later than the run and its second parent is
 * the build's commit; anything else, or any failure, is a reason. Complete or nothing: no depth fallback.
 */
async function readRunBase(cwd: string, commit: string, run: ForkRun, timeoutMs: number): Promise<RunBase> {
  try {
    return await readRunBaseIn(cwd, commit, run, timeoutMs);
  } catch (e) {
    const reason = stripCredentials(`reading the pull request's merge failed: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: "unavailable", reason: reason.slice(0, MAX_REASON), fetchedBytes: null };
  }
}

async function readRunBaseIn(cwd: string, commit: string, run: ForkRun, timeoutMs: number): Promise<RunBase> {
  const deadline = Date.now() + timeoutMs;
  const left = (): number => deadline - Date.now();
  const timedOut = `reading the pull request's merge took longer than ${Math.round(timeoutMs / 1000)} s`;
  const work = async ({ tmp, env, bare, remote, secrets, bytes }: TempRepository): Promise<RunBase> => {
    // A step cut off by the deadline fails like any other; the deadline is then the reason.
    const unavailable = (reason: string): RunBase => ({ kind: "unavailable", reason: left() <= 0 ? timedOut : reason, fetchedBytes: bytes() });
    const resolved = await checkoutOutput(["rev-parse", "--verify", `${commit}^{commit}`], cwd, left());
    const head = resolved.out.trim().toLowerCase();
    if (!resolved.ok || !FULL_SHA.test(head)) return unavailable("couldn't read the build's commit");
    // Commits only (with trees where the host refuses `tree:0`), none lent from the checkout: with a full clone's
    // objects as alternates, git copies every object they reach into the temporary repository.
    const fetch = (filter: string): Promise<GitRun> =>
      runGit(
        [`--git-dir=${tmp}`, "fetch", "--no-tags", "--no-write-fetch-head", `--filter=${filter}`, remote, `+${run.mergeSha}:refs/uiverify/merge`],
        { cwd, env, timeoutMs: left(), abortOn: FILTER_IGNORED },
      );
    let fetched = await fetch("tree:0");
    if (fetched.code !== 0 && !fetched.killed && FILTER_REFUSED.test(fetched.stderr)) fetched = await fetch("blob:none");
    if (fetched.killed === "abort") return unavailable("this git host doesn't support partial fetches");
    if (fetched.code !== 0 || fetched.killed) return unavailable(reasonFrom(fetched.stderr, secrets, "git fetch failed"));
    let object = "";
    const read = await runGit([`--git-dir=${tmp}`, "cat-file", "-p", run.mergeSha], { cwd, env: bare, timeoutMs: left(), onLine: (l) => (object += `${l}\n`) });
    if (read.code !== 0) return unavailable("couldn't read the pull request's merge commit");
    const parents = parseCommitParents(object);
    const made = Number(COMMITTER_TIME.exec(object)?.[1] ?? Number.NaN);
    if (parents.length !== 2 || parents[1] !== head) return unavailable("the pull request's merge isn't of this build's commit");
    if (!(made <= Math.floor(run.createdAt.getTime() / 1000))) return unavailable("GitHub remade the pull request's merge after the run");
    const graph = newHistoryGraph();
    const walked = await walk([head, parents[0] ?? ""], { cwd, env: bare, timeoutMs: left(), gitDir: tmp }, graph);
    if (walked.code !== 0 || walked.killed) return unavailable(reasonFrom(walked.stderr, secrets, "git rev-list failed"));
    return { kind: "read", graph, fetchedBytes: bytes() };
  };
  return withTempRepository(cwd, left, work, timedOut);
}

// ---- The upload's history fields ---------------------------------------------------------------------------

export interface HistoryStepInput {
  offered: string[];
  commit: string;
  /** The register response's `fetchHistory`: a shallow checkout fetches only when asked. */
  fetchHistory: boolean;
  /** A push's replaced tip whose `forced` register left undecided; a complete walk decides it. */
  pushBefore: string | null;
  /** The fork run this upload's capture came from, with its PR's test merge or why it has none (`forkRunMerge`). */
  forkRun?: ForkRun | ForkRunMissed | null;
  budgetMs?: number;
}

export interface HistoryOutcome {
  ancestorShas: string[];
  history?: UploadedHistory;
  historyRead?: HistoryReadStats;
  pushForced?: boolean;
  shallow: boolean;
  /** How many commits a fetched history walked, for the log. */
  fetchedCommits?: number;
  /** Whether a fork run's base joined the history, or why not (it then holds the head's alone). */
  runBase?: { added: true } | { missed: string };
}

/**
 * The upload's history fields. `ancestorShas` keeps its old meaning (the checkout's own history: empty on a
 * shallow checkout or a failed walk, else the contained offered commits in offer order), so a fetched history
 * never reaches the resolver that reads it. Skipped, with nothing sent, when nothing needs the history or a
 * shallow checkout wasn't asked to fetch. Never throws.
 */
export async function historyStep(cwd: string, input: HistoryStepInput): Promise<HistoryOutcome> {
  if (input.offered.length === 0 && input.pushBefore === null) return { ancestorShas: [], shallow: false };
  const started = Date.now();
  // The root, so a relative remote path resolves as it does for the checkout's own git.
  const root = repoRoot(cwd) ?? cwd;
  const shallow = isShallowRepo(root);
  if (shallow && !input.fetchHistory) return { ancestorShas: [], shallow };
  let read: HistoryRead;
  try {
    read = await readHistory(root, input.commit, { shallow, budgetMs: input.budgetMs });
  } catch (e) {
    read = { kind: "unavailable", reason: stripCredentials(`reading the git history failed: ${e instanceof Error ? e.message : String(e)}`).slice(0, MAX_REASON), fetchedBytes: null };
  }
  const ms = Date.now() - started;
  if (read.kind === "unavailable") {
    return {
      ancestorShas: [],
      history: { unavailable: read.reason },
      historyRead: { mode: "failed", ms, fetchedBytes: read.fetchedBytes },
      shallow,
    };
  }
  const { graph } = read;
  const complete = !read.truncated;
  const own = {
    ancestorShas: shallow ? [] : input.offered.filter((sha) => graphContains(graph, sha)),
    ...(input.pushBefore !== null && complete ? { pushForced: !graphContains(graph, input.pushBefore) } : {}),
    shallow,
  };
  // A fork run rendered its PR's test merge, so its history is the head's and the base's the merge was made on.
  // Read only when register asked for fetched history, after the head's own read, and only as a whole.
  const run = input.forkRun;
  if (run && input.fetchHistory) {
    const timeoutMs = Math.min(RUN_BASE_MAX_MS, ((input.budgetMs ?? HISTORY_BUDGET_MS) - (Date.now() - started)) / 2);
    const based: RunBase =
      "missed" in run
        ? { kind: "unavailable", reason: run.missed, fetchedBytes: null }
        : !complete
          ? { kind: "unavailable", reason: "the head's own history was cut short", fetchedBytes: null }
          : timeoutMs < RUN_BASE_MIN_MS
            ? { kind: "unavailable", reason: "reading the head's own history used up the time for it", fetchedBytes: null }
            : await readRunBase(root, input.commit, run, timeoutMs);
    if (based.kind === "read") {
      const matched = matchOffered(based.graph, input.offered);
      return {
        ...own,
        history: { shas: matched.shas, links: matched.links, truncated: false },
        historyRead: { mode: "fetched", ms: Date.now() - started, fetchedBytes: (read.fetchedBytes ?? 0) + based.fetchedBytes },
        fetchedCommits: based.graph.order.length,
        runBase: { added: true },
      };
    }
    // The merge read's own fetch, if it got that far, is part of what this build fetched.
    const fetchedBytes = based.fetchedBytes ? (read.fetchedBytes ?? 0) + based.fetchedBytes : read.fetchedBytes;
    return { ...own, ...ownHistory(read, input.offered, Date.now() - started, fetchedBytes), runBase: { missed: based.reason } };
  }
  return { ...own, ...ownHistory(read, input.offered, ms) };
}

function ownHistory(
  read: Extract<HistoryRead, { kind: "read" }>,
  offered: string[],
  ms: number,
  fetchedBytes = read.fetchedBytes,
): Pick<HistoryOutcome, "history" | "historyRead" | "fetchedCommits"> {
  const matched = matchOffered(read.graph, offered);
  return {
    history: { shas: matched.shas, links: matched.links, truncated: read.truncated },
    historyRead: { mode: read.mode, ms, fetchedBytes },
    ...(read.mode === "local" ? {} : { fetchedCommits: read.graph.order.length }),
  };
}

/** The body with its `history` replaced by an `unavailable` reason when sending it would push the request past
 *  what the server accepts (a 413 would fail the step before the server could drop the field). */
export function fitUploadedBody(body: UploadedBody): UploadedBody {
  const history = body.history;
  if (!history || !("shas" in history)) return body;
  const links = history.links.reduce((n, l) => n + l.length, 0);
  if (links <= MAX_HISTORY_LINKS && Buffer.byteLength(JSON.stringify(body)) <= MAX_UPLOADED_BODY_BYTES) return body;
  return { ...body, history: { unavailable: `history too large to send (${history.shas.length} commits, ${links} links)` } };
}
