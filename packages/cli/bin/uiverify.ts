import os from "node:os";
import path from "node:path";
import { ACCOUNT_SPEC, CHECK_SPEC, type ParseSpec, UPLOAD_SPEC, parseArgs, removedOptionNote } from "../src/args";
import { type Credential, resolveCredential } from "../src/auth";
import {
  bundleContentHash,
  bundleGraph,
  createBundle,
  createScreenshotBundle,
  isStorybookStaticDir,
  readArchiveProducer,
} from "../src/bundle";
import { CLI_VERSION, type CaptureShape, httpIngestClient } from "../src/client";
import { openBrowser } from "../src/browser";
import { type CredentialStore, credentialStore, credentialsPath, platformKeyStore } from "../src/credentials";
import { exitCodeFor, previewExitCodeFor } from "../src/exit";
import {
  type CredentialKind,
  type ErrorClass,
  FAILURE_REPORT_PATH,
  type Failure,
  type FailureReport,
  REPORT_NOTICE,
  loginClientHeaders,
  loginEndingReporter,
  type Stage,
  type UploadProgress,
  classifyFailure,
  detectFramework,
  reportCredential,
  reportsEnabled,
  sanitizeReportMessage,
  sendReport,
} from "../src/failure-report";
import {
  ciWatchCommand,
  collectGitMeta,
  confirmAncestors,
  deltaFor,
  isCi,
  reportRemoteRepos,
  repoRoot,
  workingTreeChanges,
} from "../src/git";
import { type AuthDeps, runLogin, runLogout, runWhoami, shouldOpenBrowser } from "../src/login";
import { holdSecret, redact } from "../src/redact";
import { resolveStrict } from "../src/strict";
import { type UploadDeps, defaultTmpFile, runUpload } from "../src/upload";

/**
 * `uiverify` — two subcommands over the same ingest pipeline (register → PUT bundle → uploaded → poll),
 * plus `login` / `logout` / `whoami` for uploading without a project key:
 *  - `upload`: the CI uploader. Renders the whole suite (or the skip-unchanged subset), gates the PR on
 *    the visual verdict (changed/failed → exit 1).
 *  - `check`: the interactive preview build a coding agent runs mid-edit-loop. Renders only the agent's
 *    `--target` selection, diffs against the real CI baseline, posts no GitHub check, and never advances a
 *    CI baseline. A `changed` verdict is informational (exit 0) — the agent reviews the pixels over MCP.
 *
 * Three independent non-zero exits, shared by both commands:
 *  - *Operational* failures (missing config, a missing/empty capture dir, a network/timeout error — the
 *    run itself not happening) fail the job by default (`resolveStrict`, fail-closed) so a silently
 *    dropped run can't leave CI green. `--no-strict` swallows them with exit 0. Everything operational
 *    funnels through `softFail()`.
 *  - The visual verdict is the deliberate gating exit — `changed`/`failed` for `upload`, only
 *    `failed`/`blocked` for `check` (a preview `changed` is the expected result, not a gate).
 *  - A malformed invocation exits **2**, ignoring `--no-strict`: an unknown or misspelled option, a
 *    boolean given a value, a stray token (`parseArgs`' `invalid`), or a bad subcommand. New
 *    argv-validation paths go through `parseArgs`, not `softFail()`.
 *
 * `login` exits 0 only when signed in; "still waiting for approval" exits 1, so `uiverify login && uiverify
 * upload` never uploads without a login. The account commands send no setup failure report: waiting is
 * their normal path. A login that ends without signing in sends its own short report, once per code.
 */

const TOP_LEVEL_USAGE = "usage: uiverify <upload | check | login | logout | whoami> [options]  (run `uiverify <command> --help`)";

const ENV_HELP = `Environment:
  UIVERIFY_API_KEY     Project API key. Required in CI; on your own machine, \`uiverify login\` instead.
                       When set, it is used even if you are signed in.
  UIVERIFY_API_URL     Override the default UI Verify API URL (https://uiverify.ai); for self-host/local dev.
  UIVERIFY_TELEMETRY   Set to 0 to stop sending UI Verify a short report when a run fails before its
                       build reaches UI Verify, or a login ends without signing in (no code, file contents
                       or environment values, except the repository's name when signed in).`;

