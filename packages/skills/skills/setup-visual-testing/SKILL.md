---
name: setup-visual-testing
description: Set up UI Verify visual regression testing in a repo end to end — pick the capture path the same way the one-line setup does (Storybook stories, a Playwright suite, Bun visual tests, Vitest browser-mode component tests, or uploaded screenshots), install the uiverify CLI and wire it into CI, and author the first stories the economical, deterministic way from the start. Use when adding visual/screenshot regression testing to a project for the first time, wiring UI Verify into CI, or onboarding a repo that has no visual tests yet.
---

# Set up UI Verify, end to end

Goal: take a repo from **no visual testing** to **a green UI Verify check on every PR**, with the first
stories authored the cheap + deterministic way so the setup doesn't start flaky or expensive. This
skill is the conductor — it decides the capture path, wires CI, then hands the authoring and
determinism work to the focused skills.

## Step 0 — sign in

Before the first upload, sign in the way `https://uiverify.ai/install.md` does: run `npx -y uiverify login`.
It prints a link and a short code (and opens the browser when it can). Show the user the link and the code,
tell them to sign in or sign up there and approve, and while it says it is still waiting, run the same command
again (same code). It exits 0 once signed in and prints "Signed in as ...". Say that line to the user. The
first signed-in upload creates their team and project, and passes `--project <team>/<slug>` when they already
made one on the website.

If `npx uiverify login` can't finish for any reason (it can't write its config folder, the keychain can't be
reached, there is no browser and the user can't open the link, the approval never comes before the code
expires, the CLI doesn't know a `login` command, or any other error), stop retrying it. Ask the user for a
project key instead: it starts with `uv_proj_`, and their UI Verify project's settings show it under API key (no
project yet: they create one at uiverify.ai/onboarding, under "Create a project"). Then run the same upload
with the key as `UIVERIFY_API_KEY`. In CI the key is always what authenticates the upload (Step 4).

## Step 1 — pick the capture path (don't ask the user; detect it)

UI Verify captures UI five ways. If the request is the one-line setup (it says to fetch
`https://uiverify.ai/install.md`), follow that guide's framework step instead of this one: a setup line that
carries the project (a project key, or "My UI Verify project is <team>/<slug>") and names Storybook may be the project's preselected default, and the guide decides
when to set up the framework the repo already uses. Otherwise, if the user named one ("set up UI Verify for
Storybook"), use it.
Otherwise pick it the way the one-line setup (`https://uiverify.ai/install.md`) does, so a repo gets the
same framework whichever way it was set up:

- A **native-only app** (iOS, Android, React Native) with no web front end: the **screenshot-upload
  path**. A repo that also has a web front end uses the list below, and you mention the native app at the end.
- A **web app**: the first that matches.
  1. **Storybook** — the repo has Storybook (a `.storybook/` folder or a `storybook` / `@storybook/*`
     dependency).
  2. **Playwright** — the repo already has Playwright tests (`@playwright/test` and a `playwright.config`).
  3. **Bun** — the repo runs its tests with `bun test`.
  4. **Vitest** — the repo uses Vitest, has tests in another runner (Jest, Mocha), or has no tests at all.

If more than one matches, set up the first in this order and, at the end, tell the user which others UI
Verify could also cover. Don't ask which one, and don't scaffold Storybook into a repo that has none
unless the user asked for Storybook.

What each path captures:

- **Storybook path** — each **story** is a snapshot.
- **Playwright path** — **assembled real pages** (the app, staging, or prod), not isolated components.
  Each test archives its final UI state for UI Verify to replay + diff.
- **Bun path** — visual tests run on `bun test` with `@uiverify/bun`, drive the installed Chrome, and
  archive each test's final page: real pages of the app (`run({ webServer })`) or components on a page
  `serveBundle()` builds. No Node test runner or browser download needed.
- **Vitest path** — component tests in **Vitest browser mode** (`@vitest/browser` with a Playwright
  provider); each browser-mode test archives its final DOM. A repo with no browser-mode tests yet gets
  visual tests in their own config next to its existing tests (Step 2).
- **Screenshot-upload path** — the repo is **native / mobile / React Native** (or otherwise can't
  render in a browser) but already produces finished screenshots from its own harness (Detox, Maestro,
  native snapshot tests). Upload those PNGs directly with `--screenshots`; UI Verify diffs, judges, and
  baselines them with no rendering. There are no stories to author and determinism is owned by your
  capture harness, so Steps 2-3 (client SDK + story authoring) don't apply — install the CLI
  (`npm i -D uiverify`), then jump to Step 4 and wire the CI upload with `--screenshots ./screenshots`
  in place of `--static-dir`. Upload only the screens a PR changed and the rest carry forward.
  **iOS / Swift app with no screenshot harness yet:** use swift-snapshot-testing; the helper, test, run
  command and macOS CI job are in [`references/ios-swift-screenshots.md`](references/ios-swift-screenshots.md).

## Step 2 — install the client

The commands below use npm. Install with the repo's own package manager instead (`pnpm add -D`,
`yarn add -D`, `bun add -d`) and use the same one in CI's install step.

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

