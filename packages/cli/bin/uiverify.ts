import path from "node:path";
import { CHECK_SPEC, type ParseSpec, UPLOAD_SPEC, parseArgs } from "../src/args";
import {
  createBundle,
  createScreenshotBundle,
  isStorybookStaticDir,
  onlyChangedNoOpReason,
  readArchiveProducer,
} from "../src/bundle";
import { httpIngestClient } from "../src/client";
import { exitCodeFor, previewExitCodeFor } from "../src/exit";
import { collectGitMeta, confirmAncestors } from "../src/git";
import { redact } from "../src/redact";
import { resolveStrict } from "../src/strict";
import { type UploadDeps, defaultTmpFile, runUpload } from "../src/upload";

/**
 * `uiverify` — two subcommands over the same ingest pipeline (register → PUT bundle → uploaded → poll):
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
 *    argv-validation paths go through `invalid`, not `softFail()`.
 */

const TOP_LEVEL_USAGE = "usage: uiverify <upload | check> [options]  (run `uiverify <command> --help`)";

const TOP_LEVEL_HELP = `uiverify — visual regression testing for Storybook, Vitest, Playwright, and custom screenshots.

${TOP_LEVEL_USAGE}

Commands:
  upload   Upload a prebuilt bundle for a CI visual check (gates the PR on changed/failed).
  check    Interactive preview check for a coding agent's edit loop: render only the stories you
           name and diff against the real CI baseline, without posting a check or moving a baseline.

Run \`uiverify upload --help\` or \`uiverify check --help\` for each command's options.

Environment:
  UIVERIFY_API_KEY   Project API key (required).
  UIVERIFY_API_URL   Override the default UI Verify API URL (https://uiverify.ai); for self-host/local dev.`;

const UPLOAD_USAGE =
  "usage: uiverify upload (--static-dir <dir> | --screenshots <dir>) [--working-directory <dir>] [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--only-changed] [--strict | --no-strict]";

const UPLOAD_HELP = `uiverify upload — upload a prebuilt Storybook bundle for visual regression testing.

${UPLOAD_USAGE}

Build your Storybook first (e.g. \`npm run build-storybook\`), then point --static-dir at its output.
Upload, register, then poll the build every ~2s and print a live "Rendered X / N" progress line until
it finishes. Exits non-zero if the visual gate is changed/failed — the one deliberate gating exit,
independent of --strict.

Options:
  --static-dir <dir>         Upload this prebuilt Storybook static directory (e.g. storybook-static),
                             or a Playwright/Vitest capture archive directory.
  --screenshots <dir>        Upload a directory of finished PNGs you already produced (native, mobile,
                             React Native). UI Verify diffs them without rendering. Mutually exclusive
                             with --static-dir. Each image is keyed by its path under the directory.
  --working-directory <dir>  Run in this directory (default: current directory).
  --api-url <url>            UI Verify API URL (default: https://uiverify.ai; override for self-host/local).
  --auto-accept-changes      Accept this build's changes as the new baseline (pass on merges to main).
  --exit-zero-on-changes     Detect but don't block: a changed (needs-review) verdict exits 0 and stays
                             pending review in the dashboard. failed/blocked still exit non-zero.
  --only-changed             Storybook only. Render only the stories this commit's changed files could
                             affect and carry the rest forward. Needs a bundle built with Storybook's
                             --stats-json; with no dependency graph every story renders. Ignored for
                             Playwright archive uploads, which always render in full.
  --strict                   Fail the CI job (exit 1) if the upload itself fails — bad/missing key,
                             missing bundle, network error. This is the DEFAULT.
  --no-strict                Never fail the CI job on an operational error (exit 0). The visual verdict
                             (changed/failed) still gates regardless.
  -h, --help                 Show this help.

Environment:
  UIVERIFY_API_KEY   Project API key (required).
  UIVERIFY_API_URL   Override the default UI Verify API URL (https://uiverify.ai); for self-host/local dev.`;

