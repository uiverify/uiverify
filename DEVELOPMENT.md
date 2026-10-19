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
> publishes as **`@uiverify/playwright`** and the Vitest SDK as **`@uiverify/vitest`**.

## What it does

1. Collect git metadata (`commit_sha`, `branch`, `pr_number`, `parent_shas`) — env overrides
   (`COMMIT_SHA`, `BRANCH`, `PR_NUMBER`, or GitHub Actions' `GITHUB_HEAD_REF`/`GITHUB_REF`) win.
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

1. **You choose what renders.** `--story <glob>` (repeatable; exact ids or anchored globs like
   `components-button--*`) is REQUIRED and REPLACES the dependency-graph closure a CI build computes.
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
npx uiverify check --story 'components-button--*' --static-dir storybook-static
```

`check` deliberately does NOT accept the CI gating flags (`--render-all`,
`--auto-accept-changes`, `--exit-zero-on-changes`) - they are meaningless on a preview check, so passing one is rejected rather
than silently ignored. Accept/deny happens after review, over the dashboard or the MCP accept tools.

## CLI

```
uiverify upload (--static-dir <dir> | --screenshots <dir>) [--working-directory <dir>] [--api-url <url>] \
                [--auto-accept-changes] [--exit-zero-on-changes] [--render-all] [--strict | --no-strict]

uiverify check  --story <glob> [--story <glob> …] (--static-dir <dir> | --screenshots <dir>) \
                [--working-directory <dir>] [--api-url <url>] [--strict | --no-strict]
```

- `UIVERIFY_API_KEY` (env, required) — the project key.
- `--story <glob>` (`check` only, repeatable, required) — the stories to render for the preview check.
- `--static-dir` the prebuilt `storybook-static` directory to upload (build Storybook first).
- `--api-url` (or `UIVERIFY_API_URL`, default `https://uiverify.ai`; override for self-host/local dev).
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
> in `packages/playwright`; the Vitest capture SDK (`@uiverify/vitest`) lives in `packages/vitest`; and the
> agent skills (`@uiverify/skills`, a Claude Code plugin, not published to npm) live in `packages/skills`
> (see each README). Same "dumb client, no server-side logic" rule.
