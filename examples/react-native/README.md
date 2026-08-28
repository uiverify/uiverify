# UI Verify example: React Native (screenshots)

A runnable example of visual-testing a [React Native](https://reactnative.dev) (Expo) app with
[UI Verify](https://uiverify.ai). React Native doesn't render in a browser, so this uses UI Verify's
**screenshot upload** path: your own harness produces finished PNGs and `uiverify upload --screenshots`
sends them straight for diffing — no server-side rendering. Docs:
[screenshot quickstart](https://uiverify.ai/docs/quickstart-screenshot).

The app is a tiny Shoppy storefront (storefront → product → cart) built with React Native primitives.
Product art is solid-color blocks and the status bar is hidden, so every screenshot renders identically
on any device — an honest baseline. ([deterministic captures](https://uiverify.ai/docs/deterministic-captures))

## How it works

This example uses [Maestro](https://maestro.mobile.dev) to drive the app and take the screenshots, but any
producer works (Detox, native snapshot tests, `react-native-view-shot`) — UI Verify only needs the PNGs.

1. **Capture** — `npm run screenshots` runs `maestro test .maestro/flow.yaml` to walk
   storefront → product → cart (each shot taken *after* the interaction that produced it — tappable
   elements carry an `accessibilityLabel` so Maestro can target them), then
   `scripts/collect-screenshots.mjs` copies the shots into `screenshots/` and trims the bottom
   device-chrome band (see the determinism note below).
2. **Upload** — `uiverify upload --screenshots screenshots` sends the PNGs. Each image is keyed by its
   path, so a screen maps to the same baseline every build, and you can upload only the screens you
   changed and carry the rest forward. No rendering happens server-side.
3. **Diff** — UI Verify diffs each PNG pixel-for-pixel against its baseline.
   ([how it works](https://uiverify.ai/docs/how-visual-testing-works))
4. **Judge** — the [AI judge](https://uiverify.ai/docs/the-ai-judge) triages each change into an intended
   update vs a likely regression.
5. **Gate** — the CLI's exit code reflects the verdict, so CI can block a PR on an unreviewed change.

### A note on determinism

A full-screen device capture includes OS chrome whose pixels aren't stable — the status-bar clock, and
the home indicator / gesture bar (it dims a moment after launch). So this example does two things to keep
a screen that *didn't* change byte-identical run to run: it hides the status bar (`<StatusBar hidden />`),
and `collect-screenshots.mjs` trims the bottom chrome band. The app's own art is solid-color blocks (no
photos, no fonts to drift), so the content itself is already deterministic — verified byte-identical
across repeated runs on an iOS simulator. (Skip the trim and UI Verify's AI judge still treats chrome
flicker as cosmetic rather than a regression — but trimming keeps the diffs clean.)

## Run it

You need an iOS simulator or Android emulator and [Maestro](https://maestro.mobile.dev/getting-started/installing-maestro)
installed. Then, with the app running (`npm run ios` / `npm run android`):

```bash
npm install
npm run screenshots              # Maestro drives the app -> screenshots/*.png
UIVERIFY_API_KEY=uv_proj_… npm run upload
```

`upload` runs `uiverify upload --screenshots screenshots --only-changed`. Get a project API key
(`uv_proj_…`) from your [UI Verify dashboard](https://uiverify.ai).

## In CI

[`.github/workflows/screenshots.yml`](.github/workflows/screenshots.yml) builds a debug APK, runs the
Maestro flow on an Android emulator to produce the screenshots, and uploads them on every pull request
(the check gates the merge — [required checks](https://uiverify.ai/docs/required-checks)) and on `main`
(with `--auto-accept-changes`). Add your key as the `UIVERIFY_API_KEY` repo secret.

## Use it with your coding agent

UI Verify ships agent skills — runnable playbooks your coding agent (Claude Code, Cursor, Codex, …) uses
to set the whole thing up and triage builds from the terminal. Install once:

```bash
npx skills add uiverify/uiverify
```

Then, in a repo like this one:

- **`/setup-visual-testing`** — detects your capture path, wires the CI, gets the first shots uploading.
- **`/triage-visual-changes`** — reviews a build's changes and drafts the PR summary
  ([triage with your agent](https://uiverify.ai/docs/triage-with-your-agent)).

Full list + a copy-in-by-hand alternative: [`packages/skills`](https://github.com/uiverify/uiverify/tree/main/packages/skills).

## The other capture paths

- [`../storybook`](../storybook) — capture Storybook stories (no SDK, `upload --static-dir`)
- [`../vitest`](../vitest) — capture from Vitest browser-mode tests with `@uiverify/vitest`
- [`../playwright`](../playwright) — capture from Playwright end-to-end tests with `@uiverify/playwright`
