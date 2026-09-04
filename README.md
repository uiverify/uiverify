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
[![@uiverify/vitest](https://img.shields.io/npm/v/@uiverify/vitest?label=%40uiverify%2Fvitest&color=2ea44f)](https://www.npmjs.com/package/@uiverify/vitest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/uiverify/uiverify/blob/main/LICENSE)

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Vitest SDK](https://www.npmjs.com/package/@uiverify/vitest) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills)

</div>

---

## What is UI Verify?

UI Verify is a hosted visual-testing service that plugs into your CI. On each PR it:

1. **Captures** your UI, from Storybook stories, from your existing Playwright or Vitest browser-mode tests via a drop-in capture SDK, or from finished screenshots your own harness already produces (native, mobile, React Native) uploaded straight for diffing.
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

Already have screenshots? If your harness already produces them (Detox, Maestro, native snapshot tests, anything), upload the PNGs directly, no Storybook and no rendering required. UI Verify diffs, judges, and baselines them just the same:

```sh
npx uiverify upload --screenshots ./screenshots
```

This is how native, mobile, and React Native projects use UI Verify: each image is keyed by its path under the directory, so a screen maps to the same baseline every build, and you can upload only the screens you changed and carry the rest forward.

Prefer to drive it from your agent? Install the skills (below) and run `/uiverify:setup-visual-testing`. It detects your capture path, wires CI, and writes the first stories for you.

### Mid-edit checks for coding agents: `uiverify check`

While an agent is editing, it can render just the stories it is touching and diff them against the real CI baseline on the fleet - a "would this pass" answer without waiting for CI:

```sh
npm run build-storybook
npx uiverify check --story 'components-button--*' --static-dir storybook-static
```

It renders only the stories you name (repeatable `--story`, globs or exact ids), posts no PR check, and never moves a CI baseline. A `changed` result is informational (exit 0) - review the pixels over the UI Verify MCP (`get_build` / `render_diff_image`) and accept in the dashboard or with `accept_build` to set a branch-scoped preview baseline, so your own accepted changes stop re-flagging on the next check. CI stays the only path to a `main` baseline.

## Packages

| Package | Install | What it does |
|---|---|---|
| **[`uiverify`](packages/cli)** | `npm i -D uiverify` | The CLI. `uiverify upload` is the CI uploader (Storybook bundle, Playwright/Vitest archive, or a directory of finished screenshots) - streams render progress and reflects the visual verdict in its exit code. `uiverify check` is the agent edit-loop check - renders just the stories you name against the real CI baseline, without posting a check or moving a baseline. |
| **[`@uiverify/playwright`](packages/playwright)** | `npm i -D @uiverify/playwright` | The Playwright capture SDK. Swap `@playwright/test` for it and each test archives its final UI state (serialized DOM + resource bytes) for UI Verify to replay and diff. |
| **[`@uiverify/vitest`](packages/vitest)** | `npm i -D @uiverify/vitest` | The Vitest capture SDK. Add `uiverifyPlugin()` to your Vitest config and each browser-mode test archives its final DOM (serialized DOM + resource bytes) for UI Verify to replay and diff; `takeSnapshot()` adds named checkpoints. |
| **[`@uiverify/skills`](packages/skills)** | `npx skills add`, see below | Agent skills: `SKILL.md` workflows a coding agent runs in your repo to set up visual testing, author economical + deterministic stories, and triage builds. |

### Agent skills

Install the skills into any coding agent with one command ([skills.sh](https://skills.sh)):

```sh
npx skills add uiverify/uiverify
```

Works in Claude Code, Cursor, Codex, Copilot, Gemini, and any agent that reads a skills folder. Add `--list` to pick individual skills, and run `npx skills update` to pull the latest.

Or, on Claude Code, install as a plugin so updates arrive automatically:

```sh
/plugin marketplace add uiverify/uiverify
/plugin install uiverify@uiverify
```

Either way, invoke them by name: `/uiverify:setup-visual-testing`, `/uiverify:triage-visual-changes`, and more. See [`packages/skills`](packages/skills) for the full list and a copy-in-by-hand alternative.

## Triage over MCP

Connect the UI Verify MCP server and your coding agent (Claude Code, Cursor, Codex, and others) can pull a pull request's UI changes into the conversation, look at each diff, read the AI judge's verdict, and accept the intended baselines - without leaving the terminal.

```sh
claude mcp add --scope project --transport http uiverify https://uiverify.ai/api/mcp \
  --header 'Authorization: Bearer ${UIVERIFY_API_KEY}'
```

`--scope project` writes it to your committed `.mcp.json` so the whole team gets it; the key is referenced as the `UIVERIFY_API_KEY` env var, never baked in. Your project setup page has this command with the key filled in. Full guide: [Triage visual changes from your coding agent](https://uiverify.ai/docs/triage-with-your-agent).

The server is remote (streamable HTTP) - there is nothing to install or run. It exposes:

| Tool | What it does |
|---|---|
| `list_builds` | List recent UI Verify builds |
| `get_build` | Get what changed in a build |
| `list_build_stories` | Page through a build's stories by status |
| `get_pr_changeset` | Get what a PR does to the UI vs its base branch |
| `list_pr_stories` | Page through the PR-vs-base changeset by kind |
| `get_diff` | Per-story diff detail with image URLs |
| `render_diff_image` | Fetch the actual pixels of a story image |
| `review_diff` | Accept, deny, or ignore one story's change |
| `accept_build` | Accept every changed story in a build |

## Examples

Complete, runnable projects under [`examples/`](examples) — one per capture path. Copy a folder, add a project API key, and it works.

| Example | Capture path |
|---|---|
| **[`examples/storybook`](examples/storybook)** | Storybook stories (no SDK, `upload --static-dir`) |
| **[`examples/vitest`](examples/vitest)** | Vitest browser-mode tests with `@uiverify/vitest` |
| **[`examples/playwright`](examples/playwright)** | Playwright end-to-end tests with `@uiverify/playwright` |
| **[`examples/react-native`](examples/react-native)** | Finished screenshots (native / mobile / React Native) with `upload --screenshots` |

The first three capture a slice of the same [Shoppy](https://github.com/igrlk/shoppy) storefront; the React Native one is a small Expo app driven by Maestro. Each folder has its own CI workflow.

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
