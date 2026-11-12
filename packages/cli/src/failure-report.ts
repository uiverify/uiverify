import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { type ArchiveProducer, CaptureOutputError, isStorybookStaticDir } from "./bundle";
import { type RemoteRepos, isCi } from "./git";
import { type LoginEnding, LoginGoneError } from "./login-errors";
import { redact } from "./redact";
import { HttpStatusError } from "./retry";

/**
 * When `upload` or `check` fails before its build reaches UI Verify, a short report goes to
 * `POST /api/ingest/failure-report`, so a setup that never produced a build still leaves a trace; a `login`
 * that ends without signing in sends one to `POST /api/cli/login/failure` (no free text at all). It
 * carries no code, no file contents, no path outside the repo and no environment values but, when signed in,
 * the repository's name (which CI env can supply); `message` is the only free text and goes through
 * `sanitizeReportMessage`. On by default; `UIVERIFY_TELEMETRY=0` turns it off. Sent from a detached child
 * process, so the command's exit code never depends on it and nothing waits for the network. A signed-in report
 * first reads the repository's remote names from git, bounded at 1 s per call.
 */

export type Stage = "invocation" | "auth" | "git" | "capture" | "archive" | "register" | "upload";

export type ErrorClass =
  | "invalid_args"
  | "missing_key"
  | "http_401"
  | "http_403"
  | "http_409"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "timeout"
  | "git_failed"
  | "missing_dir"
  | "nothing_captured"
  | "unreadable_capture"
  | "archive_failed"
  | "unexpected"
  | "login_unconfirmed"
  | "login_pending"
  | "login_unreadable"
  | "login_invalid";

export type Framework = "storybook" | "vitest" | "playwright" | "bun" | "screenshots" | "unknown";

/** Where a run is, so its catch knows which step failed. `done` once the build is on the server: a later
 *  failure is visible there and isn't reported. */
export interface UploadProgress {
  stage: Stage | "done";
  producer: ArchiveProducer | null;
  /** `team/slug` of the project register put a signed-in upload in. */
  project: string | null;
}

export interface Failure {
  stage: Stage;
  errorClass: ErrorClass;
  /** Already sanitized. */
  message: string;
}

/** Which credential the run used: `none` when it resolved neither a key nor a confirmed stored login. A login
 *  is `login` even when the report carries no token for it. */
export type CredentialKind = "key" | "login" | "none";

/** Where a signed-in upload was headed, sent only with a login bearer so the server can find the project. */
export interface ReportTarget {
  project?: string;
  repoFullName?: string;
  upstreamRepoFullName?: string;
}

export interface FailureReport extends Failure, ReportTarget {
  command: "upload" | "check";
  /** Absent only on a report sent before the credential was resolved (a malformed command line). */
  credential?: CredentialKind;
  framework: Framework;
  frameworkSource?: FrameworkSource;
  cliVersion: string;
  sdkName?: string;
  sdkVersion?: string;
  os: string;
  arch: string;
  nodeVersion: string;
  ci: boolean;
}

const MESSAGE_MAX = 500;

export interface SanitizeContext {
  /** The repository root (else the working directory). Paths under it stay, relative; every other path goes. */
  repoRoot: string | null;
  home: string;
  apiKey?: string;
  /** Paths the CLI itself puts in its messages unquoted (the capture dir), matched whole so one with a space
   *  in it outside the repo still goes entirely. */
  knownPaths?: string[];
}

/**
 * Make an error message safe to send: keys masked, paths inside the repo made relative, every other path
 * (absolute, home-relative, Windows drive or UNC, or climbing out with `../`) replaced by `<path>`.
 * A repo root at or above the home directory anchors nothing, so `~/clients/acme/…` can't pass as in-repo.
 */
