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

## What is UI Verify?

UI Verify is a hosted visual-testing service that plugs into your CI. On each PR it:

1. **Captures** your UI, from Storybook stories or from your existing Playwright tests via a drop-in capture SDK.
2. **Renders & diffs** every state in the cloud against the baseline from your default branch.
3. **Reports** the verdict back as a GitHub check, and gates the PR on it.
4. **Triages**: a coding agent (Claude Code, Codex, and others) buckets real regressions vs. cosmetic noise and can accept new baselines in bulk, all over MCP.

This repository holds the open-source client packages, everything that runs in *your* repo. All rendering, diffing, and judging happens server-side; these packages only build a bundle, upload it over HTTP, and read back status, so each is safe to read, fork, and self-host against.

## Quickstart

```sh
# 1. Install the CLI in your project
npm i -D uiverify

# 2. Point it at your account
export UIVERIFY_API_KEY=...        # from uiverify.ai

# 3. Build your Storybook, then upload; the exit code reflects the visual verdict
npm run build-storybook
npx uiverify upload --static-dir storybook-static
```

Prefer to drive it from your agent? Install the skills (below) and run `/uiverify:setup-visual-testing`. It detects your capture path, wires CI, and writes the first stories for you.

## Packages

| Package | Install | What it does |
|---|---|---|
| **[`uiverify`](packages/cli)** | `npm i -D uiverify` | The CI uploader. Uploads your prebuilt Storybook bundle (or a Playwright archive), streams render progress, and reflects the visual verdict in its exit code. |
| **[`@uiverify/playwright`](packages/playwright)** | `npm i -D @uiverify/playwright` | The Playwright capture SDK. Swap `@playwright/test` for it and each test archives its final UI state (serialized DOM + resource bytes) for UI Verify to replay and diff. |
| **[`@uiverify/skills`](packages/skills)** | plugin, see below | Agent skills: `SKILL.md` workflows a coding agent runs in your repo to set up visual testing, author economical + deterministic stories, and triage builds. |

### Agent skills

This repo doubles as a Claude Code plugin marketplace. Install the skills with:

```sh
/plugin marketplace add uiverify/uiverify
/plugin install uiverify@uiverify
```

Then invoke them by name: `/uiverify:setup-visual-testing`, `/uiverify:triage-visual-changes`, and more. See [`packages/skills`](packages/skills) for the full list and a copy-in-by-hand alternative.

## Development

```sh
pnpm install
pnpm -r build        # CLI builds dist/uiverify.js, playwright builds dist/
pnpm -r test
pnpm -r typecheck
```

The CLI requires `UIVERIFY_API_KEY` and talks to `https://uiverify.ai` by default (override with `--api-url` / `UIVERIFY_API_URL` for self-host or local dev). See each package's README and [DEVELOPMENT.md](DEVELOPMENT.md) for internals.

## License

[MIT](LICENSE) © UI Verify
