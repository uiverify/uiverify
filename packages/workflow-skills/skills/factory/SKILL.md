---
name: factory
description: The umbrella "I say what I want, it ships it" loop. Clarifies the ask up front only if genuinely ambiguous, triages the change to decide which phases it actually needs, then implements it and drives it to a merge-ready PR - walking only the phases that apply (design loop for non-trivial changes, always review-loop, e2e-verify only when the change has a runtime surface automated tests can't cover), and stopping mid-way only when it truly needs a decision. Does NOT auto-merge. Use when asked to "ship this", "/factory", "build X end to end", "run the whole loop", "make it and get it green".
argument-hint: <what you want built or fixed>
---

# /factory - say what you want, get a merge-ready PR

The orchestrator for your project's local agentic loop. You give it an intent; it clarifies
anything genuinely unclear, **figures out the smallest correct path for this specific
change**, implements it to the repo's standards, and drives it all the way to a **green,
review-clean PR that's ready for you to merge** - composing the existing skills rather
than reimplementing them. It runs autonomously and **only stops mid-way when it truly
needs something from you.**

This is the whole "software factory" loop for a solo developer, minus the parts
deliberately left out: **no CI reviewer bot** (review runs locally, here), and **no
auto-approve / auto-merge** (the terminal state is "ready to merge" - you click merge).

**Factory is not a fixed pipeline - it's adaptive.** The single biggest failure mode is
running every phase on every change: a one-line `if` in an endpoint, fully covered by
unit tests and invisible to the UI, does not need a design loop *or* an e2e run, and
paying that tax makes the loop something you avoid rather than reach for. So factory
**triages the change and walks only the phases it needs.** The rule of thumb: match the
effort to the change, and never run a gate whose failure mode this change can't hit.

**Execute directly - do not enter plan mode.** Narrate each phase inline as you move
through it, including the ones you *skip* and why (the skip is a decision worth showing).

## Phase 0 - Confirm the ask (only if genuinely ambiguous)

Read what you need to place the change correctly **first**: your conventions doc (e.g.
`CLAUDE.md` / `AGENTS.md`, the root file plus the package's own for the subtree you'll
touch), the relevant architecture/subsystem doc, and any recent decision records (ADRs).
Then decide whether the ask is clear enough to build.

- **Clear enough → proceed.** Do not manufacture questions. A crisp, well-scoped ask
  gets built, not interrogated.
- **Genuinely ambiguous → ask once, in a tight batch.** Product decisions (what the
  behavior should be), a fork with real trade-offs, or anything outward-facing/
  destructive. Ask all of it in one message (`AskUserQuestion` for discrete options),
  fold the answers in, and proceed. Don't drip questions one at a time.

## Phase 1 - Branch

Never build on `main`. If you're on `main`, create a feature branch off it
(`git switch -c <type>/<slug>`). If you're already on a feature branch for this work,
stay on it.

## Phase 2 - Triage (decide which phases this change needs)

Before building, classify the change - this is what makes factory adaptive instead of a
fixed pipeline. Two decisions come out of it; make the first now, and set expectations
for the second (finalize it against the real diff in Phase 6).

**Does this change need a design loop? (Phase 3)**

- **Yes** - it introduces a **new subsystem, table, or data-flow**; it's **cross-cutting**
  (touches several services, or a money/permissions path); it's a **high-volume
  process** where the shape matters more than any one line; or there are **genuinely
  multiple viable approaches** with real trade-offs. These are the changes where a wrong
  approach is expensive to unwind, so it's worth designing first.
- **No** - it's **localized**: one branch/condition, a copy tweak, a contained bug fix, a
  new test, a well-trodden pattern with one obvious placement. Skip straight to implement.

**Will this change need e2e-verify? (Phase 6)** - a provisional read now, confirmed
against the actual diff later. See Phase 6 for the criteria; the point of flagging it
here is so you don't design/implement in a way that makes the eventual verification
harder than it needs to be.

Say out loud what triage decided ("localized fix → skipping design; touches a rendered
component → e2e likely") so the skips are visible, not silent.

## Phase 3 - Design loop (only if Phase 2 said so)

Run [`/design`](../design/SKILL.md) - draft the approach, critique it with the
multi-model panel, and revise to a converged design doc. Then **stop and show it to the
user for a go/no-go before implementing.** This gate is **always-on when design runs**:
a design that looks right but isn't wastes an entire implement cycle, so the
interruption earns itself. Present the approach **in plain English** - what's being
built and why, not the design loop's round counts, trajectory, or internal codes (`/design`
Step 7 is written to this) - plus the key trade-offs and any decision it still needs from
you, each stated as a plain question with a recommended default. Wait for the user's go
(or their redirect) before Phase 4.

Skip this phase entirely for localized changes - do not draft a design doc for a
one-line fix.

## Phase 4 - Implement

Do the work per your project's conventions - minimal, surgical, at the right layer;
search for an existing pattern before adding one; match the two nearest similar files;
never compromise type safety. Colocate tests for the logic you add, exercising real
dependencies per your conventions doc's test rules. As you implement, run the local gate
incrementally so you don't pile up breakage: your local gate (format, lint, typecheck,
test), stopping on the first failure you caused.