export function sanitizeReportMessage(text: string, ctx: SanitizeContext): string {
  let out = normalizeSlashes(redact(text, ctx.apiKey));
  const home = normalizeSlashes(ctx.home);
  const homes = withRealpath(home);
  const root = ctx.repoRoot === null ? null : normalizeSlashes(ctx.repoRoot);
  const anchored = root !== null && !homes.some((h) => isSameOrAbove(root, h));
  // A known path is the exact string the CLI printed, so it goes whatever follows it (a colon, a space).
  for (const known of (ctx.knownPaths ?? []).map(normalizeSlashes)) {
    if (!(anchored && root !== null && isSameOrAbove(root, known))) {
      out = out.replace(new RegExp(escapeRegExp(known), "gi"), "<path>");
    }
  }
  if (anchored && root !== null) {
    for (const r of withRealpath(root)) {
      out = out.replace(new RegExp(`${escapeRegExp(r)}(?=[/'"\\s:,;)\\]]|$)`, "gi"), ".");
    }
  }
  // Any path with a `..` segment may climb out of the repo, wherever it sits.
  out = out.replace(/[^\s'"]*\.\.\/[^\s'"]*/g, "<path>");
  out = out.replace(/(['"])([^'"\n]*)\1/g, (whole, quote: string, inner: string) =>
    LEAVES_REPO.test(inner) || homes.some((h) => inner.startsWith(h)) ? `${quote}<path>${quote}` : whole,
  );
  for (const h of homes) out = out.replace(new RegExp(`${escapeRegExp(h)}[^'"\\n]*`, "gi"), "<path>");
  out = out.replace(OUTSIDE_PATH, "<path>");
  return out.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

// A path that leaves the repo: UNC (`//server/share`), POSIX absolute with at least two segments,
// home-relative, a Windows drive (lowercased by `normalizeSlashes`), or a relative path climbing out. The
// lookbehind keeps `and/or` and the `//` of a URL out.
const OUTSIDE_PATH =
  /(?<![\w.:/])(?:\/\/[^\s'"]+|\/[^\s'"/]+\/[^\s'"]*|~\/[^\s'"]*|[a-z]:\/[^\s'"]*|(?:\.\.\/)+[^\s'"]*)/g;
const LEAVES_REPO = /^(?:\/|~\/|[a-z]:\/|\.\.\/)/;

function normalizeSlashes(text: string): string {
  return text.replace(/\\/g, "/").replace(/(?<![\w])([A-Z]):\//g, (_m, drive: string) => `${drive.toLowerCase()}:/`);
}

function withRealpath(p: string): string[] {
  try {
    const real = normalizeSlashes(fs.realpathSync(p));
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

function isSameOrAbove(dir: string, other: string): boolean {
  const a = dir.replace(/\/+$/, "").toLowerCase();
  const b = other.replace(/\/+$/, "").toLowerCase();
  return b === a || b.startsWith(`${a}/`) || a === "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which failure an error thrown at `stage` is. Only `serverError` and the error's own message are free text,
 *  and both go through `sanitize`; an HTTP label and status are ours and are kept as they are. A signed-in
 *  run sends no server text: its refusals name repositories and projects across all the person's teams. */
export function classifyFailure(stage: Stage, err: unknown, sanitize: (text: string) => string, opts: { signedIn: boolean }): Failure {
  if (err instanceof CaptureOutputError) {
    return { stage: "capture", errorClass: err.errorClass, message: sanitize(err.reportMessage ?? err.message) };
  }
  if (err instanceof LoginGoneError) return { stage: "auth", errorClass: "login_invalid", message: sanitize(err.message) };
  if (err instanceof HttpStatusError) {
    const auth = err.status === 401 && stage === "register";
    const detail = err.serverError && OUR_STATUSES.has(err.status) && !opts.signedIn ? `: ${sanitize(err.serverError)}` : "";
    return { stage: auth ? "auth" : stage, errorClass: httpClass(err.status), message: `${err.label} -> ${err.status}${detail}` };
  }
  if (isFetchFailure(err)) {
    const code = causeCode(err);
    return { stage, errorClass: "network", message: code ? `fetch failed (${code})` : "fetch failed" };
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { stage, errorClass: "timeout", message: err.name };
  }
  const message = sanitize(err instanceof Error ? err.message : String(err));
  if (stage === "git") return { stage, errorClass: "git_failed", message };
  if (stage === "archive") return { stage, errorClass: "archive_failed", message };
  // Past bundling, any other error comes from reading a response (a proxy's HTML in a JSON parse error, a
  // drifted shape), so only its type is sent.
  return { stage, errorClass: "unexpected", message: stage === "register" || stage === "upload" ? errorName(err) : message };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** The statuses UI Verify's ingest routes answer with their own `{ "error" }` text; any other status came from
 *  something in front of us, so its text isn't ours even when it is shaped like ours. */
const OUR_STATUSES = new Set([400, 401, 404, 409]);

function httpClass(status: number): ErrorClass {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 409) return "http_409";
  return status >= 500 ? "http_5xx" : "http_4xx";
}

/** undici's own "fetch failed", which always carries the underlying socket/DNS/TLS error as `cause`; any other
 *  `TypeError` is a bug, not the network. */
export function isFetchFailure(err: unknown): err is TypeError {
  return err instanceof TypeError && err.message === "fetch failed" && err.cause !== undefined;
}

function causeCode(err: TypeError): string | null {
  const cause = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/) }).safeParse(err.cause);
  return cause.success ? cause.data.code : null;
}

const SDK_FRAMEWORKS: Record<string, Framework> = {
  "@uiverify/vitest": "vitest",
  "@uiverify/playwright": "playwright",
  "@uiverify/bun": "bun",
};

const packageJson = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
});
const versionOnly = z.object({ version: z.string() });
const producerOnly = z.object({ producer: z.object({ name: z.string(), version: z.string() }) });

/** A snapshot file is the archived DOM and can be megabytes; past this it isn't read for its producer. */
const SNAPSHOT_READ_LIMIT = 1_000_000;

export interface FrameworkInput {
  staticDir: string;
  cwd: string;
  screenshots: boolean;
  producer: ArchiveProducer | null;
}

/** How `framework` was found: the capture output (or `--screenshots`), or a `package.json` naming exactly one
 *  capture framework. Absent when it is a guess, so the server never places a report on one. */
export type FrameworkSource = "capture" | "package";

export interface DetectedFramework {
  framework: Framework;
  frameworkSource?: FrameworkSource;
  sdkName?: string;
  sdkVersion?: string;
}

/** The capture framework and SDK, from the capture output when there is one, else from the nearest
 *  `package.json`'s dependency names (only the matched SDK is reported, never the list). Never throws. */
export function detectFramework(input: FrameworkInput): DetectedFramework {
  if (input.screenshots) return { framework: "screenshots", frameworkSource: "capture" };
  try {
    if (isStorybookStaticDir(input.staticDir)) return { framework: "storybook", frameworkSource: "capture" };
    const producer = input.producer ?? firstSnapshotProducer(input.staticDir);
    const fromProducer = producer ? SDK_FRAMEWORKS[producer.name] : undefined;
    if (producer && fromProducer) {
      return { framework: fromProducer, frameworkSource: "capture", sdkName: producer.name, sdkVersion: producer.version };
    }
    return fromPackageJson(input.staticDir) ?? fromPackageJson(input.cwd) ?? { framework: "unknown" };
  } catch {
    return { framework: "unknown" };
  }
}

function firstSnapshotProducer(staticDir: string): ArchiveProducer | null {
  const dir = path.join(staticDir, "snapshots");
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".json"));
  if (!file) return null;
  const full = path.join(dir, file);
  if (fs.statSync(full).size > SNAPSHOT_READ_LIMIT) return null;
  const parsed = producerOnly.safeParse(JSON.parse(fs.readFileSync(full, "utf8")));
  return parsed.success ? parsed.data.producer : null;
}

/** Walks up from `start` to the first `package.json` that lists dependencies, stopping at the repository
 *  root (the directory holding `.git`) and never reading the home directory or anything above it. */
function fromPackageJson(start: string): DetectedFramework | null {
  const home = path.resolve(os.homedir());
  let dir = path.resolve(start);
  for (;;) {
    if (dir === home || isSameOrAbove(normalizeSlashes(dir), normalizeSlashes(home))) return null;
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const parsed = packageJson.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      const names = parsed.success
        ? [...Object.keys(parsed.data.dependencies ?? {}), ...Object.keys(parsed.data.devDependencies ?? {})]
        : [];
      if (names.length > 0) return frameworkFromDependencies(names, dir);
    }
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) return null;
    dir = parent;
  }
}

