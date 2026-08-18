import path from "node:path";
import { parseArgs } from "../src/args";
import { createBundle, createScreenshotBundle, onlyChangedNoOpReason, readArchiveProducer } from "../src/bundle";
import { httpIngestClient } from "../src/client";
import { exitCodeFor } from "../src/exit";
import { collectGitMeta, confirmAncestors } from "../src/git";
import { redact } from "../src/redact";
import { resolveStrict } from "../src/strict";
import { defaultTmpFile, runUpload } from "../src/upload";

/**
 * `uiverify upload` — upload a prebuilt Storybook static bundle, register the build, then wait-and-stream:
 * poll the build, print a live "Rendered X / N" progress line until it finishes, and reflect the visual
 * verdict (changed/failed) in the exit code. Build your Storybook first, then pass its output to
 * `--static-dir`.
 * Flags: --static-dir, --working-directory, --api-url, --auto-accept-changes, --exit-zero-on-changes,
 * --only-changed, --strict, --no-strict, --help (see `uiverify upload --help`).
 *
 * Three independent non-zero exits:
 *  - *Operational* failures (missing config, a missing/empty static dir, a network/timeout error — the
 *    upload itself not happening) fail the job by default (`resolveStrict`, fail-closed) so a silently
 *    dropped upload can't leave CI green. `--no-strict` swallows them with exit 0. Everything operational
 *    funnels through `softFail()`.
 *  - The visual verdict (changed/failed) is the deliberate gating exit on a normal run — the whole
 *    point of it.
 *  - A malformed invocation exits **2**, ignoring `--no-strict`: an unknown or misspelled option, a
 *    boolean given a value, a stray token (`parseArgs`' `invalid`), or a bad subcommand. That flag means
 *    "don't fail my job if the upload breaks", not "run with arguments I didn't mean" — swallowing it
 *    would exit 0 having uploaded nothing. New argv-validation paths go through `invalid`, not
 *    `softFail()`.
 */

const USAGE =
  "usage: uiverify upload (--static-dir <dir> | --screenshots <dir>) [--working-directory <dir>] [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--only-changed] [--strict | --no-strict]";

