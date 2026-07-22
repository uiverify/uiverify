# `uiverify` — the CI uploader (`uiverify upload`)

Uploads a prebuilt Storybook static bundle to the UI Verify service, registers the build, then
**waits and streams render progress** (`Rendered X / N`) until the build finishes, reflecting the
visual verdict (`changed`/`failed`) in the exit code.

Standalone — it talks to the UI Verify service only over HTTP (the wire contracts are defined
locally in `src/client.ts`). It carries no rendering, diffing, or judging logic; that all runs
server-side. Distributed as `npx <pkg> upload …` once published to npm.

> **Package name:** the npm package is **`uiverify`** (repo `uiverify/uiverify`); the Playwright SDK
> publishes as **`@uiverify/playwright`**.

## What it does

1. Collect git metadata (`commit_sha`, `branch`, `pr_number`, `parent_shas`) — env overrides
   (`COMMIT_SHA`, `BRANCH`, `PR_NUMBER`, or GitHub Actions' `GITHUB_HEAD_REF`/`GITHUB_REF`) win.
2. Tar the static dir → `bundle.tgz` (no story list is read or sent — the UI Verify service enumerates
   the stories, and their render params, from the uploaded bundle's `index.json`). If the build
   emitted `preview-stats.json` (see [skip-unchanged](#skip-unchanged----stats-json) below), it rides
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
and **exit 0**, so the step can never fail your job. `--strict` is the default; `--no-strict` opts out
(and `--strict` wins a contradictory pair).

The visual verdict is the separate, independent gate: a normal run reflects `changed`/`failed` in the
exit code by design — that is the whole point of the default mode, and it's how UI Verify blocks a PR.

### Skip-unchanged (`--stats-json`)

UI Verify's TurboSnap-equivalent renders only the stories a commit's changed files could affect and carries
the rest forward — computed **server-side** (off by default behind `SKIP_UNCHANGED` on the UI Verify
service). Its precise tier walks the Storybook dependency graph, which only exists if you build with
Storybook's `--stats-json` flag (it writes `preview-stats.json` into `storybook-static`):

```sh
storybook build --stats-json          # or: pnpm build-storybook --stats-json
```

The CLI needs **no flag** — it tars the whole static dir, so `preview-stats.json` ships if present.
Without it, skip-unchanged falls back to a path heuristic (direct story file + its backing component);
with it, the server can trace shared deps (a util/theme imported by many stories) to the exact set.

## CLI

```
uiverify upload --static-dir <dir> [--working-directory <dir>] \
                [--api-url <url>] [--auto-accept-changes] [--exit-zero-on-changes] [--strict | --no-strict]
```

- `UIVERIFY_API_KEY` (env, required) — the project key.
- `--static-dir` the prebuilt `storybook-static` directory to upload (build Storybook first).
- `--api-url` (or `UIVERIFY_API_URL`, default `https://uiverify.ai`; override for self-host/local dev).
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
> in `packages/playwright`; and the agent skills (`@uiverify/skills`, a Claude Code plugin, not published to
> npm) live in `packages/skills` (see each README). Same "dumb client, no server-side logic" rule.
