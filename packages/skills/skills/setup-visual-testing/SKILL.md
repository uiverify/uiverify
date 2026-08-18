---
name: setup-visual-testing
description: Set up UI Verify visual regression testing in a repo end to end — detect or scaffold the capture path (Storybook stories, a Playwright suite, or Vitest browser-mode component tests), install the uiverify CLI and wire it into CI, and author the first stories the economical, deterministic way from the start. Use when adding visual/screenshot regression testing to a project for the first time, wiring UI Verify into CI, or onboarding a repo that has no visual tests yet.
---

# Set up UI Verify, end to end

Goal: take a repo from **no visual testing** to **a green UI Verify check on every PR**, with the first
stories authored the cheap + deterministic way so the setup doesn't start flaky or expensive. This
skill is the conductor — it decides the capture path, wires CI, then hands the authoring and
determinism work to the focused skills.

## Step 1 — pick the capture path (don't ask the user; detect it)

UI Verify captures UI four ways. Choose by what the repo already has:

- **Storybook path** — the repo has `.storybook/` or `@storybook/*` in `package.json`, or is a
  component/design-system library. Each **story** is a snapshot. This is the default; prefer it when
  components exist in isolation.
- **Playwright path** — the repo has a `@playwright/test` suite and you want to test **assembled real
  pages** (the app, staging, or prod), not isolated components. Each test archives its final UI state
  for UI Verify to replay + diff.
- **Vitest path** — the repo already runs component tests in **Vitest browser mode** (`@vitest/browser`
  with a Playwright provider), and you want those component renders diffed without adopting Storybook.
  Each browser-mode test archives its final DOM. Prefer this over scaffolding Storybook only when a
  browser-mode suite already exists.
- **Screenshot-upload path** — the repo is **native / mobile / React Native** (or otherwise can't
  render in a browser) but already produces finished screenshots from its own harness (Detox, Maestro,
  native snapshot tests). Upload those PNGs directly with `--screenshots`; UI Verify diffs, judges, and
  baselines them with no rendering. There are no stories to author and determinism is owned by your
  capture harness, so Steps 2-3 (client SDK + story authoring) don't apply — install the CLI
  (`npm i -D uiverify`), then jump to Step 4 and wire the CI upload with `--screenshots ./screenshots`
  in place of `--static-dir`. Upload only the screens a PR changed and the rest carry forward.

If none exists and the repo is a browser app, scaffold Storybook (`npx storybook@latest init`) — it's
the lower-friction path and gives you deterministic isolation for free (see `storybook-visual-testing`).

## Step 2 — install the client

**Storybook:**
```bash
npm i -D uiverify
```

**Playwright** — swap the import so every test also archives its UI state:
```diff
- import { test, expect } from '@playwright/test';
+ import { test, expect } from '@uiverify/playwright';
```
```bash
npm i -D @uiverify/playwright uiverify
```

**Vitest** — add the plugin to `vitest.config.ts` so every browser-mode test archives its final DOM:
```ts
import { playwright } from '@vitest/browser-playwright';
import { uiverifyPlugin } from '@uiverify/vitest/plugin';
export default defineConfig({
  plugins: [uiverifyPlugin()],
  test: { browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }] } },
});
```
```bash
npm i -D @uiverify/vitest @vitest/browser-playwright uiverify
```

## Step 3 — author the first stories the right way

Don't snapshot whatever exists as-is. Author (or refactor) the first few stories using the two
authoring skills, in this order:

1. **`economical-stories`** — collapse variant matrices into gallery/data-driven stories so you snapshot
   the fewest billable shots for full coverage. Do this *before* determinism work — fewer stories is
   less to make deterministic.
2. **`storybook-visual-testing`** (Storybook), **`playwright-visual-testing`** (Playwright), or
   **`vitest-visual-testing`** (Vitest) — remove the run-to-run variation the tool can't neutralize from
   outside your app (mostly: the clock, live data, infinite animations).

## Step 4 — wire CI

Add a CI workflow so every PR gets a check. Store the project's `UIVERIFY_API_KEY` (a `uv_proj_…`
key from the dashboard) as a repo secret, then run the `uiverify` CLI (installed in Step 2).

```yaml
# .github/workflows/visual.yml
name: Visual
on: pull_request
jobs:
  uiverify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }             # full history so baseline ancestry works
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build-storybook            # produces ./storybook-static
      - run: npx uiverify upload --static-dir storybook-static
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
        # Playwright / Vitest instead (browsers aren't preinstalled on the runner): run
        #   "npx playwright install --with-deps && npx playwright test"  (or "npx vitest run"), then
        #   "npx uiverify upload --static-dir uiverify-archive".
        # Screenshot upload (native / mobile / React Native): produce your PNGs (Detox, Maestro, etc.),
        #   then "npx uiverify upload --screenshots ./screenshots" in place of the build+upload steps.
```

Locally the same thing is:
```bash
npm run build-storybook && UIVERIFY_API_KEY=uv_proj_… npx uiverify upload --static-dir storybook-static
# Playwright:  npx playwright test && npx uiverify upload --static-dir uiverify-archive
# Vitest:      npx playwright install --with-deps && npx vitest run && npx uiverify upload --static-dir uiverify-archive
```

**Optional — run only on PRs that can change the UI.** The workflow above fires on every PR, and the
archive paths (Playwright/Vitest) always render in full, so on a busy repo scope it to UI-affecting
changes. Two ways, and they differ on required checks:

- **Plain `paths:` filter** — add `paths:` to the trigger. Simplest, but it skips the *whole job*, so it
  reports no status. If the UI Verify check is a **required** status check, a PR touching none of those
  paths is stuck "Expected" and can't merge. Use only when the check isn't required.
