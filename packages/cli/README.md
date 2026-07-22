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

The CI uploader for UI Verify. `uiverify upload` uploads your prebuilt Storybook bundle, streams render progress (`Rendered X / N`), and reflects the visual verdict (`changed` / `failed`) in its exit code so CI can gate on it.

## Usage

Build your Storybook first, then point `--static-dir` at its output:

```sh
npm run build-storybook
UIVERIFY_API_KEY=... npx uiverify upload --static-dir storybook-static
```

## Options

- `--static-dir <dir>`: the prebuilt Storybook static directory to upload (e.g. `storybook-static`).
- `--working-directory <dir>`: the repo checkout (git metadata + the bundle live here).
- `--api-url <url>`: UI Verify API URL (default `https://uiverify.ai`; or `UIVERIFY_API_URL`).
- `--auto-accept-changes`: accept this build's changed snapshots as the new baseline (no review). Typically used on merges to your default branch.
- `--exit-zero-on-changes`: detect but don't block. A `changed` (needs-review) verdict exits 0 and stays pending review; `failed` still exits non-zero.
- `--strict` / `--no-strict`: whether an operational failure (missing key, missing bundle, network error) fails the job. Strict by default.

## Environment

- `UIVERIFY_API_KEY` (required): your project key. Only ever sent in the `Authorization` header, and redacted from all logs.
- `UIVERIFY_API_URL`: override the default API URL (self-host / local dev).

## License

MIT