Before handing off to review, run the **completeness sweep** from
[the reviewer brief](../review-multi-model/references/reviewer-brief.md) yourself: list
every UI state you added or changed and give each a story (or visual test), give every
behavior change a test you watched fail, and grep for every comment/doc describing what
you changed. The review loop should be confirming completeness, not discovering it one
round at a time.

## Phase 5 - Review-loop (always)

Run [`review-loop`](../review-loop/SKILL.md) over the working tree until it converges (a
pass with no finding that matters, or a reported stop condition). Apply its verified
fixes. Re-run the local gate after fixes land. **This phase always runs** - it's cheap
relative to shipping a defect and catches what unit tests can't.

**Use review-loop's own stop rules - don't override them.** It stops once a round finds
nothing that *matters* (a real bug, or a missing story/test/now-false comment), caps at 5
rounds by default, and applies polish (naming/wording taste, crafted-input hardening)
in-place without another round. Missing stories, tests, and false comments/docs are *not*
polish. Don't push it past that looking for a zero count: zero never arrives, and the long
tail is wording and hand-crafted inputs, not bugs. Out-of-scope findings go on a
follow-up list, not into this PR.

When a run's *matters* findings reveal a defect class the conventions failed to prevent,
feed it to [`/add-rule`](../add-rule/SKILL.md) (or flag it for
[`/evaluate-run`](../evaluate-run/SKILL.md)) so the next change starts from a higher floor.

## Phase 6 - E2E verify (only when the change has a runtime surface tests can't cover)

Now that you can see the **actual diff**, decide whether to run
[`e2e-verify`](../e2e-verify/SKILL.md). Walk these in order:

1. **Touches UI or a user-visible flow** (a component, rendered output, styling, a new
   element, a page interaction) → **run it.**
2. **Backend change whose *effect* is user-visible** (a new entity/field that renders
   differently, a status that changes what the UI shows) → **run it**, to verify the UI
   side.
3. **A big multi-step process** (an ingestion or job pipeline): first ask **"can an
   automated integration test drive this?"** The default is to write that test at the
   service boundary against real dependencies. Only when the path genuinely crosses
   process boundaries a single test can't drive (a CLI → an API → a queue → a worker)
   does e2e-verify become the tool.
4. **Pure internal logic** with unit coverage and no UI/flow effect (the one-line `if`)
   → **skip.** Unit tests + review-loop + CI are enough.

If you run a **visual regression check in CI** (e.g. UI Verify), it diffs the UI at PR
time regardless, so a UI regression is still caught even when local e2e-verify was
skipped - that is what makes skipping local e2e for a non-UI change a scoped decision,
not a gamble. If e2e-verify runs and surfaces a real problem, fix it here.

Say why you skipped when you skip - "no runtime/UI surface, covered by unit tests" - so
the decision is visible.

## Phase 7 - Re-review after E2E fixes

If Phase 6 produced **any** code change, run [`review-loop`](../review-loop/SKILL.md)
again - a fix can introduce a new defect, and this loop's whole premise is that only a
clean *re*-review certifies the diff. If Phase 6 ran nothing or changed nothing, skip.

## Phase 8 - Raise the PR and drive it green

Hand off to [`/babysit-pr`](../babysit-pr/SKILL.md): commit, push, open the PR, and
babysit CI - polling ~every 10 min, reacting to each failure (lint/type/test/e2e and, if
you run a visual check, its diffs - triaged through your visual tool's MCP if it has one,
e.g. UI Verify). `/babysit-pr` does not merge.

## Phase 9 - Converge