const HELP = `uiverify upload — upload a prebuilt Storybook bundle for visual regression testing.

${USAGE}

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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    process.exit(0);
  }
  if (cmd !== "upload") {
    console.error(USAGE);
    process.exit(2);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const { flags, values, invalid, removed } = parseArgs(rest);
  // Strict-by-default: an operational failure (bad key, missing bundle, upload error — NOT the visual
  // verdict) fails the job unless explicitly opted out, so a silently dropped upload can't leave CI
  // green. Explicit --strict/--no-strict wins; else strict.
  const strict = resolveStrict({
    strict: flags.has("strict"),
    noStrict: flags.has("no-strict"),
  });
  const exitZeroOnChanges = flags.has("exit-zero-on-changes");
  const apiKey = process.env.UIVERIFY_API_KEY;

  // Every operational failure funnels through here. Strict (the default) surfaces it as a job failure
  // (exit 1); --no-strict logs it loudly and swallows it with exit 0 so the upload never fails the
  // consumer's CI. The secret is redacted either way. (A function so its `never` return narrows the
  // callers below.)
  function softFail(msg: string): never {
    const safe = redact(msg, apiKey);
    if (strict) {
      console.error(`[uiverify] ✗ ${safe}`);
      process.exit(1);
    }
    console.error(`[uiverify] ⚠ ${safe} — non-blocking (--no-strict); exiting 0 so the upload never fails your CI.`);
    process.exit(0);
  }

  // Unknown, malformed, or a boolean given a value. Rejected rather than guessed: a typo'd flag that
  // parses "successfully" produces a run that renders something other than what was asked for, with a
  // CI log identical to one that worked.
  //
  // Exits 2 unconditionally rather than routing through `softFail`, matching the bad-subcommand path
  // above. A malformed invocation is a USER error, not an operational one, and `--no-strict` is a
  // statement about operational failures ("don't fail my job if the upload breaks") — honouring it here
  // would exit 0 having uploaded nothing, which is exactly the "green but nothing was uploaded" outcome
  // strict-by-default exists to prevent. The old parser ignored unknown flags and uploaded anyway, so
  // silently swallowing this would be strictly worse than the behaviour it replaced.
  if (invalid.length > 0) {
    console.error(
      `[uiverify] ✗ unrecognized or incomplete argument(s): ${[...new Set(invalid)].join(" ")}. Options that take a value need one (--static-dir <dir>); boolean flags take none (pass --only-changed bare). Run \`uiverify upload --help\` for the full list.\n${USAGE}`,
    );
    process.exit(2);
  }

  // Warned, not rejected: these worked in an earlier release, so failing the job would break a workflow
  // that upgrades without touching its arguments. Printed before the key check so it shows either way.
  for (const opt of new Set(removed)) {
    console.error(`[uiverify] ⚠ ${opt} was removed and is being ignored — drop it from your workflow.`);
  }

  if (!apiKey) softFail("UIVERIFY_API_KEY is required");
  const apiUrl =
    values.get("api-url") ?? process.env.UIVERIFY_API_URL ?? "https://uiverify.ai";
  const cwd = path.resolve(values.get("working-directory") ?? process.cwd());

  // Two mutually exclusive spellings for "what to upload": a prebuilt bundle (`--static-dir`) or a
  // directory of finished PNGs (`--screenshots`, Model 3). Both resolve to one dir the flow tars.
  const staticDirArg = values.get("static-dir");
  const screenshotsArg = values.get("screenshots");
  if (staticDirArg && screenshotsArg) {
    softFail(`pass either --static-dir or --screenshots, not both\n${USAGE}`);
  }
  const uploadDirArg = staticDirArg ?? screenshotsArg;
  if (!uploadDirArg) {
    softFail(
      `provide --static-dir (build your Storybook first, e.g. \`npm run build-storybook\`) or --screenshots <dir> (a directory of finished PNGs)\n${USAGE}`,
    );
  }
  const isScreenshots = screenshotsArg !== undefined;
  const staticDir = path.resolve(cwd, uploadDirArg);

  const log = (m: string): void => console.log(`[uiverify] ${redact(m, apiKey)}`);

  const onlyChanged = flags.has("only-changed");
  // Not a failure — a full render is always correct — but say it, or the run is indistinguishable from
  // a working opt-in. Stays a file check, never a reimplementation of the server's decision.
  const noOpReason = onlyChanged && !isScreenshots ? onlyChangedNoOpReason(staticDir) : null;
  if (onlyChanged && isScreenshots) {
    log(
      "⚠ --only-changed has no effect on a screenshot upload (no dependency graph) — to skip work, upload only the screens you changed.",
    );
  } else if (noOpReason === "no-graph") {
    log(
      "⚠ --only-changed, but no preview-stats.json in the bundle — every story will render. Build with Storybook's --stats-json to get the dependency graph.",
    );
  } else if (noOpReason === "archive") {
    log("⚠ --only-changed has no effect on a Playwright archive (no dependency graph) — every test will render.");
  }

  try {
    const res = await runUpload(
      {
        staticDir,
        appUrl: apiUrl,
        autoAcceptChanges: flags.has("auto-accept-changes"),
        onlyChanged,
      },
      {
        client: httpIngestClient(apiUrl, apiKey),
        gitMeta: () => collectGitMeta(cwd),
        confirmAncestors: (candidates, headSha) => confirmAncestors(candidates, headSha, cwd),
        // A screenshot upload assembles its own manifest and has no capture SDK to report.
        createBundle: isScreenshots ? createScreenshotBundle : createBundle,
        readProducer: isScreenshots ? () => null : readArchiveProducer,
        tmpFile: defaultTmpFile,
        log,
      },
    );
    // The only deliberate non-zero exit: the visual verdict on a normal run. `--exit-zero-on-changes`
    // softens a `changed` (needs-review) verdict to exit 0 so changes surface in the dashboard without
    // failing CI; `failed`/`blocked` still gate.
    if (res.status === "changed" && exitZeroOnChanges) {
      log("Changes detected — not failing CI (--exit-zero-on-changes); review them in the dashboard.");
    }
    process.exit(exitCodeFor(res.status, { exitZeroOnChanges }));
  } catch (e) {
    softFail(e instanceof Error ? e.message : String(e));
  }
}

void main();
