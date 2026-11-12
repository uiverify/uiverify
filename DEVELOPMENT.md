# `uiverify` — the UI Verify CLI (`uiverify upload` / `uiverify check`)

`uiverify upload` uploads a prebuilt Storybook static bundle to the UI Verify service, registers the
build, then **waits and streams render progress** (`Rendered X / N`) until the build finishes,
reflecting the visual verdict (`changed`/`failed`) in the exit code. `uiverify check` is the same
pipeline for a coding agent's edit loop (render only the stories you name, walled off from CI + main) -
see [`uiverify check`](#uiverify-check--the-interactive-preview-check-agent-edit-loop) below.

Standalone — it talks to the UI Verify service only over HTTP (the wire contracts are defined
locally in `src/client.ts`). It carries no rendering, diffing, or judging logic; that all runs
server-side. Distributed as `npx <pkg> upload …` once published to npm.

> **Package name:** the npm package is **`uiverify`** (repo `uiverify/uiverify`); the Playwright SDK
> publishes as **`@uiverify/playwright`**, the Vitest SDK as **`@uiverify/vitest`**, and the Bun SDK as
> **`@uiverify/bun`**.

## What it does

1. Collect git metadata (`commit_sha`, `branch`, `pr_number`, `parent_shas`) — env overrides
   (`COMMIT_SHA`, `BRANCH`, `PR_NUMBER`, or GitHub Actions' `GITHUB_HEAD_REF`/`GITHUB_REF`) win. On a
   GitHub Actions `pull_request`/`pull_request_target` run it also sends the PR head (`prHeadSha`, from the
   event payload) when the checkout is that head or the event's own merge commit, so the server posts the
   PR's check on the head even when a shallow merge checkout hides the merge's parents.
2. Tar the static dir → `bundle.tgz` (no story list is read or sent — the UI Verify service enumerates
   the stories, and their render params, from the uploaded bundle's `index.json`). If the build
   emitted `preview-stats.json` (see [skip-unchanged](#skip-unchanged) below), it rides
   along automatically — the CLI tars the whole static dir, no flag needed.
3. `POST /api/ingest/build` (API-key auth) → `{ build_id, upload_url }`.
4. `PUT` the bundle to `upload_url` (a local endpoint in dev; an S3 presigned URL in prod).
5. `POST /api/ingest/build/:id/uploaded` → the backend enumerates the stories from the bundle,
   resolves baselines, and enqueues the render job.
6. **Wait and stream.** Print the build URL, then poll `GET /api/ingest/build/:id` every ~2s and
   stream a live `Rendered X / N` progress line until the build finishes, then exit
   non-zero on `changed`/`failed`.

The API key only ever travels in the `Authorization` header and is redacted from all logs.

### Fail-closed on operational errors (strict by default)

A silently dropped upload shouldn't leave CI green ("green but nothing was uploaded"). So by default
**any operational failure fails the job**: a missing or empty `--static-dir`, a network or timeout
error, a missing/invalid `UIVERIFY_API_KEY`, or even a failure building the CLI itself is logged loudly
(`[uiverify] ✗ …`) and the step **exits 1**.

Opt out with **`--no-strict`**: operational failures are then swallowed with a `[uiverify] ⚠ …` warning
and **exit 0**. `--strict` is the default; `--no-strict` opts out (and `--strict` wins a contradictory
pair).

The visual verdict is the separate, independent gate: a normal run reflects `changed`/`failed` in the
exit code by design — that is the whole point of the default mode, and it's how UI Verify blocks a PR.

**Exit codes:** `0` success (or an operational failure under `--no-strict`); `1` the visual verdict, or an
operational failure under strict; **`2` a malformed invocation** — an unknown or misspelled option, a
boolean given a value, a stray token, or a bad subcommand. Exit 2 ignores `--no-strict` on purpose: that
flag means "don't fail my job if the upload breaks", not "run with arguments I didn't mean", and a typo'd
flag that exited 0 would leave CI green with nothing uploaded and no visual gate.

### Skip-unchanged

UI Verify's TurboSnap-equivalent renders only the stories a commit's changed files could affect and
carries the rest forward — decided **server-side** from the bundle's dependency graph and the changed
files the CLI diffs locally (each baseline commit against your checkout). It is **on by default**
whenever the bundle carries a graph, a `preview-stats.json` at the root of the upload dir:

- **Storybook** built with `--stats-json` (Storybook 8+; `--webpack-stats-json` on 7.x), which writes
  `preview-stats.json` into `storybook-static`.
- **A `@uiverify/vitest` 1.6.0+ archive**: the plugin writes the Vite module graph itself, after checking
  each test's imports against git. A test whose imports pass through files git doesn't track (bundler
  chunks, as under Angular's unit-test builder, a workspace package's built `dist/`, gitignored codegen),
  or that imports no tracked source, is left out of the graph and always renders; the run prints
  `[uiverify] The tests in N file(s) always render: …`. A graph from an older `@uiverify/vitest` (no
  `"uiverify": { "sourceChecked": true }` stamp) is treated as no graph by the default.
- **A Playwright (or other) archive** with a `preview-stats.json` put into the archive dir by hand, in the
  [module graph format](https://uiverify.ai/docs/skip-unchanged#module-graph-format):
  `{ "modules": [ { "name": "<repo-relative path>", "reasons": [ { "moduleName": "<an importer's path>" } ] } ] }`,
  with each spec file present as a module. `@uiverify/playwright` 1.4.0+ records each snapshot's
  `sourcePath` (the spec file relative to the Playwright config's directory) so the server can locate it.

There is no fallback tier: with no graph the server renders everything, by design — a path heuristic
can't see that a page story imports the leaf component that changed, so it isn't allowed to decide. The
CLI says so on **every** such Storybook or Vitest upload (short of `--render-all`, which asked for exactly
that), with the way to get a graph for that kind of bundle. A Playwright archive without one gets no line:
its tests open pages by URL, so "add a graph" isn't a fix a CI log reader can act on. It needs no
flag for the stats file itself: it tars the whole upload dir, so `preview-stats.json` ships if present.
Screenshot uploads (`--screenshots`) never skip server-side and print nothing; uploading only the
screens you changed is their skip.

```sh
npm run build-storybook -- --stats-json
npx uiverify upload --static-dir storybook-static
```

**Uncommitted edits.** The changed-file list includes every file where the checkout differs from the
commit — outside CI, tracked edits plus untracked files that aren't ignored; in CI, tracked edits only
(an untracked file there is something a step left behind, not part of the bundle). For a re-upload of
the same commit those files are sent as their own entry, so what they affect renders. The build is
registered as having uncommitted changes: it renders and can be accepted like any other, but later
builds don't skip stories based on it. So a local upload is safe on the default.

**Opting out.** `--render-all` renders every story, sends no changed files, and also sends no bundle
hash, so the "this exact commit already passed" shortcut can't skip the build either. `UIVERIFY_NO_DELTA=1` stops the CLI sending its changed files,
which leaves the server nothing to skip against, so it can only turn skipping off.

## `uiverify check` — the interactive preview check (agent edit loop)

`check` is the same pipeline as `upload` (register → PUT bundle → uploaded → poll) with three
differences, for a coding agent iterating mid-task rather than a CI gate:

1. **You choose what renders.** `--target <glob>` (repeatable; exact ids or anchored globs like
   `components-button--*`) is REQUIRED for a Storybook `--static-dir` (optional for an archive or
   screenshots, which already hold only what you captured) and REPLACES the dependency-graph closure a CI build computes.
   The whole Storybook bundle still uploads (the build is monolithic), but only the named stories render
   on the fleet - so editing one primitive doesn't render the third of the suite it touches.
2. **It is walled off from CI + main.** The build registers with `preview: true`: it posts no GitHub
   check, and an accept lands in a branch-scoped preview baseline, never a CI baseline - so it can never
   reach `main`. CI stays the only path to a `main` baseline.
3. **`changed` is informational.** Unlike `upload`, a `changed` verdict exits **0** (it is the result to
   review, not a gate); only `failed`/`blocked` or an operational error exit non-zero. The changed-story
   list + the MCP handoff (`get_build` / `render_diff_image` / `accept_build`) print so the agent can
   inspect the pixels and accept the ones it intended.

```sh
npm run build-storybook
npx uiverify check --target 'components-button--*' --static-dir storybook-static
```

`check` deliberately does NOT accept the CI gating flags (`--render-all`,
`--auto-accept-changes`, `--exit-zero-on-changes`) - they are meaningless on a preview check, so passing one is rejected rather
than silently ignored. Accept/deny happens after review, over the dashboard or the MCP accept tools.

## CLI

```
uiverify upload (--static-dir <dir> | --screenshots <dir>) [--project <slug|team/slug>] [--working-directory <dir>] \
                [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--render-all] [--strict | --no-strict]

uiverify check  [--target <glob> …] (--static-dir <dir> | --screenshots <dir>) [--project <slug|team/slug>] \
                [--working-directory <dir>] [--api-url <url>] [--strict | --no-strict]

uiverify login | logout | whoami
```

- `UIVERIFY_API_KEY` (env) — the project key. Wins when set; without it, `upload`/`check` use the confirmed
  `uiverify login` stored for the API URL's origin (`src/auth.ts`), else fail through `softFail`.
- `--project` — sent verbatim in the register body with `captureShape` (a file sniff: `storybook` / `archive` /
  `screenshots`) and `upstreamRepoFullName` (the `upstream` remote); the server picks a signed-in upload's
  project from them and answers a refusal (`project_ambiguous`, `project_not_found` with candidates, ...) with a
  message the CLI prints verbatim.
- `--target <glob>` (`check` only, repeatable; required for a Storybook `--static-dir`) — the stories to render for the preview check.
- `--static-dir` the prebuilt `storybook-static` directory to upload (build Storybook first).
- `--api-url` (or `UIVERIFY_API_URL`, default `https://uiverify.ai`; override for self-host/local dev).
- `UIVERIFY_TELEMETRY=0` (env) — don't send a failure report, and send no CLI version, CI or terminal headers
  on `login`'s requests. By default, a run that fails before its build reaches
  UI Verify (every `softFail`, and the exit 2 for an invalid `upload`/`check` option, until `markUploaded`
  succeeds; a bad or missing subcommand such as `uiverify --version` is never reported) hands a short, sanitized report to a
  detached process that POSTs it to `/api/ingest/failure-report` (`src/failure-report.ts`), so the exit code never
  depends on it and nothing waits on its network. It carries `credential` (`key` / `login` / `none`; on the exit-2
  report, which runs before the store is read, only `key` when a key is set, else absent) and `frameworkSource`. A signed-in run's bearer is the login's newest
  unexpired access token, held in memory (`Credential.heldToken`): `resolveCommon` renews it once, straight after the
  credential check, when it is near expiry, and the report path never renews (refresh tokens are single use, and a
  renewal cut off by the exit would sign the person out). Only a report with that bearer also carries the upload
  target (`project`: register's `team/slug` once register answered, else `--project`; `repoFullName` /
  `upstreamRepoFullName` read by the report with a bounded, quiet git), and a signed-in report keeps no server error
  text.
- `uiverify login` (`src/login.ts`, store in `src/credentials.ts`) — the AuthKit device flow against the CLI app the
  server names at `GET /api/cli/login`. Approved tokens are stored at once as an **unconfirmed** login, then
  confirmed with `POST /api/cli/session` (which fires `cli_login`); only a confirmed login authenticates an upload,
  and a rerun finishes an unconfirmed one without a second approval. Without a TTY a run returns within 60 s (at
  once when it couldn't open a browser) so an agent shell sees the link; a rerun resumes the same code. The store is
  one `0600` file under the config dir, every read-modify-write under a lockfile with a re-read, and renewal adopts a
  concurrent winner's rotated tokens (refresh tokens are single use). A `login` write that starts a store seals the
  file with AES-256-GCM under a key the OS keeps, each tool run by absolute path with the key over stdin: the macOS
  login keychain (`/usr/bin/security`, one fixed item); on Linux, only inside a graphical desktop session (not SSH,
  WSL or a container display), the Secret Service through `secret-tool` (one item per key, under a random id); on
  Windows, DPAPI through Windows PowerShell (the protected key travels in the file). A Linux or Windows file names
  its key store and key (`version: 2`); a macOS one keeps the original `version: 1` shape. Other writes keep the form
  they read, a store a shell can't open is renamed aside by `login`, and a store sealed by another system's key
  store is replaced by a plain one. `login`/`logout`/`whoami` send no setup failure report. A login that ends without signing
  in (`start_failed`, `denied`, `expired`, `expired_unwatched` for a code that died while no run polled it,
  `code_used`, `account_not_ready`, `rejected`, `refresh_refused`) reports it once to `/api/cli/login/failure`, from
  the run whose own store write ended it (`start_failed`, which has no code, from the run whose start failed;
  `reportEnded`); a run that ends "still waiting" never reports its own code. The login config and confirming
  requests carry `x-uiverify-cli-version` / `x-uiverify-ci` / `x-uiverify-tty` for UI Verify's login funnel. The `login-store-macos`,
  `login-store-linux` (gnome-keyring under `dbus-run-session`) and `login-store-windows` CI jobs run the store
  tests against the real tools.
- `--render-all` — render every story, even ones the dependency graph shows a change can't reach, and
  even if this exact commit already passed (see [Skip-unchanged](#skip-unchanged)).
- `--exit-zero-on-changes` — detect but don't block: a `changed` (needs-review) verdict exits 0 and
  stays pending review in the dashboard, so visual changes don't fail CI. `failed`/`blocked` still
  exit non-zero. The middle ground between the default (`changed` → job fails) and
  `--auto-accept-changes` (accept with no review).
- `--strict` / `--no-strict` — whether an operational error fails the job. Strict is the default; pass
  `--no-strict` to swallow operational errors and exit 0 (see
  [Fail-closed on operational errors](#fail-closed-on-operational-errors-strict-by-default)).

Run locally from the repo root via `pnpm install && pnpm -C packages/cli exec tsx bin/uiverify.ts upload …`,
or build with `pnpm -C packages/cli build` and run `node packages/cli/dist/uiverify.js upload …`.

> **Monorepo:** the CLI lives in `packages/cli`; the Playwright capture SDK (`@uiverify/playwright`) lives
> in `packages/playwright`; the Vitest capture SDK (`@uiverify/vitest`) lives in `packages/vitest`; the Bun
> capture SDK (`@uiverify/bun`) lives in `packages/bun`; and the agent skills live in `packages/skills`
> (`@uiverify/skills`, the `uiverify` Claude Code plugin) and `packages/workflow-skills`
> (`@uiverify/workflow-skills`, the `uiverify-workflow` plugin), neither published to npm (see each README).
> Same "dumb client, no server-side logic" rule.
