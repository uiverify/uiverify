# UI Verify example: Bun

A runnable example of visual testing on [Bun](https://bun.sh) with [UI Verify](https://uiverify.ai) via the
`@uiverify/bun` SDK. Copy this folder, add your API key, and each visual test becomes a visual regression
check. Docs: [Bun quickstart](https://uiverify.ai/docs/quickstart-bun).

The app is the Shoppy storefront the other examples use, served by Bun itself: `server.ts` is a
`Bun.serve` that bundles `index.html` and its TSX, CSS and fonts, with no Vite and no build step.

## How it works

Your tests run on `bun test` and drive the Chrome you have installed; the SDK archives each state and UI
Verify does the rest **in the cloud**:

1. **Capture** — `tests/visual/run.ts` calls `run()` from `@uiverify/bun/run`, which starts the app
   (`webServer`), runs every `*.visual.ts` in its own `bun test` process, and archives each test's final page
   (serialized DOM + resources) to `uiverify-archive/`. A test that calls `takeSnapshot("name")` archives
   those named snapshots instead.
2. **Upload** — `uiverify upload --static-dir uiverify-archive` sends the archive and streams progress.
3. **Render + diff** — UI Verify replays each capture in a real browser, screenshots it, and diffs it
   pixel-for-pixel against the baseline. ([how it works](https://uiverify.ai/docs/how-visual-testing-works))
4. **Judge** — the [AI judge](https://uiverify.ai/docs/the-ai-judge) triages each change into an intended
   update vs a likely regression.
5. **Gate** — the CLI's exit code reflects the verdict, so CI can block a PR on an unreviewed change.

The tests show both ways to capture:

- **Real pages** — `screens.visual.ts` opens every screen of the running app, at the desktop and mobile
  viewports `fixtures.ts` defines; `flow.visual.ts` drives the shopping flow and snapshots each step after
  the interaction that produced it ([interaction tests](https://uiverify.ai/docs/interaction-tests)).
- **Components in isolation** — `components.visual.ts` uses `serveBundle()` to build and serve a component
  page (`tests/visual/components/index.html`) with no app server, and renders one component scene per test.

Every capture starts from the same pinned state: the page clock, a seeded `Math.random`, finished
animations, UTC, en-US and reduced motion.

## Run it

Needs Bun 1.3.12 or later and Google Chrome or Chromium.

```bash
bun install
bun run test:visual              # starts the app, drives it, archives -> uiverify-archive/
UIVERIFY_API_KEY=uv_proj_… bun run upload
```

`upload` runs `uiverify upload --static-dir uiverify-archive`. Get a project API key
(`uv_proj_…`) from your [UI Verify dashboard](https://uiverify.ai). `bun run dev` serves the app on
<http://localhost:3000> to look at by hand.

## In CI

[`.github/workflows/visual-tests.yml`](.github/workflows/visual-tests.yml) runs the tests and uploads on every
pull request (the check gates the merge — [required checks](https://uiverify.ai/docs/required-checks)) and
on `main` (with `--auto-accept-changes`). It drives the Chrome preinstalled on GitHub's Ubuntu runners.
Capture baselines in CI on Linux, not on a Mac: the two render text differently. Add your key as the
`UIVERIFY_API_KEY` repo secret.

## Use it with your coding agent

UI Verify ships agent skills — runnable playbooks your coding agent (Claude Code, Cursor, Codex, …) uses
to set the whole thing up and triage builds from the terminal. Install once:

```bash
npx skills add uiverify/uiverify
```

Then, in a repo like this one:

- **`/setup-visual-testing`** — detects your capture path, wires the CI, writes first tests.
- **`/bun-visual-testing`** — makes Bun captures deterministic (stops flaky diffs).
- **`/triage-visual-changes`** — reviews a build's changes and drafts the PR summary.

Full list + a copy-in-by-hand alternative: [`packages/skills`](https://github.com/uiverify/uiverify/tree/main/packages/skills).

## The other capture paths

- [`../storybook`](../storybook) — capture Storybook stories (no SDK, `upload --static-dir`)
- [`../vitest`](../vitest) — capture from Vitest browser-mode tests with `@uiverify/vitest`
- [`../playwright`](../playwright) — capture from Playwright end-to-end tests with `@uiverify/playwright`
- [`../react-native`](../react-native) — upload finished screenshots (native / mobile / React Native) with
  `uiverify upload --screenshots`
