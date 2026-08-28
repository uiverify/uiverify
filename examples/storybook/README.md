# UI Verify example: Storybook

A runnable example of visual-testing [Storybook](https://storybook.js.org) stories with
[UI Verify](https://uiverify.ai). Copy this folder, add your API key, and every story becomes a visual
regression check. Docs: [Storybook quickstart](https://uiverify.ai/docs/quickstart-storybook).

The components are a slice of [Shoppy](https://github.com/igrlk/shoppy), UI Verify's example storefront —
a button, product card, quantity stepper, rating, and product art, each with a few stories.

## How it works

You build the static Storybook and upload it with the `uiverify` CLI; UI Verify does the rest **in the
cloud**:

1. **Build** — `build-storybook` emits `storybook-static/` (your stories + their code).
2. **Upload** — `uiverify upload --static-dir storybook-static` sends the bundle and streams render
   progress.
3. **Render + diff** — UI Verify replays each story in a real browser, screenshots it, and diffs it
   pixel-for-pixel against the story's baseline. ([how it works](https://uiverify.ai/docs/how-visual-testing-works))
4. **Judge** — the [AI judge](https://uiverify.ai/docs/the-ai-judge) triages each change into an intended
   update vs a likely regression, so you review a short list, not every pixel.
5. **Gate** — the CLI's exit code reflects the verdict, so CI can block a PR on an unreviewed change.

Because the render is server-side, your CI only needs to *build* the Storybook — no browsers, no
screenshot flakiness on your side. For pixel-stable stories, see
[deterministic captures](https://uiverify.ai/docs/deterministic-captures).

## Run it

```bash
npm install
npm run build-storybook          # -> storybook-static/
UIVERIFY_API_KEY=uv_proj_… npm run upload
```

`upload` runs `uiverify upload --static-dir storybook-static --only-changed`. Get a project API key
(`uv_proj_…`) from your [UI Verify dashboard](https://uiverify.ai).

## In CI

[`.github/workflows/component-tests.yml`](.github/workflows/component-tests.yml) builds the Storybook and uploads it on
every pull request (the check gates the merge — [required checks](https://uiverify.ai/docs/required-checks))
and on `main` (with `--auto-accept-changes`, to move the baseline forward). Add your key as the
`UIVERIFY_API_KEY` repo secret.

## Use it with your coding agent

UI Verify ships agent skills — runnable playbooks your coding agent (Claude Code, Cursor, Codex, …) uses
to set the whole thing up and triage builds from the terminal. Install once:

```bash
npx skills add uiverify/uiverify
```

Then, in a repo like this one:

- **`/setup-visual-testing`** — detects your capture path, wires the CI, writes first stories.
- **`/storybook-visual-testing`** — makes Storybook stories economical and deterministic.
- **`/triage-visual-changes`** — reviews a build's changed stories and drafts the PR summary.

Full list + a copy-in-by-hand alternative: [`packages/skills`](https://github.com/uiverify/uiverify/tree/main/packages/skills).

## The other capture paths

- [`../vitest`](../vitest) — capture from Vitest browser-mode tests with `@uiverify/vitest`
- [`../playwright`](../playwright) — capture from Playwright end-to-end tests with `@uiverify/playwright`
- [`../react-native`](../react-native) — upload finished screenshots (native / mobile / React Native) with
  `uiverify upload --screenshots`