**Vitest** — add the plugin to the browser-mode config so every browser-mode test archives its final DOM:
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
When the repo has no Vitest browser-mode tests yet (no tests, tests in Node or jsdom, or tests in another
runner such as Jest):

- The user's existing tests keep passing with their existing command, and that setup is not changed
  beyond excluding the new visual test files if its patterns would pick them up.
- Install `vitest` itself too (the major `@vitest/browser-playwright` expects) and the browser renderer for
  the app's framework (`vitest-browser-react` for React).
- Name the visual tests `*.visual.test.tsx`. They get their own config with the plugin above, whose
  `include` is only that pattern, carrying the app's Vite plugins and path aliases (a repo not built with
  Vite adds its framework's plugin, such as `@vitejs/plugin-react`) but none of its unit-test settings. A
  `test:visual` package script runs them; use it wherever this skill says `npx vitest run`.
- Write a few visual tests so the first build has something to capture. Start with leaf components; for
  whole pages, see "Testing whole pages" in `vitest-visual-testing`.
- If installing the packages would need a different major version of the repo's existing `vitest`, stop and
  ask the user before upgrading.
- Then check that the existing test command still passes.

**Bun** — define a suite, write `*.visual.ts` tests, and a runner that starts the app (full setup and the
component-page variant: `bun-visual-testing`):
```ts
// tests/visual/fixtures.ts
import { DEFAULT_VIEWPORT, defineSuite } from '@uiverify/bun';
export const visualSuite = defineSuite({ viewports: { '': DEFAULT_VIEWPORT } });

// tests/visual/home.visual.ts
import { expect } from '@uiverify/bun';
import { visualSuite } from './fixtures';
const { test } = visualSuite(import.meta.path);
test('home', async (page) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});

// tests/visual/run.ts — run with `bun tests/visual/run.ts`
import { run } from '@uiverify/bun/run';
// The server gets PORT and must listen on it; `ready` (optional) is how its "serving" log line begins.
process.exitCode = await run({ webServer: { command: ['bun', 'server.ts'], port: 3000, ready: 'Listening' } });
```
```bash
bun add -d @uiverify/bun uiverify
```
It needs Bun 1.3.12+ and Google Chrome or Chromium.

## Step 3 — author the first stories the right way

Don't snapshot whatever exists as-is. Author (or refactor) the first few stories using the two
authoring skills, in this order:

1. **`economical-visual-tests`** — collapse variant matrices into gallery/data-driven stories so you snapshot
   the fewest billable shots for full coverage. Do this *before* determinism work — fewer stories is
   less to make deterministic.
2. **`storybook-visual-testing`** (Storybook), **`playwright-visual-testing`** (Playwright),
   **`vitest-visual-testing`** (Vitest), or **`bun-visual-testing`** (Bun) — remove the run-to-run variation the tool can't neutralize from
   outside your app (mostly: the clock, live data, infinite animations).

## Step 4 — wire CI

Add a CI workflow that runs on every PR **and on every push to the default branch. Both triggers are
required; never write a PR-only workflow.** Default-branch builds are the baseline every PR compares
against, and they are what lets a PR render only the stories it touches. Without them every PR sees every
story as new, compares nothing, and renders (and bills) the whole suite. Keep `--auto-accept-changes` on
the upload: the expression below adds it only on the push run, so each merge becomes the baseline without
a second review while PRs still wait for one. Store the project's `UIVERIFY_API_KEY` (a `uv_proj_…` key
from the project's settings, under API key) as a repo secret, then run the `uiverify` CLI (installed in Step 2). Change `[main]`
to whatever your default branch is (`master`, `develop`) — a repo whose default isn't `main` gets a
`push` trigger that never fires.