const TOP_LEVEL_HELP = `uiverify — visual regression testing for Storybook, Vitest, Playwright, and custom screenshots.

${TOP_LEVEL_USAGE}

Commands:
  upload   Upload a prebuilt bundle for a CI visual check (gates the PR on changed/failed).
  check    Interactive preview check for a coding agent's edit loop: render only the stories you
           name and diff against the real CI baseline, without posting a check or moving a baseline.
  login    Sign in through the browser, so upload and check on this machine need no API key.
  logout   Forget this machine's login.
  whoami   Show who this machine is signed in as.

Run \`uiverify <command> --help\` for each command's options.

${ENV_HELP}`;

const UPLOAD_USAGE =
  "usage: uiverify upload (--static-dir <dir> | --screenshots <dir>) [--project <slug|team/slug>] [--confirm-new <code>] [--working-directory <dir>] [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--render-all] [--strict | --no-strict]";

const UPLOAD_HELP = `uiverify upload — upload a prebuilt Storybook bundle for visual regression testing.

${UPLOAD_USAGE}

Build your Storybook first (e.g. \`npm run build-storybook\`), then point --static-dir at its output.
Upload, register, then poll the build every ~2s and print a live "Rendered X / N" progress line until
it finishes. Exits non-zero if the visual gate is changed/failed — the one deliberate gating exit,
independent of --strict.

When the bundle carries a dependency graph (preview-stats.json: a Storybook built with --stats-json, a
@uiverify/vitest archive, or one you add to a Playwright archive), only the stories your change could
affect render and the rest keep their baselines. Without one, everything renders and the log says how
to get one.

Options:
  --static-dir <dir>         Upload this prebuilt Storybook static directory (e.g. storybook-static),
                             or a Playwright/Vitest capture archive directory.
  --screenshots <dir>        Upload a directory of finished PNGs you already produced (native, mobile,
                             React Native). UI Verify diffs them without rendering. Mutually exclusive
                             with --static-dir. Each image is keyed by its path under the directory.
  --project <slug|team/slug> The UI Verify project to upload to. Signed in (no API key), UI Verify picks
                             the project from your repository and what you upload, and creates it (and
                             your first team) when there is none; pass this when that is ambiguous (e.g.
                             two Storybooks in one repository), or to name a new project. Prefix the
                             team (team/slug) when you're in several. With a key, it must name the key's
                             project.
  --confirm-new <code>       Signed in: create the --project anyway when the upload asked whether an
                             existing project is this one and the answer is no. The code is the one that
                             answer printed.
  --working-directory <dir>  Run in this directory (default: current directory).
  --api-url <url>            UI Verify API URL (default: https://uiverify.ai; override for self-host/local).
  --auto-accept-changes      Accept this build's changes as the new baseline (pass on merges to main).
  --exit-zero-on-changes     Detect but don't block: a changed (needs-review) verdict exits 0 and stays
                             pending review in the dashboard. failed/blocked still exit non-zero.
  --render-all               Render every story, even when the bundle's dependency graph shows a change
                             can't reach it, and even if this exact commit already passed.
  --strict                   Fail the CI job (exit 1) if the upload itself fails — bad/missing key or
                             login, missing bundle, network error. This is the DEFAULT.
  --no-strict                Never fail the CI job on an operational error (exit 0). The visual verdict
                             (changed/failed) still gates regardless.
  -h, --help                 Show this help.

${ENV_HELP}`;

const CHECK_USAGE =
  "usage: uiverify check [--target <glob> …] (--static-dir <dir> | --screenshots <dir>) [--project <slug|team/slug>] [--working-directory <dir>] [--api-url <url>] [--strict | --no-strict]";

