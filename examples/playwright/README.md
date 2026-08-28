# UI Verify example: Playwright (end-to-end)

A runnable example of visual-testing [Playwright](https://playwright.dev) end-to-end tests with
[UI Verify](https://uiverify.ai) via the `@uiverify/playwright` SDK. Copy this folder, add your API key,
and each step of your user flow becomes a visual regression check. Docs:
[Playwright quickstart](https://uiverify.ai/docs/quickstart-playwright).

Unlike the [storybook](../storybook) and [vitest](../vitest) examples (which capture components in
isolation), Playwright drives the **whole running app** — so this folder is the full
[Shoppy](https://github.com/igrlk/shoppy) storefront, trimmed to just the Playwright capture path.

## How it works

Your tests drive the real app in a real browser; the SDK archives each state and UI Verify does the rest
**in the cloud**:

1. **Capture** — import `test` from `@uiverify/playwright` (it adds a `uiVerify` fixture); call
   `await uiVerify.snapshot("name")` after the state you want. The SDK archives that DOM + its resources
   to `uiverify-archive/`. `e2e/flow.spec.ts` snapshots each step of the shop flow; `e2e/screens.spec.ts`
   archives every screen at a desktop and a mobile viewport.
2. **Upload** — `uiverify upload --static-dir uiverify-archive` sends the archive and streams progress.
3. **Render + diff** — UI Verify replays each capture in a real browser, screenshots it, and diffs it
   pixel-for-pixel against the baseline. ([how it works](https://uiverify.ai/docs/how-visual-testing-works))
4. **Judge** — the [AI judge](https://uiverify.ai/docs/the-ai-judge) triages each change into an intended
   update vs a likely regression.
5. **Gate** — the CLI's exit code reflects the verdict, so CI can block a PR on an unreviewed change.

Snapshotting *after* an interaction is the key pattern — see
[interaction tests](https://uiverify.ai/docs/interaction-tests). When a test snapshots explicitly, the
SDK skips its end-of-test auto-archive.

## Run it

```bash
npm install
npx playwright install --with-deps chromium
npm run test:e2e                 # starts the dev server, drives it, archives -> uiverify-archive/
UIVERIFY_API_KEY=uv_proj_… npm run upload
```

`upload` runs `uiverify upload --static-dir uiverify-archive --only-changed`. Get a project API key
(`uv_proj_…`) from your [UI Verify dashboard](https://uiverify.ai).

## In CI

[`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) runs the tests and uploads on every
pull request (the check gates the merge — [required checks](https://uiverify.ai/docs/required-checks)) and
on `main` (with `--auto-accept-changes`). Add your key as the `UIVERIFY_API_KEY` repo secret.

## Use it with your coding agent

UI Verify ships agent skills — runnable playbooks your coding agent (Claude Code, Cursor, Codex, …) uses
to set the whole thing up and triage builds from the terminal. Install once:

```bash
npx skills add uiverify/uiverify
```

Then, in a repo like this one:

- **`/setup-visual-testing`** — detects your capture path, wires the CI, writes first tests.
- **`/playwright-visual-testing`** — makes end-to-end captures deterministic (stops flaky diffs).
- **`/triage-visual-changes`** — reviews a build's changes and drafts the PR summary
  ([triage with your agent](https://uiverify.ai/docs/triage-with-your-agent)).

Full list + a copy-in-by-hand alternative: [`packages/skills`](https://github.com/uiverify/uiverify/tree/main/packages/skills).

## The other capture paths

- [`../storybook`](../storybook) — capture Storybook stories (no SDK, `upload --static-dir`)
- [`../vitest`](../vitest) — capture from Vitest browser-mode tests with `@uiverify/vitest`
- [`../react-native`](../react-native) — upload finished screenshots (native / mobile / React Native) with
  `uiverify upload --screenshots`
