import path from "node:path";
import { createBundle } from "../src/bundle";
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
 * --strict, --no-strict, --help (see `uiverify upload --help`).
 *
 * Two independent non-zero exits:
 *  - *Operational* failures (missing config, a missing/empty static dir, a network/timeout error — the
 *    upload itself not happening) fail the job by default (`resolveStrict`, fail-closed) so a silently
 *    dropped upload can't leave CI green. `--no-strict` swallows them with exit 0. Everything operational
 *    funnels through `softFail()`.
 *  - The visual verdict (changed/failed) is the deliberate gating exit on a normal run — the whole
 *    point of it.
 */
function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

const USAGE =
  "usage: uiverify upload --static-dir <dir> [--working-directory <dir>] [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--strict | --no-strict]";

const HELP = `uiverify upload — upload a prebuilt Storybook bundle for visual regression testing.

${USAGE}

Build your Storybook first (e.g. \`npm run build-storybook\`), then point --static-dir at its output.
Upload, register, then poll the build every ~2s and print a live "Rendered X / N" progress line until
it finishes. Exits non-zero if the visual gate is changed/failed — the one deliberate gating exit,
independent of --strict.

Options:
  --static-dir <dir>         Upload this prebuilt Storybook static directory (e.g. storybook-static).
  --working-directory <dir>  Run in this directory (default: current directory).
  --api-url <url>            UI Verify API URL (default: https://uiverify.ai; override for self-host/local).
  --auto-accept-changes      Accept this build's changes as the new baseline (pass on merges to main).
  --exit-zero-on-changes     Detect but don't block: a changed (needs-review) verdict exits 0 and stays
                             pending review in the dashboard. failed/blocked still exit non-zero.
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
  const { flags, values } = parseArgs(rest);
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

  if (!apiKey) softFail("UIVERIFY_API_KEY is required");
  const apiUrl =
    values.get("api-url") ?? process.env.UIVERIFY_API_URL ?? "https://uiverify.ai";
  const cwd = path.resolve(values.get("working-directory") ?? process.cwd());

  let staticDir = values.get("static-dir");
  if (!staticDir) {
    softFail(`provide --static-dir (build your Storybook first, e.g. \`npm run build-storybook\`)\n${USAGE}`);
  }
  staticDir = path.resolve(cwd, staticDir);

  const log = (m: string): void => console.log(`[uiverify] ${redact(m, apiKey)}`);
  try {
    const res = await runUpload(
      {
        staticDir,
        appUrl: apiUrl,
        autoAcceptChanges: flags.has("auto-accept-changes"),
      },
      {
        client: httpIngestClient(apiUrl, apiKey),
        gitMeta: () => collectGitMeta(cwd),
        confirmAncestors: (candidates, headSha) => confirmAncestors(candidates, headSha, cwd),
        createBundle,
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