const CHECK_HELP = `uiverify check — interactive preview check for a coding agent's edit loop.

${CHECK_USAGE}

Renders ONLY the targets you name with --target (repeatable; id globs or exact ids) on the UI
Verify fleet and diffs them against the real CI baseline — a true "would this pass" answer mid-edit,
without a local render. A preview check posts no GitHub check and never advances a CI baseline; accept
its changes (in the dashboard or via the MCP accept tools) to establish a branch-scoped preview baseline
so your own accepted changes stop re-flagging on the next check. Build your Storybook first, then point
--static-dir at its output (the whole bundle uploads; only the named targets render).

Prints the changed list and an MCP handoff so the agent can inspect the pixels (get_diff /
render_diff_image). A changed verdict exits 0 (it's the expected result to review, not a gate); only
failed/blocked or an operational error exit non-zero.

Options:
  --target <glob>            A target to render (repeatable): an exact id (components-button--default,
                             a Playwright/Vitest test id, or a screenshot path key) or an anchored glob
                             (components-button--*, settings/*). Required for a Storybook --static-dir
                             (the whole suite is built, so you name what to render); optional for a
                             Playwright/Vitest archive or --screenshots, which are already scoped to what
                             you captured. When given, these REPLACE the dependency-graph closure a CI
                             build would compute — you choose exactly what to preview.
  --static-dir <dir>         Upload this prebuilt Storybook static directory (e.g. storybook-static),
                             or a Playwright/Vitest capture archive directory.
  --screenshots <dir>        Upload a directory of finished PNGs you already produced. Mutually exclusive
                             with --static-dir.
  --project <slug|team/slug> The UI Verify project to upload to. Signed in (no API key), UI Verify picks
                             the project from your repository and what you upload; pass this when that
                             is ambiguous (e.g. two Storybooks in one repository). With a key, it must
                             name the key's project.
  --working-directory <dir>  Run in this directory (default: current directory).
  --api-url <url>            UI Verify API URL (default: https://uiverify.ai; override for self-host/local).
  --strict                   Fail the job (exit 1) if the check itself fails — bad/missing key or login,
                             missing bundle, network error. This is the DEFAULT.
  --no-strict                Never fail on an operational error (exit 0).
  -h, --help                 Show this help.

${ENV_HELP}`;

const LOGIN_HELP = `uiverify login — sign in through the browser, so upload and check on this machine need no API key.

usage: uiverify login

Prints a link and a short code, and opens the link in your browser when it can. Sign in (or sign up) there
and approve. The login is kept on this machine (never in your repository; sealed with a key in your
keychain on macOS, your keyring inside a Linux desktop login when secret-tool is installed, or Windows
data protection) and renewed quietly. Exits 0 only once you are signed in. Already signed in? It says who you
are and changes nothing.

In a terminal it waits for your approval. Without one (a coding agent's shell) it waits at most a minute,
or not at all when it couldn't open a browser, then exits 1 saying what to do: approve, then run
\`npx uiverify login\` again. A rerun keeps the same code, and finishes a sign-in that was already approved.

Which UI Verify it signs in to comes from UIVERIFY_API_URL (default https://uiverify.ai).

Options:
  -h, --help                 Show this help.`;

const LOGOUT_HELP = `uiverify logout — forget this machine's login to UI Verify.

usage: uiverify logout

Options:
  -h, --help                 Show this help.`;

const WHOAMI_HELP = `uiverify whoami — show who this machine is signed in to UI Verify as, and your teams.

usage: uiverify whoami

Exits 1 when not signed in.

Options:
  -h, --help                 Show this help.`;