Any code change made in Phase 8 (a CI fix, an accepted-vs-fixed visual decision, an answer
that arrived late) **re-enters the loop**: re-run [`review-loop`](../review-loop/SKILL.md)
on the new changes, push, and let `/babysit-pr` re-confirm CI. Keep going until the
fixpoint holds simultaneously:

- **CI is fully green** (every check, including any visual check),
- **review-loop is clean** on the final diff, and
- **the change works end-to-end** (Phase 6 held or was re-confirmed after fixes - or was
  legitimately skipped per its criteria).

**Check this literally, against the log - it is the step most likely to be skipped.**
Before you report convergence, name the SHA of the last commit on the branch and the
review round that covered it. If no reviewer ran *after* that commit, the diff is not
reviewed and you are not converged, no matter how green CI is. A green pipeline proves the
code compiles and passes; it says nothing about the conventions, and it is exactly the
signal that tempts you to call an unreviewed commit done.

**Docs / rollout closeout - a user-visible behavior change owes a docs decision before you
converge.** If the diff added or changed **user-visible product behavior** (a new/changed
feature, a flag default, a CLI/config surface), branch on how it ships:

- **Live for everyone (nothing gating it)** → it owes the user-facing docs for the
  *behavior* and any internal architecture doc for the *mechanism*. Update both, or if no
  page fits, **flag it and offer one** - don't silently ship undocumented.
- **Behind a feature flag / ships dark** → do **not** write user docs yet - they'd
  document behavior nobody can see. Instead record the follow-up somewhere durable and
  committed (a rollout log or an issue: feature, flag name, what's owed when it hits 100% -
  the docs page, the announcement, removing the flag) so the flag-flip doesn't ship
  undocumented.

Surface this as an explicit line at convergence ("live for everyone → owes a docs page,
offering one" / "behind flag X → logged as a rollout follow-up"), never silence. **A docs
edit already in the diff does not automatically discharge the obligation** - a change
often touches several behaviors, and an edit for a minor one is not documentation of the
*headline* one. Name which behavior the convergence line covers.

That's convergence. Stop and report - **the PR is ready for you to merge.** Do not merge
or approve.

## Asking about a decision the work surfaced

Phase 0 batches the questions you can see up front. The expensive ones are the questions
the *work* raises - almost always via a design critique, a review finding ("this removes
the only surface that showed X"), or an e2e observation. For those:

- **Ask at the moment it surfaces, not at the end.** Before the commit, before the push,
  before CI. A question asked during Phase 5 costs nothing; the same question asked after
  CI is green costs a second commit, a second push, a full second CI cycle, and possibly
  a second round of visual-baseline triage, plus a round-trip through the user.
- **Batch and make it answerable.** Use `AskUserQuestion` with discrete options.
  Questions buried as prose in a long status message get partially answered or missed.
- **Ask in plain language, with a default.** A question the user reads is self-contained -
  answerable by someone who never opened the design doc - and free of the loop's internal
  codes (`ASR-N`, `dimension N`, "option B from round 2"). Restate the code as the
  decision it stands for and recommend a default.
- **A review finding you intend to override is itself the trigger.** If a reviewer flags a
  behavior/product consequence and you're about to overrule it on your own reading of the
  ask, that is precisely the fork worth one question. Two reviewers flagging the same
  thing is not a tie you break yourself.
- **Never bundle unrelated work past the point of no return.** If you find something worth
  fixing that isn't the ask (a latent bug, a missing guard), decide *before* committing:
  fold it in and say so in the commit, or leave it for a separate PR. Asking "should this
  be in the PR?" after it's pushed and green isn't a question, it's a chore - the default
  has already shipped.

## When to stop mid-loop (and when NOT to)

**Stop and ask** only for: the **design go/no-go** (Phase 3, always when it runs); a
genuine product/behavior decision the ask didn't settle (see above for *when* - timing
matters more than wording); an outward-facing or destructive/irreversible action needing
confirmation; a blocker you cannot resolve after a real attempt (a missing secret, an
external dependency down); or the same check failing ~3 times with no progress. When you
stop, say exactly what you need and what you've done so far.

**Do NOT stop** for: routine implementation choices, fixable failures, review findings you
can address, or "just checking in." The point of this skill is that it converges on its
own.

## Capturing lessons

When the loop hits a mistake that would generalize - CI or `review-loop` caught something
a rule or lint guard should have prevented - propose capturing it with
[`/add-rule`](../add-rule/SKILL.md) and act on your agreement, exactly as `/babysit-pr`
does. The factory should get smarter each time you run it.
