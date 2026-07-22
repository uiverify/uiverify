---
name: triage-visual-changes
description: Triage a UI Verify build from your coding agent via the UI Verify MCP — bucket a build's changed stories into real regressions vs cosmetic reflow vs rendering noise, summarize the real regressions for a PR comment, and accept baselines in bulk. Use after a UI Verify build reports changes and you want the agent to review, summarize, or accept from the terminal instead of clicking through the dashboard. Triggers: "triage this build", "summarize the visual regressions", "accept all the new baselines".
---

# Triage a UI Verify build from your agent

When a build comes back **changed**, the dashboard shows a triptych per story (baseline / candidate /
diff). This skill does that review from your agent over the **UI Verify MCP** — read what changed, look
at the pixels when a number is ambiguous, then summarize or accept.

## Connect the MCP (once)

The server is a remote Streamable-HTTP MCP at `https://uiverify.ai/api/mcp`, authed with your project's
`vt_live_…` API key as a Bearer token.

```sh
claude mcp add --transport http uiverify https://uiverify.ai/api/mcp \
  --header "Authorization: Bearer $UIVERIFY_API_KEY"
```

Tools it exposes:

| Tool | Does | Key args |
|---|---|---|
| `list_builds` | Recent builds + gate status, to find the one to inspect | `branch?`, `status?`, `limit?` |
| `get_build` | What changed in one build — the gate + `changedStories[]` (each with a `diffResultId` and diff %) | one of `commitSha` / `prNumber` / `buildId` |
| `get_diff` | Per-story diff metrics + image URLs | same selector, optional `storyId` |
| `render_diff_image` | The actual pixels of one story's `baseline` / `candidate` / `diff` | `diffResultId`, `which` |
| `review_diff` | Record a decision on one story | `diffResultId`, `decision: accept \| deny \| ignore` |
| `accept_build` | Accept **every** changed story in a build at once | same selector |

## Recipe 1 — "Triage this build"

Bucket the changes so the human sees signal, not 60 rows. Call `get_build` for the PR, then for any story
whose % delta is ambiguous, call `render_diff_image` (`which: "diff"`) and **look** — a whole-region
shift with no content change is reflow; sub-pixel edge jitter on charts is anti-aliasing noise.

Report in three buckets, with real story names and % deltas:

1. **Real changes** — content actually differs (new text, restyled component, a genuinely new story).
   These need a human eye.
2. **Cosmetic reflow** — real diff pixels, but the diff image shows the *same* content shifted a few px
   (a row moved down ~5px, text ghosted lower). Not a content change.
3. **Rendering noise — safe to accept** — sub-0.4% jitter on chart edges / anti-aliased lines. Pure
   render jitter.

Example output shape:
> **67 changed stories → 3 buckets.**
> **1. New stories (12)** — first baseline, nothing to compare: `Button/AllVariants`, …
> **2. Cosmetic reflow (9)** — real pixels, vertical shift only: `EventStatusCard/All Variants` (4.1%,
> rows shifted ~5px), `TestingInit/Playground` (3.7%), …
> **3. Chart anti-aliasing noise (6)** — sub-0.4% edge jitter, safe to accept: `FunnelChart/Smaller
> Screen` (3.2%), `UpliftChart` (single 1px mark), …

Never accept from inside the triage step — surface the buckets and let the human decide, or do it
explicitly in recipe 3.

## Recipe 2 — "Summarize the visual regressions"

Same read, but output **only bucket 1** in a PR-comment shape — one line per real change, what moved and
where, no noise. This is the comment to drop on the PR:

> 🔎 **Visual review — 2 real changes** (of 67 flagged; 65 reflow/noise, listed below the fold)
> - `Pricing/Card` — CTA button color changed blue→green (12.4%)
> - `Nav/Header` — logo 8px larger (3.1%)

## Recipe 3 — "Accept all the new baselines"

When the changes are all intended (a deliberate restyle) or all noise, advance every changed story's
baseline in one call:

```
accept_build { prNumber: 123 }
```

For a targeted accept (some real, some not), loop `review_diff` per `diffResultId` with
`accept` / `ignore` / `deny` instead — accept the intended ones, ignore the noise, leave real
regressions for a human.

## Guardrails

- **Read before you write.** Always `get_build` (and `render_diff_image` for anything ambiguous) before
  `review_diff` / `accept_build`. Don't accept a build you haven't looked at.
- **Bulk-accept is a baseline change.** `accept_build` makes the candidate the new truth for every
  changed story — only reach for it when you've confirmed there's no real regression hiding in the list.
- **Distinguish "new story" from "changed story."** A first-baseline story has nothing to diff; it's not
  a regression, just needs a baseline. Bucket it separately.