const authDeps: AuthDeps = {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function defaultStore(): CredentialStore {
  return credentialStore(credentialsPath(process.env, process.platform, os.homedir()), platformKeyStore(process.platform, process.env));
}

/** The inputs both subcommands resolve identically: auth, target URL, the capture dir, and the shared
 *  `softFail` funnel. Resolving them in one place keeps the two commands' operational-failure handling
 *  byte-identical (the funnel invariant). `process.exit`s on a rejected/incomplete invocation. */
interface CommonContext {
  credential: Credential;
  apiUrl: string;
  cwd: string;
  staticDir: string;
  isScreenshots: boolean;
  captureShape: CaptureShape;
  project: string | undefined;
  /** `--confirm-new` (upload only; `check` rejects it). */
  confirmNew: string | undefined;
  flags: Set<string>;
  multi: Map<string, string[]>;
  progress: UploadProgress;
  /** `softFail` for a problem the CLI found itself, reported under the given step and class. */
  failBefore: (stage: Stage, errorClass: ErrorClass, msg: string) => never;
  /** `softFail` for an error the run threw, reported with the step `progress` says it reached. */
  failRun: (error: unknown) => never;
  log: (msg: string) => void;
}

let reported = false;

async function resolveCommon(rest: string[], spec: ParseSpec, cmdName: "upload" | "check", usage: string): Promise<CommonContext> {
  const { flags, values, multi, invalid, removed } = parseArgs(rest, spec);
  // Strict-by-default: an operational failure (bad key, missing bundle, upload error — NOT the visual
  // verdict) fails the job unless explicitly opted out. Explicit --strict/--no-strict wins; else strict.
  const strict = resolveStrict({ strict: flags.has("strict"), noStrict: flags.has("no-strict") });
  const apiKey = process.env.UIVERIFY_API_KEY;
  const apiUrl = values.get("api-url") ?? process.env.UIVERIFY_API_URL ?? "https://uiverify.ai";
  const cwd = path.resolve(values.get("working-directory") ?? process.cwd());
  const staticDirArg = values.get("static-dir");
  const screenshotsArg = values.get("screenshots");
  const uploadDirArg = staticDirArg ?? screenshotsArg;
  const isScreenshots = screenshotsArg !== undefined;
  const staticDir = path.resolve(cwd, uploadDirArg ?? ".");
  const progress: UploadProgress = { stage: "git", producer: null, project: null };
  // Unknown until the credential is resolved, after the malformed-invocation check: telling a login from no
  // credential means reading the sealed store, which that path must not wait on.
  let credentialKind: CredentialKind | undefined = apiKey ? "key" : undefined;
  let heldToken: (() => string | null) | undefined;
  const sanitize = (text: string): string =>
    sanitizeReportMessage(text, { repoRoot: repoRoot(cwd) ?? cwd, home: os.homedir(), apiKey, knownPaths: [staticDir] });

  // At most one report per run, never for a run whose build already reached the server. The failure is built
  // only once reporting is known to be on, and nothing here may throw: it runs on the way to an exit whose
  // code must not change.
  function report(describe: () => Failure): void {
    if (reported || !reportsEnabled(process.env)) return;
    reported = true;
    try {
      const failure = describe();
      const { framework, frameworkSource, sdkName, sdkVersion } = detectFramework({
        staticDir,
        cwd,
        screenshots: isScreenshots,
        producer: progress.producer,
      });
      const { bearer, fields } =
        credentialKind === undefined
          ? { bearer: undefined, fields: {} }
          : reportCredential({
              kind: credentialKind,
              apiKey,
              heldToken,
              errorClass: failure.errorClass,
              project: progress.project ?? values.get("project"),
              repos: () => reportRemoteRepos(cwd, process.env),
            });
      sendReport({
        apiUrl,
        path: FAILURE_REPORT_PATH,
        bearer,
        env: process.env,
        body: {
          command: cmdName,
          ...failure,
          ...fields,
          framework,
          frameworkSource,
          sdkName,
          sdkVersion,
          cliVersion: CLI_VERSION,
          os: process.platform,
          arch: process.arch,
          nodeVersion: process.versions.node,
          ci: isCi(process.env),
        } satisfies FailureReport,
      });
      console.error(`[uiverify] ${REPORT_NOTICE}`);
    } catch {
      // Best effort: a report that can't be built is simply not sent.
    }
  }

  // Every operational failure funnels through here. Strict (the default) surfaces it as a job failure
  // (exit 1); --no-strict logs it loudly and swallows it with exit 0 so the run never fails the
  // consumer's CI. The secret is redacted either way.
  function softFail(msg: string, failure: (() => Failure) | null): never {
    const safe = redact(msg, apiKey);
    if (strict) {
      console.error(`[uiverify] ✗ ${safe}`);
    } else {
      console.error(`[uiverify] ⚠ ${safe} — non-blocking (--no-strict); exiting 0 so the run never fails your CI.`);
    }
    if (failure) report(failure);
    process.exit(strict ? 1 : 0);
  }

  function failBefore(stage: Stage, errorClass: ErrorClass, msg: string): never {
    softFail(msg, () => ({ stage, errorClass, message: sanitize(msg) }));
  }

  function failRun(error: unknown): never {
    const stage = progress.stage;
    const failure = stage === "done" ? null : () => classifyFailure(stage, error, sanitize, { signedIn: credentialKind === "login" });
    softFail(error instanceof Error ? error.message : String(error), failure);
  }

  // Unknown, malformed, or a boolean given a value. Exits 2 unconditionally (not through softFail): a
  // malformed invocation is a USER error, not an operational one, and --no-strict is about operational
  // failures, so honouring it here would exit 0 having run nothing — the "green but nothing uploaded"
  // outcome strict-by-default exists to prevent.
  if (invalid.length > 0) {
    const problem = `unrecognized or incomplete argument(s): ${[...new Set(invalid)].join(" ")}`;
    console.error(
      `[uiverify] ✗ ${problem}. Options that take a value need one (--static-dir <dir>); boolean flags take none. Run \`uiverify ${cmdName} --help\` for the full list.\n${usage}`,
    );
    report(() => ({ stage: "invocation", errorClass: "invalid_args", message: sanitize(problem) }));
    process.exit(2);
  }

  // Warned, not rejected: these worked in an earlier release, so failing the job would break a workflow
  // that upgrades without touching its arguments.
  for (const opt of new Set(removed)) {
    const note = removedOptionNote(opt);
    console.error(`[uiverify] ⚠ ${opt} was removed and is being ignored${note ? ` (${note})` : ""} — drop it from your workflow.`);
  }

  const auth = resolveCredential(process.env, apiUrl, defaultStore(), authDeps);
  credentialKind = !auth.ok ? "none" : auth.credential.signedIn ? "login" : "key";
  if (!auth.ok) failBefore("auth", auth.errorClass, auth.error);
  heldToken = auth.credential.heldToken;
  // With reports on, a login near expiry is renewed now, before any of the run's work, so a failure report can
  // carry a valid token: the report itself never renews. With them off, register renews as it always has.
  if (auth.credential.signedIn && reportsEnabled(process.env)) {
    try {
      await auth.credential.token();
    } catch {
      // Never fails the run here: its own steps fail as they would have, and register asks again.
    }
  }

  // Two mutually exclusive spellings for "what to upload": a prebuilt bundle (--static-dir) or a
  // directory of finished PNGs (--screenshots). Both resolve to one dir the flow tars.
  if (staticDirArg && screenshotsArg) {
    failBefore("invocation", "invalid_args", `pass either --static-dir or --screenshots, not both\n${usage}`);
  }
  if (!uploadDirArg) {
    failBefore(
      "invocation",
      "invalid_args",
      `provide --static-dir (build your Storybook first, e.g. \`npm run build-storybook\`) or --screenshots <dir> (a directory of finished PNGs)\n${usage}`,
    );
  }
  const log = (m: string): void => console.log(`[uiverify] ${redact(m, apiKey)}`);
  // A file sniff, never a mapping to a project type: the server derives that.
  const captureShape: CaptureShape = isScreenshots ? "screenshots" : isStorybookStaticDir(staticDir) ? "storybook" : "archive";

  return {
    credential: auth.credential,
    apiUrl,
    cwd,
    staticDir,
    isScreenshots,
    captureShape,
    project: values.get("project"),
    confirmNew: values.get("confirm-new"),
    flags,
    multi,
    progress,
    failBefore,
    failRun,
    log,
  };
}

/** The injected collaborators for `runUpload`, identical for both commands (a screenshot dir assembles
 *  its own manifest and has no capture SDK to report). */
function uploadDepsFor(ctx: CommonContext): UploadDeps {
  return {
    client: httpIngestClient(ctx.apiUrl, ctx.credential),
    gitMeta: () => collectGitMeta(ctx.cwd),
    confirmAncestors: (candidates, headSha) => confirmAncestors(candidates, headSha, ctx.cwd),
    workingTreeChanges: (headSha) => workingTreeChanges(headSha, ctx.cwd, { exclude: ctx.staticDir }),
    deltaFor: (bases, headSha, uncommitted) => deltaFor(bases, headSha, ctx.cwd, uncommitted),
    createBundle: ctx.isScreenshots ? createScreenshotBundle : createBundle,
    isStorybook: isStorybookStaticDir,
    bundleContentHash,
    readProducer: ctx.isScreenshots ? () => null : readArchiveProducer,
    bundleGraph,
    tmpFile: defaultTmpFile,
    log: ctx.log,
    progress: ctx.progress,
  };
}

async function uploadCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(UPLOAD_HELP);
    process.exit(0);
  }
  const ctx = await resolveCommon(rest, UPLOAD_SPEC, "upload", UPLOAD_USAGE);
  const exitZeroOnChanges = ctx.flags.has("exit-zero-on-changes");
  const skip = ctx.flags.has("render-all") ? "render-all" : "default";

  try {
    const res = await runUpload(
      {
        staticDir: ctx.staticDir,
        appUrl: ctx.apiUrl,
        autoAcceptChanges: ctx.flags.has("auto-accept-changes"),
        watchHint: ciWatchCommand(process.env) ?? undefined,
        skip,
        screenshots: ctx.isScreenshots,
        project: ctx.project,
        confirmNew: ctx.confirmNew,
        captureShape: ctx.captureShape,
        signedIn: ctx.credential.signedIn,
      },
      uploadDepsFor(ctx),
    );
    // The only deliberate non-zero exit: the visual verdict on a normal run. `--exit-zero-on-changes`
    // softens a `changed` (needs-review) verdict to exit 0 so changes surface in the dashboard without
    // failing CI; `failed`/`blocked` still gate.
    if (res.status === "changed" && exitZeroOnChanges) {
      ctx.log("Changes detected — not failing CI (--exit-zero-on-changes); review them in the dashboard.");
    }
    process.exit(exitCodeFor(res.status, { exitZeroOnChanges }));
  } catch (e) {
    ctx.failRun(e);
  }
}

