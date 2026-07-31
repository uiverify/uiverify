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

UI Verify captures UI three ways. Choose by what the repo already has:

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

If none exists, scaffold Storybook (`npx storybook@latest init`) — it's the lower-friction path and
gives you deterministic isolation for free (see `storybook-visual-testing`).

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

Add a CI workflow so every PR gets a check. Store the project's `UIVERIFY_API_KEY` (a `vt_live_…`
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
```

Locally the same thing is:
```bash
npm run build-storybook && UIVERIFY_API_KEY=vt_live_… npx uiverify upload --static-dir storybook-static
# Playwright:  npx playwright test && npx uiverify upload --static-dir uiverify-archive
# Vitest:      npx playwright install --with-deps && npx vitest run && npx uiverify upload --static-dir uiverify-archive
```

**Optional, Storybook only — render only what the PR could have changed.** UI Verify can render just the
stories your commit's changed files could affect and carry the rest of the baselines forward. To turn it
on, edit the two `- run:` steps in `.github/workflows/visual.yml` (the build and the upload) in place —
add `-- --stats-json` to the build, and `--only-changed` to the upload:

```yaml
      - run: npm run build-storybook -- --stats-json    # adds preview-stats.json to storybook-static
      - run: npx uiverify upload --static-dir storybook-static --only-changed
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
```

Both edits are required, and they replace the existing steps — don't append them, or the job builds
Storybook twice and registers two builds per PR. The decision runs server-side off the dependency graph
in `preview-stats.json`, so without `--stats-json` every story renders even with the flag on (the CLI
warns when it spots this). It does nothing for the Playwright path: an archive has no dependency graph.

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

## Done when

- A PR shows a UI Verify check with a baseline captured.
- The first build's changed-stories list is empty or all-real (no clock/data/animation flake) — if not,
  loop back to the determinism skill for that path.
- Stories cover the variants without one-story-per-combo explosion (`economical-stories` applied).
