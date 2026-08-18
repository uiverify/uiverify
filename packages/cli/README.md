<div align="center">

<a href="https://uiverify.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://uiverify.ai/brand/logo-mark-dark.png" />
    <img src="https://uiverify.ai/brand/logo-mark-light.png" alt="UI Verify" width="96" height="96" />
  </picture>
</a>

# UI Verify

### Visual testing for agents

Catch unintended UI changes on every pull request. UI Verify renders your components in the cloud, diffs them against a baseline, and lets a coding agent triage what actually changed.

[![uiverify](https://img.shields.io/npm/v/uiverify?label=uiverify&color=2ea44f)](https://www.npmjs.com/package/uiverify)
[![@uiverify/playwright](https://img.shields.io/npm/v/@uiverify/playwright?label=%40uiverify%2Fplaywright&color=2ea44f)](https://www.npmjs.com/package/@uiverify/playwright)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/uiverify/uiverify/blob/main/LICENSE)

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills)

</div>

---

# uiverify

The CI uploader for UI Verify. `uiverify upload` uploads your prebuilt Storybook bundle (or a Playwright/Vitest archive, or a directory of finished screenshots), streams render progress (`Rendered X / N`), and reflects the visual verdict (`changed` / `failed`) in its exit code so CI can gate on it.

## Usage

Build your Storybook first, then point `--static-dir` at its output:

```sh
npm run build-storybook
UIVERIFY_API_KEY=... npx uiverify upload --static-dir storybook-static
```

Or upload finished screenshots your own harness already produced (native, mobile, React Native, anything) with `--screenshots`. No Storybook and no server-side rendering: UI Verify diffs, judges, and baselines the PNGs directly.

```sh
UIVERIFY_API_KEY=... npx uiverify upload --screenshots ./screenshots
```

Each image is keyed by its path under the directory with the extension dropped, so a screen maps to the same baseline every build. Upload only the screens you changed and the rest carry forward (the client is the source of truth for what changed, the same trade-off TurboSnap and Argos make).

## Options

- `--static-dir <dir>`: the prebuilt Storybook static directory to upload (e.g. `storybook-static`).
- `--screenshots <dir>`: a directory of finished PNG/JPG screenshots to upload directly (native / mobile / React Native), instead of `--static-dir`. Skips rendering entirely; images are keyed by their path under the directory.
- `--working-directory <dir>`: the repo checkout (git metadata + the bundle live here).
- `--api-url <url>`: UI Verify API URL (default `https://uiverify.ai`; or `UIVERIFY_API_URL`).
- `--auto-accept-changes`: accept this build's changed snapshots as the new baseline (no review). Typically used on merges to your default branch.
- `--exit-zero-on-changes`: detect but don't block. A `changed` (needs-review) verdict exits 0 and stays pending review; `failed` still exits non-zero.
- `--only-changed`: render only the stories this commit's changed files could affect and carry the rest forward. Opt-in per build; see [Only changed stories](#only-changed-stories) below.
- `--strict` / `--no-strict`: whether an operational failure (missing key, missing bundle, network error) fails the job. Strict by default.

Exit codes: `0` success (or an operational failure under `--no-strict`), `1` the visual verdict or an operational failure under strict, `2` a malformed invocation (unknown option, boolean given a value, stray token). Exit 2 ignores `--no-strict` - that flag means "don't fail my job if the upload breaks", not "run with arguments I didn't mean".

## Only changed stories

`--only-changed` renders just the stories your commit could have affected and carries every other baseline forward at a fraction of a snapshot each, so a one-component PR costs far less than a full suite. It is **Storybook only** - a Playwright archive has no dependency graph, so those uploads always render in full and the flag is ignored. UI Verify works it out server-side from your bundle's Storybook dependency graph, which exists only if you build with `--stats-json`:

```sh
npm run build-storybook -- --stats-json
UIVERIFY_API_KEY=... npx uiverify upload --static-dir storybook-static --only-changed
```

Without that graph there is no fallback: the build renders every story even with the flag on, deliberately, since a filename heuristic can't tell that a page story imports the component you changed.

## Environment

- `UIVERIFY_API_KEY` (required): your project key. Only ever sent in the `Authorization` header, and redacted from all logs.
- `UIVERIFY_API_URL`: override the default API URL (self-host / local dev).

## License

MIT