async function checkCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CHECK_HELP);
    process.exit(0);
  }
  const ctx = await resolveCommon(rest, CHECK_SPEC, "check", CHECK_USAGE);
  const targets = ctx.multi.get("target") ?? [];
  // --target is required ONLY for a Storybook --static-dir. Storybook builds the whole monolithic suite
  // regardless of what you name, so a preview must name what to render or the server would render
  // everything — and the server rejects an empty target list for a Storybook preview. A screenshot upload
  // or a capture archive is already scoped at capture time (only the PNGs you took / the tests you
  // replayed are in the bundle), so the uploaded artifact IS the render set and --target is optional there.
  // A pure file sniff (iframe.html), never server logic — the dumb-client rule.
  if (ctx.captureShape === "storybook" && targets.length === 0) {
    ctx.failBefore(
      "invocation",
      "invalid_args",
      `--target is required for a Storybook check — Storybook builds the whole suite, so name what to render (e.g. --target 'components-button--*')\n${CHECK_USAGE}`,
    );
  }

  try {
    const res = await runUpload(
      {
        staticDir: ctx.staticDir,
        appUrl: ctx.apiUrl,
        preview: true,
        previewTargets: targets,
        screenshots: ctx.isScreenshots,
        project: ctx.project,
        captureShape: ctx.captureShape,
        signedIn: ctx.credential.signedIn,
      },
      uploadDepsFor(ctx),
    );
    // A preview check is not a gate: a `changed` verdict is the expected result the agent reviews over
    // MCP (exit 0). Only failed/blocked gate; operational failures already went through softFail.
    process.exit(previewExitCodeFor(res.status));
  } catch (e) {
    ctx.failRun(e);
  }
}

