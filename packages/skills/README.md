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

Agent skills for UI Verify: drop-in workflows a coding agent (Claude Code, Codex, and others) runs in **your** repo so you set up and operate visual testing the right way. Each is a plain `SKILL.md` with no runtime code. They talk to UI Verify over HTTP (the `uiverify` CLI / `@uiverify/playwright`) and MCP only.

Two of them (`economical-stories`, and the determinism pair) are written to help **any** per-snapshot visual tool, not just UI Verify, so they travel.

## The skills

| Skill | When your agent runs it | Capture path |
|---|---|---|
| **[setup-visual-testing](skills/setup-visual-testing)** | "Add visual testing to this repo". End-to-end onboarding: detect/scaffold the capture path, install the CLI and wire CI, author the first stories the economical + deterministic way. | either |
| **[economical-stories](skills/economical-stories)** | Full visual coverage in the fewest billable snapshots: collapse a variant matrix into one gallery shot, drive states from data. Works with any per-snapshot visual tool. | Storybook |
| **[storybook-visual-testing](skills/storybook-visual-testing)** | Flaky story diffs: make Storybook stories deterministic (only what the capturer can't neutralize for you). | Storybook |
| **[playwright-visual-testing](skills/playwright-visual-testing)** | Flaky real-page diffs: make `@uiverify/playwright` archive-replay captures deterministic (feature flags, live data, the clock, overlays, dynamic layout). | Playwright |
| **[triage-visual-changes](skills/triage-visual-changes)** | A build came back "changed": bucket real regressions vs cosmetic noise, summarize for a PR comment, accept baselines in bulk, all via the UI Verify MCP. | either |

## Install

**As a Claude Code plugin** (recommended, this repo is a plugin marketplace):

```sh
/plugin marketplace add uiverify/uiverify
/plugin install uiverify@uiverify
```

Then invoke a skill by name. The plugin namespaces them under `uiverify`:

```
/uiverify:setup-visual-testing
/uiverify:triage-visual-changes
```

**Or copy the folders** into your agent's skills directory (e.g. `.claude/skills/`), each is self-contained (the package isn't published to npm; grab it from the repo):

```sh
git clone --depth 1 https://github.com/uiverify/uiverify
cp -r uiverify/packages/skills/skills/* .claude/skills/
```