const CHECK_USAGE =
  "usage: uiverify check [--target <glob> …] (--static-dir <dir> | --screenshots <dir>) [--working-directory <dir>] [--api-url <url>] [--strict | --no-strict]";

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
  --working-directory <dir>  Run in this directory (default: current directory).
  --api-url <url>            UI Verify API URL (default: https://uiverify.ai; override for self-host/local).
  --strict                   Fail the job (exit 1) if the check itself fails — bad/missing key, missing
                             bundle, network error. This is the DEFAULT.
  --no-strict                Never fail on an operational error (exit 0).
  -h, --help                 Show this help.

Environment:
  UIVERIFY_API_KEY   Project API key (required).
  UIVERIFY_API_URL   Override the default UI Verify API URL (https://uiverify.ai); for self-host/local dev.`;

/** The inputs both subcommands resolve identically: auth, target URL, the capture dir, and the shared
 *  `softFail` funnel. Resolving them in one place keeps the two commands' operational-failure handling
 *  byte-identical (the funnel invariant). `process.exit`s on a rejected/incomplete invocation. */
interface CommonContext {
  apiKey: string;
  apiUrl: string;
  cwd: string;
  staticDir: string;
  isScreenshots: boolean;
  flags: Set<string>;
  multi: Map<string, string[]>;
  softFail: (msg: string) => never;
  log: (msg: string) => void;
}

function resolveCommon(rest: string[], spec: ParseSpec, cmdName: string, usage: string): CommonContext {
  const { flags, values, multi, invalid, removed } = parseArgs(rest, spec);
  // Strict-by-default: an operational failure (bad key, missing bundle, upload error — NOT the visual
  // verdict) fails the job unless explicitly opted out. Explicit --strict/--no-strict wins; else strict.
  const strict = resolveStrict({ strict: flags.has("strict"), noStrict: flags.has("no-strict") });
  const apiKey = process.env.UIVERIFY_API_KEY;

  // Every operational failure funnels through here. Strict (the default) surfaces it as a job failure
  // (exit 1); --no-strict logs it loudly and swallows it with exit 0 so the run never fails the
  // consumer's CI. The secret is redacted either way.
  function softFail(msg: string): never {
    const safe = redact(msg, apiKey);
    if (strict) {
      console.error(`[uiverify] ✗ ${safe}`);
      process.exit(1);
    }
    console.error(`[uiverify] ⚠ ${safe} — non-blocking (--no-strict); exiting 0 so the run never fails your CI.`);
    process.exit(0);
  }

  // Unknown, malformed, or a boolean given a value. Exits 2 unconditionally (not through softFail): a
  // malformed invocation is a USER error, not an operational one, and --no-strict is about operational
  // failures, so honouring it here would exit 0 having run nothing — the "green but nothing uploaded"
  // outcome strict-by-default exists to prevent.
  if (invalid.length > 0) {
    console.error(
      `[uiverify] ✗ unrecognized or incomplete argument(s): ${[...new Set(invalid)].join(" ")}. Options that take a value need one (--static-dir <dir>); boolean flags take none. Run \`uiverify ${cmdName} --help\` for the full list.\n${usage}`,
    );
    process.exit(2);
  }

  // Warned, not rejected: these worked in an earlier release, so failing the job would break a workflow
  // that upgrades without touching its arguments.
  for (const opt of new Set(removed)) {
    console.error(`[uiverify] ⚠ ${opt} was removed and is being ignored — drop it from your workflow.`);
  }

  if (!apiKey) softFail("UIVERIFY_API_KEY is required");
  const apiUrl = values.get("api-url") ?? process.env.UIVERIFY_API_URL ?? "https://uiverify.ai";
  const cwd = path.resolve(values.get("working-directory") ?? process.cwd());

  // Two mutually exclusive spellings for "what to upload": a prebuilt bundle (--static-dir) or a
  // directory of finished PNGs (--screenshots). Both resolve to one dir the flow tars.
  const staticDirArg = values.get("static-dir");
  const screenshotsArg = values.get("screenshots");
  if (staticDirArg && screenshotsArg) softFail(`pass either --static-dir or --screenshots, not both\n${usage}`);
  const uploadDirArg = staticDirArg ?? screenshotsArg;
  if (!uploadDirArg) {
    softFail(
      `provide --static-dir (build your Storybook first, e.g. \`npm run build-storybook\`) or --screenshots <dir> (a directory of finished PNGs)\n${usage}`,
    );
  }
  const isScreenshots = screenshotsArg !== undefined;
  const staticDir = path.resolve(cwd, uploadDirArg);
  const log = (m: string): void => console.log(`[uiverify] ${redact(m, apiKey)}`);

  return { apiKey, apiUrl, cwd, staticDir, isScreenshots, flags, multi, softFail, log };
}

/** The injected collaborators for `runUpload`, identical for both commands (a screenshot dir assembles
 *  its own manifest and has no capture SDK to report). */
function uploadDepsFor(ctx: CommonContext): UploadDeps {
  return {
    client: httpIngestClient(ctx.apiUrl, ctx.apiKey),
    gitMeta: () => collectGitMeta(ctx.cwd),
    confirmAncestors: (candidates, headSha) => confirmAncestors(candidates, headSha, ctx.cwd),
    createBundle: ctx.isScreenshots ? createScreenshotBundle : createBundle,
    readProducer: ctx.isScreenshots ? () => null : readArchiveProducer,
    tmpFile: defaultTmpFile,
    log: ctx.log,
  };
}

async function uploadCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(UPLOAD_HELP);
    process.exit(0);
  }
  const ctx = resolveCommon(rest, UPLOAD_SPEC, "upload", UPLOAD_USAGE);
  const exitZeroOnChanges = ctx.flags.has("exit-zero-on-changes");
  const onlyChanged = ctx.flags.has("only-changed");
  // Not a failure — a full render is always correct — but say it, or the run is indistinguishable from
  // a working opt-in. Stays a file check, never a reimplementation of the server's decision.
  const noOpReason = onlyChanged && !ctx.isScreenshots ? onlyChangedNoOpReason(ctx.staticDir) : null;
  if (onlyChanged && ctx.isScreenshots) {
    ctx.log(
      "⚠ --only-changed has no effect on a screenshot upload (no dependency graph) — to skip work, upload only the screens you changed.",
    );
  } else if (noOpReason === "no-graph") {
    ctx.log(
      "⚠ --only-changed, but no preview-stats.json in the bundle — every story will render. Build with Storybook's --stats-json to get the dependency graph.",
    );
  } else if (noOpReason === "archive") {
    ctx.log("⚠ --only-changed has no effect on a Playwright archive (no dependency graph) — every test will render.");
  }

  try {
    const res = await runUpload(
      {
        staticDir: ctx.staticDir,
        appUrl: ctx.apiUrl,
        autoAcceptChanges: ctx.flags.has("auto-accept-changes"),
        onlyChanged,
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
    ctx.softFail(e instanceof Error ? e.message : String(e));
  }
}

async function checkCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(CHECK_HELP);
    process.exit(0);
  }
  const ctx = resolveCommon(rest, CHECK_SPEC, "check", CHECK_USAGE);
  const targets = ctx.multi.get("target") ?? [];
  // --target is required ONLY for a Storybook --static-dir. Storybook builds the whole monolithic suite
  // regardless of what you name, so a preview must name what to render or the server would render
  // everything — and the server rejects an empty target list for a Storybook preview. A screenshot upload
  // or a capture archive is already scoped at capture time (only the PNGs you took / the tests you
  // replayed are in the bundle), so the uploaded artifact IS the render set and --target is optional there.
  // A pure file sniff (iframe.html), never server logic — the dumb-client rule.
  const isStorybook = !ctx.isScreenshots && isStorybookStaticDir(ctx.staticDir);
  if (isStorybook && targets.length === 0) {
    ctx.softFail(
      `--target is required for a Storybook check — Storybook builds the whole suite, so name what to render (e.g. --target 'components-button--*')\n${CHECK_USAGE}`,
    );
  }

  try {
    const res = await runUpload(
      { staticDir: ctx.staticDir, appUrl: ctx.apiUrl, preview: true, previewTargets: targets },
      uploadDepsFor(ctx),
    );
    // A preview check is not a gate: a `changed` verdict is the expected result the agent reviews over
    // MCP (exit 0). Only failed/blocked gate; operational failures already went through softFail.
    process.exit(previewExitCodeFor(res.status));
  } catch (e) {
    ctx.softFail(e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(TOP_LEVEL_HELP);
    process.exit(0);
  }
  if (cmd === "upload") return uploadCommand(rest);
  if (cmd === "check") return checkCommand(rest);
  console.error(TOP_LEVEL_USAGE);
  process.exit(2);
}

void main();