/** The package's SDK (the first of `SDK_FRAMEWORKS` it lists), else Storybook. The source is set only when the package names exactly one
 *  capture framework: a package with Storybook and the Vitest SDK could be either upload. */
function frameworkFromDependencies(names: string[], dir: string): DetectedFramework {
  const sdks = Object.entries(SDK_FRAMEWORKS).filter(([sdkName]) => names.includes(sdkName));
  const storybook = names.some((n) => n === "storybook" || n.startsWith("@storybook/"));
  const source: { frameworkSource?: FrameworkSource } = sdks.length + (storybook ? 1 : 0) === 1 ? { frameworkSource: "package" } : {};
  const [first] = sdks;
  if (first) {
    const [sdkName, framework] = first;
    return { framework, ...source, sdkName, ...installedVersion(dir, sdkName) };
  }
  return storybook ? { framework: "storybook", ...source } : { framework: "unknown" };
}

function installedVersion(dir: string, sdkName: string): { sdkVersion?: string } {
  try {
    const parsed = versionOnly.safeParse(JSON.parse(fs.readFileSync(path.join(dir, "node_modules", sdkName, "package.json"), "utf8")));
    return parsed.success ? { sdkVersion: parsed.data.version } : {};
  } catch {
    return {};
  }
}

/** Whether failure reports are on: everything but `UIVERIFY_TELEMETRY=0`. */
export function reportsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.UIVERIFY_TELEMETRY !== "0";
}

