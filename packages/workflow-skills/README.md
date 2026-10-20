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

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills) &nbsp;·&nbsp; [Workflow skills](https://github.com/uiverify/uiverify/tree/main/packages/workflow-skills)

</div>

---

# @uiverify/workflow-skills

The agentic-development loop that takes a ticket to a merged PR, as agent skills for coding agents (Claude Code, Codex, and others): drop-in workflows they run in **your** repo. Each is a plain `SKILL.md` with no runtime code. They are tool-agnostic and adapt to your stack (each project-specific coupling is marked, fill it in for your repo).

We use this loop to build [UI Verify](https://uiverify.ai), visual testing for coding agents. Where the loop reaches a visual check, it hands off to UI Verify's own skills in the [`uiverify`](../skills) plugin.

## The skills

### Agentic development

The loop that takes a ticket to a merged PR.

| Skill | When your agent runs it |
|---|---|
| **[factory](skills/factory)** | Say what you want; it triages the change, then designs (if non-trivial), implements, reviews, e2e-verifies (if there's a runtime surface), opens the PR, and reacts to CI, all the way to merge-ready. Never auto-merges. Composes the other agentic skills. |
| **[design](skills/design)** | Get a design that survived critique before you build: draft it, have Claude and Codex critique it in parallel against a rubric, then one architect pass verifies each critique and revises, until a clean round. |
| **[review-loop](skills/review-loop)** | Review and fix until the diff is actually clean: a multi-model panel, applied fixes, re-review, until a round finds nothing that matters. Completeness (missing stories, tests, stale comments) is swept in one pass, not dripped out one per round. |
| **[review-multi-model](skills/review-multi-model)** | A second opinion on a diff: Claude and Codex review in parallel, every finding verified against the code, merged into one report. |
| **[e2e-verify](skills/e2e-verify)** | Drive the real app with Playwright before you open a PR, so "done" means it works, not just green unit tests. |
| **[babysit-pr](skills/babysit-pr)** | Open the PR, poll CI, and fix each failure until it's green and ready to merge. Never approves or merges. |

### Tuning the loop

Make the system better at its own job.

| Skill | When your agent runs it |
|---|---|
| **[add-rule](skills/add-rule)** | Turn a correction into a durable rule and, when it's mechanical, a lint guard that goes red next time. |
| **[evaluate-run](skills/evaluate-run)** | Grade a finished run cold: did it follow the process, honor the conventions, write real tests, and capture its corrections? |

## Install

**As a Claude Code plugin** (this repo is a plugin marketplace), so updates arrive automatically:

```sh
/plugin marketplace add uiverify/uiverify
/plugin install uiverify-workflow@uiverify
```

Then invoke a skill by name. The plugin namespaces them under `uiverify-workflow`:

```
/uiverify-workflow:factory
/uiverify-workflow:review-loop
```

**With one command, into any agent** ([skills.sh](https://skills.sh)): `npx skills add uiverify/uiverify --list` and pick the skills you want.

**Or copy the folders** into your agent's skills directory (e.g. `.claude/skills/`) with plain git - nothing extra to install. Copied this way the skills are invoked bare (`/factory`, not `/uiverify-workflow:factory`), which is how the loop skills call each other:

```sh
git clone --depth 1 https://github.com/uiverify/uiverify
cp -r uiverify/packages/workflow-skills/skills/* .claude/skills/   # all of them
rm -rf uiverify
```

**Or grab just one** (swap `factory` for any skill above). Note `factory` and `review-loop` call other skills, so if you grab one of those, grab the ones it composes too:

```sh
git clone --depth 1 https://github.com/uiverify/uiverify
cp -r uiverify/packages/workflow-skills/skills/factory .claude/skills/
rm -rf uiverify
```
