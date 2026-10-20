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

# @uiverify/skills

Agent skills for coding agents (Claude Code, Codex, and others) that set up and run UI Verify visual testing in **your** repo. Each is a plain `SKILL.md` with no runtime code. They talk to UI Verify over HTTP (the `uiverify` CLI / `@uiverify/playwright` / `@uiverify/vitest`) and MCP only; two of them (`economical-visual-tests` and the determinism pair) help **any** per-snapshot visual tool, so they travel.

Installed as a Claude Code plugin, this also connects the UI Verify MCP server (`https://uiverify.ai/mcp`), so your agent can read builds and diffs after one browser login from `/mcp`.

Looking for the agentic-development loop (`factory`, `review-loop`, `babysit-pr`, ...)? It moved to its own plugin, [`uiverify-workflow`](../workflow-skills).

## The skills

### Visual testing

| Skill | When your agent runs it | Capture path |
|---|---|---|
| **[making-ui-changes](skills/making-ui-changes)** | Before any UI change: reuse before you create, cover every state with a story/capture in the same change, check the blast radius on shared components, and prove the change with a visual test. The entry point wired into your `AGENTS.md` / `CLAUDE.md`. | either |
| **[setup-visual-testing](skills/setup-visual-testing)** | "Add visual testing to this repo". End-to-end onboarding: detect/scaffold the capture path, install the CLI and wire CI, author the first stories the economical + deterministic way. | either |
| **[economical-visual-tests](skills/economical-visual-tests)** | Full visual coverage in the fewest billable snapshots: collapse a variant matrix into one gallery shot, drive states from data. Works with any per-snapshot visual tool. | either |
| **[storybook-visual-testing](skills/storybook-visual-testing)** | Flaky story diffs: make Storybook stories deterministic (only what the capturer can't neutralize for you). | Storybook |
| **[playwright-visual-testing](skills/playwright-visual-testing)** | Flaky real-page diffs: make `@uiverify/playwright` archive-replay captures deterministic (feature flags, live data, the clock, overlays, dynamic layout). | Playwright |
| **[implement-figma-design](skills/implement-figma-design)** | "Build this Figma design": gets the design as a PNG (Figma MCP export, or asks you for one), declares it as the story's baseline, then converges the render to it section by section using UI Verify's diff. Stops without accepting, so the design stays the baseline. | Storybook |
| **[triage-visual-changes](skills/triage-visual-changes)** | A build came back "changed": bucket real regressions vs cosmetic noise, summarize for a PR comment, accept baselines in bulk, all via the UI Verify MCP. | either |

## Install

**With one command, into any agent** ([skills.sh](https://skills.sh)):

```sh
npx skills add uiverify/uiverify
```

Works in Claude Code, Cursor, Codex, Copilot, Gemini, and any agent that reads a skills folder. Add `--list` to pick individual skills, and run `npx skills update` to pull the latest.

**As a Claude Code plugin** (this repo is a plugin marketplace), so updates arrive automatically:

```sh
/plugin marketplace add uiverify/uiverify
/plugin install uiverify@uiverify
```

Then invoke a skill by name. The plugin namespaces them under `uiverify`:

```
/uiverify:setup-visual-testing
/uiverify:triage-visual-changes
```

**Or copy the folders** into your agent's skills directory (e.g. `.claude/skills/`) with plain git - nothing extra to install. Copied this way the skills are invoked bare (`/setup-visual-testing`, not `/uiverify:setup-visual-testing`):

```sh
git clone --depth 1 https://github.com/uiverify/uiverify
cp -r uiverify/packages/skills/skills/* .claude/skills/   # all of them
rm -rf uiverify
```

**Or grab just one** (swap `setup-visual-testing` for any skill above):

```sh
git clone --depth 1 https://github.com/uiverify/uiverify
cp -r uiverify/packages/skills/skills/setup-visual-testing .claude/skills/
rm -rf uiverify
```