export const FAILURE_REPORT_PATH = "/api/ingest/failure-report";
export const LOGIN_FAILURE_PATH = "/api/cli/login/failure";

export const REPORT_NOTICE =
  "Reporting this failure to UI Verify (no code or file contents). UIVERIFY_TELEMETRY=0 turns this off.";

// What the child needs to reach the network the way the parent did (Winsock on Windows, proxies, extra CAs).
// Nothing else is inherited, and never NODE_OPTIONS, which can load code into the child.
const PASS_THROUGH = [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

// The child's whole program: one POST, no retry, every error swallowed.
const SENDER_SOURCE = `const e = process.env;
const headers = { "content-type": "application/json" };
if (e.UIVERIFY_REPORT_AUTH) headers.authorization = "Bearer " + e.UIVERIFY_REPORT_AUTH;
fetch(e.UIVERIFY_REPORT_URL, { method: "POST", headers, body: e.UIVERIFY_REPORT_BODY, signal: AbortSignal.timeout(5000) }).catch(() => {});`;

/** A bearer with a character fetch can't put in a header would make the child's own request throw, so such a
 *  report goes without auth (anonymous) rather than not at all. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

export interface CredentialInput {
  kind: CredentialKind;
  apiKey: string | undefined;
  /** The login credential's `heldToken`. */
  heldToken: (() => string | null) | undefined;
  errorClass: ErrorClass;
  /** Register's `team/slug`, else `--project`. */
  project: string | undefined;
  /** Called only for a report that carries a login token. */
  repos: () => RemoteRepos;
}

/**
 * The report's bearer and the fields that depend on it. A login's token goes only while unexpired and never
 * for a 401 (the server just refused it) or one that can't go in a header; the upload target goes only with that token, so a keyed or
 * anonymous report never names a repository.
 */