- **`dorny/paths-filter` (required-check-safe)** — a first job computes whether UI files changed; the
  upload job always runs but guards each step on that result, so a backend-only PR no-ops yet still
  reports green and never wedges the required check. Prefer this.

```yaml
# .github/workflows/visual.yml
on:
  push:
    branches: [main]          # advance the baseline as PRs merge
  pull_request:
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs: { ui: '${{ steps.f.outputs.ui }}' }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: dorny/paths-filter@v4
        id: f
        with:
          filters: |
            ui:
              - 'src/components/**'
              - 'src/app/**'
              - 'packages/ui/**'                 # shared UI packages
              - '**/*.css'
              - '.github/workflows/visual.yml'    # the workflow itself
  uiverify:
    needs: changes
    runs-on: ubuntu-latest
    steps:                     # every step below is also guarded:  if: ${{ needs.changes.outputs.ui == 'true' }}
      - if: ${{ needs.changes.outputs.ui == 'true' }}
        uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # ...the setup-node / install / build / upload steps from Step 4, each guarded the same way.
      # On main, add --auto-accept-changes to the upload so the post-merge render becomes the baseline.
```

**A missed render is silent — bias to include.** An unnecessary run costs a few CI minutes; a *missed*
one renders nothing, the check passes green, and the unseen change becomes the next baseline every branch
inherits. So list every dir the UI is built from (components, pages, shared UI packages, global CSS) **and
the workflow file itself** — and **don't exclude a mixed folder just because it's mostly backend**: a
`lib/` holding both a `cn()` helper the UI imports and unrelated db/AI code stays in the filter. If that
over-runs, **split the UI-facing code onto its own path, then filter on that** — separate for granularity;
never trade coverage for speed.

**Optional, Storybook or Vitest — render only what the PR could have changed.** UI Verify can render just
the stories your commit's changed files could affect and carry the rest of the baselines forward. To turn
it on for **Storybook**, edit the two `- run:` steps in `.github/workflows/visual.yml` (the build and the
upload) in place — add `-- --stats-json` to the build, and `--only-changed` to the upload:

```yaml
      - run: npm run build-storybook -- --stats-json    # adds preview-stats.json to storybook-static
      - run: npx uiverify upload --static-dir storybook-static --only-changed
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
```

Both edits are required, and they replace the existing steps — don't append them, or the job builds
Storybook twice and registers two builds per PR. The decision runs server-side off the dependency graph
in `preview-stats.json`, so without `--stats-json` every story renders even with the flag on (the CLI
warns when it spots this).

**Vitest** carries forward too, and needs no build flag: `@uiverify/vitest` **1.1+** writes the Vite
module graph into the archive on its own, so you only add `--only-changed` to the upload:

```yaml
      - run: npx uiverify upload --static-dir uiverify-archive --only-changed
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
```

For Vitest the skip is only as granular as your **test files**: the server traces a changed source file to
the tests that *import* it and carries the rest forward, so keep **one page/component per
`*.visual.test.tsx` file** (each importing only what it renders). A file that colocates next to its
component (`SecurityPage.visual.test.tsx` beside `SecurityPage.tsx`) lets a one-component change skip every
other page; a single mega-test that imports half the app re-renders on every commit. It does nothing for
the **Playwright** path — a Playwright archive has no dependency graph, so the flag is a no-op there.

Check the Storybook major first - the flag is `--stats-json` on Storybook 8+, but `--webpack-stats-json`
on 7.x, and passing the wrong one fails the build step before the upload ever runs.

Leave this off for the first few runs; turn it on once the check is green and you want the bill to track
the size of the diff rather than the size of the suite.

## Step 5 — the check gates every PR

Once wired, every PR gets a UI Verify check. The first run on your default branch captures the
baseline; after that each PR is diffed against it, and a real visual regression (or an operational
failure like a broken build or network error) turns the job red. Strict-by-default is intentional: a
silently dropped upload must not leave CI green. If the first few diffs are noisy, don't disable the
check — loop back to the determinism skill (Step 3) to remove the flake at its source.

## Step 6 — connect your agent so it can see the diffs (MCP)

The check gates the PR; the **MCP** is how your coding agent reviews it without leaving the terminal —
list builds, look at the actual before/after pixels, post them to the PR, accept baselines. Add it as a
real MCP server (Claude Code, Cursor, Codex, …) — don't hand-roll `curl`, or the image tools come back
as blocks a shell can't render. One command for Claude Code:

```sh
claude mcp add --transport http uiverify https://uiverify.ai/api/mcp \
  --header "Authorization: Bearer $UIVERIFY_API_KEY"
```

Then hand the review loop to **`triage-visual-changes`** (it has the per-client setup and the recipes:
bucket real regressions vs noise, put the before/after in the PR, bulk-accept). On a **passed** build the
agent can still pull any story's current image by id to confirm it looks right.

**Make it stick — add a rule to your `AGENTS.md` / `CLAUDE.md`.** The setup only pays off if new UI keeps
getting captured. A one-line rule ("when you add or change a component/page, add or update its story/test
so it's covered by visual testing, then run the UI Verify check and triage it") turns this from a
one-time wiring into a habit the agent follows on every change.

## Done when

- A PR shows a UI Verify check with a baseline captured.
- The first build's changed-stories list is empty or all-real (no clock/data/animation flake) — if not,
  loop back to the determinism skill for that path.
- Stories cover the variants without one-story-per-combo explosion (`economical-stories` applied).