/** `login` / `logout` / `whoami`. A failure prints and exits 1, outside the setup-failure funnel, since "still
 *  waiting for approval" is the normal path of an agent's login; `login` reports its own endings from inside
 *  `runLogin`, never from here. */
async function accountCommand(rest: string[], cmd: "login" | "logout" | "whoami"): Promise<void> {
  const help = cmd === "login" ? LOGIN_HELP : cmd === "logout" ? LOGOUT_HELP : WHOAMI_HELP;
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(help);
    process.exit(0);
  }
  const { invalid } = parseArgs(rest, ACCOUNT_SPEC);
  if (invalid.length > 0) {
    console.error(`[uiverify] ✗ unrecognized argument(s): ${[...new Set(invalid)].join(" ")}. Run \`uiverify ${cmd} --help\`.`);
    process.exit(2);
  }
  const log = (m: string): void => console.log(`[uiverify] ${redact(m)}`);
  const fail = (e: unknown): never => {
    console.error(`[uiverify] ✗ ${redact(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  };
  const apiUrl = process.env.UIVERIFY_API_URL ?? "https://uiverify.ai";
  try {
    new URL(apiUrl);
  } catch {
    fail(`UIVERIFY_API_URL is not a valid URL: ${apiUrl}`);
  }
  const store = defaultStore();
  try {
    if (cmd === "logout") return await runLogout({ apiUrl, store, log });
    if (cmd === "whoami") return await runWhoami({ ...authDeps, apiUrl, store, log });
    const isTTY = process.stdout.isTTY === true;
    const outcome = await runLogin({
      ...authDeps,
      apiUrl,
      store,
      isTTY,
      clientHeaders: loginClientHeaders(process.env, isTTY, CLI_VERSION),
      reportEnded: loginEndingReporter({ apiUrl, env: process.env, isTTY, cliVersion: CLI_VERSION, notice: (l) => console.error(l) }),
      canOpenBrowser: shouldOpenBrowser(process.env, process.platform, isCi(process.env)),
      openBrowser,
      log,
    });
    if (outcome === "waiting") process.exit(1);
  } catch (e) {
    fail(e);
  }
}

async function main(): Promise<void> {
  holdSecret(process.env.UIVERIFY_API_KEY);
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(TOP_LEVEL_HELP);
    process.exit(0);
  }
  if (cmd === "upload") return uploadCommand(rest);
  if (cmd === "check") return checkCommand(rest);
  if (cmd === "login" || cmd === "logout" || cmd === "whoami") return accountCommand(rest, cmd);
  console.error(TOP_LEVEL_USAGE);
  process.exit(2);
}

void main();