export function reportCredential(input: CredentialInput): { bearer: string | undefined; fields: ReportTarget & { credential: CredentialKind } } {
  if (input.kind === "key") return { bearer: input.apiKey, fields: { credential: "key" } };
  const held = input.kind === "login" && input.errorClass !== "http_401" ? (input.heldToken?.() ?? null) : null;
  const token = held !== null && HEADER_SAFE.test(held) ? held : null;
  if (token === null) return { bearer: undefined, fields: { credential: input.kind } };
  const { repoFullName, upstreamRepoFullName } = input.repos();
  return {
    bearer: token,
    fields: {
      credential: "login",
      ...(input.project ? { project: input.project } : {}),
      ...(repoFullName ? { repoFullName } : {}),
      ...(upstreamRepoFullName ? { upstreamRepoFullName } : {}),
    },
  };
}

export interface SendInput {
  apiUrl: string;
  /** The report route, such as `/api/ingest/failure-report`. */
  path: string;
  /** A project key or a login's access token, for the Authorization header. */
  bearer: string | undefined;
  body: unknown;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; the real one starts a detached process. */
  spawnSender?: (env: Record<string, string>) => void;
}

/** Hand a report to a detached child process and return at once. Never throws. */
export function sendReport(input: SendInput): void {
  try {
    const env: Record<string, string> = {};
    for (const name of PASS_THROUGH) {
      const value = input.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.UIVERIFY_REPORT_URL = `${input.apiUrl.replace(/\/$/, "")}${input.path}`;
    env.UIVERIFY_REPORT_BODY = JSON.stringify(input.body);
    if (input.bearer && HEADER_SAFE.test(input.bearer)) env.UIVERIFY_REPORT_AUTH = input.bearer;
    (input.spawnSender ?? spawnDetached)(env);
  } catch {
    // Best effort: a report that can't be started is simply not sent.
  }
}

function spawnDetached(env: Record<string, string>): void {
  const child = spawn(process.execPath, ["-e", SENDER_SOURCE], { detached: true, stdio: "ignore", windowsHide: true, env });
  child.on("error", () => {});
  child.unref();
}

export const LOGIN_ENDED_NOTICE =
  "Telling UI Verify how this sign-in ended (no code or personal data). UIVERIFY_TELEMETRY=0 turns this off.";
export const LOGIN_EXPIRED_UNUSED_NOTICE =
  "Telling UI Verify your last sign-in code expired unused. UIVERIFY_TELEMETRY=0 turns this off.";

/** Which CLI is signing in, for UI Verify's login funnel: none with `UIVERIFY_TELEMETRY=0`, so an opted-out
 *  login has no version on any of its events. */
export function loginClientHeaders(env: NodeJS.ProcessEnv, isTTY: boolean, cliVersion: string): Record<string, string> {
  if (!reportsEnabled(env)) return {};
  return {
    "x-uiverify-cli-version": cliVersion,
    "x-uiverify-ci": isCi(env) ? "1" : "0",
    "x-uiverify-tty": isTTY ? "1" : "0",
  };
}

export interface LoginEndingInput {
  apiUrl: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  cliVersion: string;
  /** Where the one-line notice goes: stderr, never the stdout an agent relays. */
  notice: (line: string) => void;
  spawnSender?: (env: Record<string, string>) => void;
}

/** The `reportEnded` a real `login` uses: one anonymous report per ending, with no free text, and a notice saying so.
 *  Never throws. */
export function loginEndingReporter(input: LoginEndingInput): (ending: LoginEnding) => void {
  return (ending) => {
    if (!reportsEnabled(input.env)) return;
    sendReport({
      apiUrl: input.apiUrl,
      path: LOGIN_FAILURE_PATH,
      bearer: undefined,
      env: input.env,
      spawnSender: input.spawnSender,
      body: {
        reason: ending,
        cliVersion: input.cliVersion,
        nodeVersion: process.versions.node,
        os: process.platform,
        arch: process.arch,
        ci: isCi(input.env),
        tty: input.isTTY,
      },
    });
    input.notice(`[uiverify] ${ending === "expired_unwatched" ? LOGIN_EXPIRED_UNUSED_NOTICE : LOGIN_ENDED_NOTICE}`);
  };
}