**Public repo? Write the fork-safe setup instead of the one job below.** GitHub withholds secrets from a
fork's pull request, so the one-job workflow has no key on a fork PR and the check never posts there.
Check before writing any YAML: `gh repo view --json visibility --jq .visibility`. If it prints `PUBLIC`,
write the two workflows in [`references/fork-safe-ci.md`](references/fork-safe-ci.md) (capture with no
key, then upload from a separate `workflow_run` workflow that never runs the PR's code), and tell the user
the follow-ups listed at its end. If you can't tell (no `gh`, not on GitHub), ask the user whether the repo
takes pull requests from forks. Background: https://uiverify.ai/docs/open-source-and-forks

```yaml
# .github/workflows/visual.yml
name: Visual
on:
  push:
    branches: [main]                           # required: your default branch's builds are the baseline
  pull_request:
jobs:
  uiverify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }             # full history so baseline ancestry works
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build-storybook -- --stats-json    # ./storybook-static + the dependency graph
      - run: npx uiverify upload --static-dir storybook-static ${{ github.event_name == 'push' && '--auto-accept-changes' || '' }}
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
        # Whatever you capture, keep the --auto-accept-changes expression at the end of the upload line.
        # Playwright / Vitest instead (browsers aren't preinstalled on the runner): run
        #   "npx playwright install --with-deps && npx playwright test"  (or "npx vitest run", or
        #   "npm run test:visual" when Step 2 added it), then
        #   "npx uiverify upload --static-dir uiverify-archive". Playwright must support the runner's OS (below).
        # Bun instead: add oven-sh/setup-bun@v2, drop setup-node's "cache: npm" and replace "npm ci"
        #   with "bun install --frozen-lockfile" (a Bun repo has no package-lock.json), then run
        #   "bun tests/visual/run.ts" (it drives the runner's preinstalled Chrome) and
        #   "npx uiverify upload --static-dir uiverify-archive". Keep setup-node: the CLI runs on Node 22.12 or later.
        # Screenshot upload (native / mobile / React Native): produce your PNGs (Detox, Maestro, etc.),
        #   then "npx uiverify upload --screenshots ./screenshots" in place of the build+upload steps.
        #   iOS / Swift: "runs-on: macos-15" and the xcodebuild step from references/ios-swift-screenshots.md.
```

Keep `--stats-json` on the build - it is the default, not a tuning step (see "Render only what the PR
could have changed" below). Locally the same thing is:
```bash
npm run build-storybook -- --stats-json && npx uiverify upload --static-dir storybook-static   # signed in (Step 0)
# Playwright:  npx playwright test && npx uiverify upload --static-dir uiverify-archive
# Vitest:      npx playwright install --with-deps && npx vitest run && npx uiverify upload --static-dir uiverify-archive
#              (npm run test:visual in place of npx vitest run when Step 2 added it)
# Bun:         bun tests/visual/run.ts && npx uiverify upload --static-dir uiverify-archive
```

**Playwright / Vitest: Playwright must be new enough for the CI machine's OS.** Each Playwright release
installs browsers only on the OS versions it knows about. When a CI image moves to a newer OS (a floating
label like GitHub's `ubuntu-latest`, a `:latest` Docker base image, a hosted-runner upgrade on GitLab or
CircleCI), an older Playwright fails at `playwright install` with `Playwright does not support chromium on
<os>`, before any capture runs, so no build reaches UI Verify. When wiring CI, read the resolved
`playwright` / `@playwright/test` version from the lockfile and bump it if it predates the runner's OS
(Ubuntu 26.04, for example, needs 1.61+), keeping any `mcr.microsoft.com/playwright` image tag in step.
If the user can't upgrade, pin the CI image to an OS version their Playwright supports. The bump doesn't
move baselines: UI Verify renders every screenshot in its own browser, not the one the tests ran in.

**Optional — run only on PRs that can change the UI.** The workflow above fires on every PR, and a
Playwright archive has no dependency graph of its own, so it renders in full unless you add one (a
Vitest or Storybook upload already renders only what the PR could have changed — see below). On a busy repo, scope the job to
UI-affecting changes. Two ways, and they differ on required checks:

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
      # Keep the upload's ${{ github.event_name == 'push' && '--auto-accept-changes' || '' }} from Step 4,
      # so the post-merge render becomes the baseline.
```

**A missed render is silent — bias to include.** An unnecessary run costs a few CI minutes; a *missed*
one renders nothing, the check passes green, and the unseen change becomes the next baseline every branch
inherits. So list every dir the UI is built from (components, pages, shared UI packages, global CSS) **and
the workflow file itself** — and **don't exclude a mixed folder just because it's mostly backend**: a
`lib/` holding both a `cn()` helper the UI imports and unrelated db/AI code stays in the filter. If that
over-runs, **split the UI-facing code onto its own path, then filter on that** — separate for granularity;
never trade coverage for speed.

**Render only what the PR could have changed — on by default for Storybook and Vitest.** Whenever the
upload carries a dependency graph, UI Verify renders just the stories your commit's changed files could
affect and carries the rest of the baselines forward, so a PR's build time and bill track the size of the
diff, not the size of the suite. It is safe from the first run - when it
can't prove a story is unaffected it renders it, and a first build has nothing to carry, so it renders
everything anyway. Local uploads are safe on the default too: files you haven't committed count as
changed, so what they affect renders.

For **Storybook** the graph comes from the build, and an agent must not drop it: `--stats-json` writes
`preview-stats.json`, the dependency graph the server reads. Without it every story renders, and the
upload log says so on every run. If the repo already has a visual workflow, edit its build and upload
steps in place rather than appending new ones, or the job builds Storybook twice and registers two builds
per PR.

**Vitest** needs no build flag: `@uiverify/vitest` **1.6+** writes the Vite module graph into the archive
on its own, so the plain upload is enough:

```yaml
      - run: npx uiverify upload --static-dir uiverify-archive
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
```

For Vitest the skip is only as granular as your **test files**: the server traces a changed source file to
the tests that *import* it and carries the rest forward, so keep **one page/component per
`*.visual.test.tsx` file** (each importing only what it renders). A file that colocates next to its
component (`SecurityPage.visual.test.tsx` beside `SecurityPage.tsx`) lets a one-component change skip every
other page; a single mega-test that imports half the app re-renders on every commit. A test whose imports
git can't follow (bundler output, as under Angular's unit-test builder, a workspace package's built
`dist/`, gitignored generated code) always renders; the test run prints `[uiverify] The tests in N
file(s) always render: ...` with the reason. It does nothing for the **Playwright** path out of the box - a Playwright
archive has no dependency graph, so every test renders unless you add a `preview-stats.json` to the
archive directory yourself ([module graph format](https://uiverify.ai/docs/skip-unchanged#module-graph-format)).
A **Bun** archive carries no dependency graph either, so every Bun test renders on every build: the path
filter above is how a Bun suite stays off PRs that can't change the UI. Add the visual tests themselves
(`tests/visual/**`) to that filter, or a PR that only edits a test skips its own capture.

Check the Storybook major before you write the build step - the flag is `--stats-json` on Storybook 8+,
but `--webpack-stats-json` on 7.x, and passing the wrong one fails the build step before the upload ever
runs.

## Step 5 — the check gates every PR

Once wired, every PR gets a UI Verify check. The first run on your default branch captures the
baseline; after that each PR is diffed against it, and a real visual regression (or an operational
failure like a broken build or network error) turns the job red. Strict-by-default is intentional: a
silently dropped upload must not leave CI green. If the first few diffs are noisy, don't disable the
check — loop back to the determinism skill (Step 3) to remove the flake at its source.

A job that fails with **`Build … blocked`** rendered nothing: UI Verify paused it at the team's snapshot
allowance or billing check. Tell the user what the log printed about it. Don't re-run the job until the
user has resolved the block the way the log says: until then every re-run is paused too.

## Step 6 — connect your agent so it can see the diffs (MCP)

The check gates the PR; the **MCP** is how your coding agent reviews it without leaving the terminal —
list builds, look at the actual before/after pixels, post them to the PR, accept baselines. Add it as a
real MCP server (Claude Code, Cursor, Codex, …) — don't hand-roll `curl`, or the image tools come back
as blocks a shell can't render. One command for Claude Code, run in the project root:

```sh
claude mcp add --scope project --transport http uiverify https://uiverify.ai/mcp
```

Then restart Claude Code, run `/mcp`, pick `uiverify`, and log in to UI Verify in the browser. That one
login reaches every project in every team the user belongs to, so it is done once, not per project, and
there is no API key in the config: the committed `.mcp.json` holds only the URL and each teammate logs in
with their own account.

Then hand the review loop to **`triage-visual-changes`** (it has the per-client setup and the recipes:
bucket real regressions vs noise, put the before/after in the PR, bulk-accept). On a **passed** build the
agent can still pull any story's current image by id to confirm it looks right.

**Make it stick — install `making-ui-changes` and point your `AGENTS.md` / `CLAUDE.md` at it.** The setup
only pays off if new UI keeps getting captured, and it will only get captured if the agent reads the
discipline on *every* UI change instead of when a human remembers to. So don't leave the customer to
hand-edit `CLAUDE.md` — do it as part of setup: install the **`making-ui-changes`** skill (the playbook
for changing UI safely — reuse before you create, add the story/capture in the same change, check the
blast radius, prove it with a visual test), then add a one-line rule to **both** `AGENTS.md` and
`CLAUDE.md` so every tool (Claude, Codex, Cursor, …) sees it:

```md
## UI changes
- Before changing any component, page, or styles, read the `making-ui-changes` skill and follow it:
  reuse before you create, add/update the story or capture in the same change, check the blast radius on
  shared components, and prove the change with a visual test before calling it done.
- When you start or resume work on a branch, check UI Verify for open review comments on it (`list_comments`
  with the branch over the UI Verify MCP) and address them before continuing.
```

That turns a one-time wiring into a habit the agent follows on every change. If either file already has the
`## UI changes` block but not the review-comments line, add that line to it, so re-running setup updates an
existing install.

## Done when

- A PR shows a UI Verify check with a baseline captured.
- The first build's changed-stories list is empty or all-real (no clock/data/animation flake) — if not,
  loop back to the determinism skill for that path.
- Stories cover the variants without one-story-per-combo explosion (`economical-visual-tests` applied).
