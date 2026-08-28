# UI Verify example: Vitest (browser mode)

A runnable example of visual-testing [Vitest browser-mode](https://vitest.dev/guide/browser/) tests with
[UI Verify](https://uiverify.ai) via the `@uiverify/vitest` SDK. Copy this folder, add your API key, and
each browser-mode test becomes a visual regression check. Docs:
[Vitest quickstart](https://uiverify.ai/docs/quickstart-vitest).

The components are a slice of [Shoppy](https://github.com/igrlk/shoppy), UI Verify's example storefront.

## How it works

Your tests render real components in a real browser and drive an interaction; the SDK archives the result
and UI Verify does the rest **in the cloud**:

1. **Capture** — `uiverifyPlugin()` (in `vitest.uiverify.config.ts`) hooks browser mode; in a test you
   `await takeSnapshot()` after the state you want, and the SDK archives that DOM + its resources to
   `uiverify-archive/`.
2. **Upload** — `uiverify upload --static-dir uiverify-archive` sends the archive and streams progress.
3. **Render + diff** — UI Verify replays each capture in a real browser, screenshots it, and diffs it
   pixel-for-pixel against the baseline. ([how it works](https://uiverify.ai/docs/how-visual-testing-works))
4. **Judge** — the [AI judge](https://uiverify.ai/docs/the-ai-judge) triages each change into an intended
   update vs a likely regression.
5. **Gate** — the CLI's exit code reflects the verdict, so CI can block a PR on an unreviewed change.

Some tests here archive a static state; others drive an interaction first (increment the stepper, toggle
the wishlist heart) so the archived state is post-interaction — see
[interaction tests](https://uiverify.ai/docs/interaction-tests). One note in the config: the
`optimizeDeps.exclude` for `@uiverify/vitest` keeps the SDK's injected browser-setup and your test import
as one module instance, so they share per-test capture state.

## Run it

```bash
npm install
npx playwright install --with-deps chromium
npm run test:uiverify            # renders in Chromium, archives -> uiverify-archive/
UIVERIFY_API_KEY=uv_proj_… npm run upload
```

`upload` runs `uiverify upload --static-dir uiverify-archive --only-changed`. Get a project API key
(`uv_proj_…`) from your [UI Verify dashboard](https://uiverify.ai).

## In CI

[`.github/workflows/component-tests.yml`](.github/workflows/component-tests.yml) runs the tests and uploads on every
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
- **`/vitest-visual-testing`** — makes browser-mode captures economical and deterministic.
- **`/triage-visual-changes`** — reviews a build's changes and drafts the PR summary.

Full list + a copy-in-by-hand alternative: [`packages/skills`](https://github.com/uiverify/uiverify/tree/main/packages/skills).

## The other capture paths

- [`../storybook`](../storybook) — capture Storybook stories (no SDK, `upload --static-dir`)
- [`../playwright`](../playwright) — capture from Playwright end-to-end tests with `@uiverify/playwright`
- [`../react-native`](../react-native) — upload finished screenshots (native / mobile / React Native) with
  `uiverify upload --screenshots`
