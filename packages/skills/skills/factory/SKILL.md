---
name: factory
description: The umbrella "I say what I want, it ships it" loop. Clarifies the ask up front only if genuinely ambiguous, then implements it and drives it to a merge-ready PR - running the full local agentic loop (implement → review-loop → e2e-verify → review-loop → raise PR → monitor CI incl. visual → fix → re-review → converge) and stopping mid-way only when it truly needs a decision. Does NOT auto-merge. Use when asked to "ship this", "/factory", "build X end to end", "run the whole loop", "make it and get it green".
argument-hint: <what you want built or fixed>
---

# /factory - say what you want, get a merge-ready PR

The orchestrator for your project's local agentic loop. You give it an intent; it clarifies
anything genuinely unclear, implements it to the repo's standards, and drives it all the way
to a **green, review-clean, end-to-end-verified PR that's ready for you to merge** - composing
the existing skills rather than reimplementing them. It runs autonomously and **only stops
mid-way when it truly needs something from you.**

This is the whole "software factory" loop for a solo developer, minus the parts deliberately
left out: **no CI reviewer bot** (review runs locally, here), and **no auto-approve / auto-merge**
(the terminal state is "ready to merge" - you click merge).

**Execute directly - do not enter plan mode.** Narrate each phase inline as you move through it.

## Phase 0 - Confirm the ask (only if genuinely ambiguous)

Read what you need to place the change correctly **first**: your conventions doc, e.g. CLAUDE.md / AGENTS.md, the relevant subsystem doc, and the conventions doc for the subtree you'll touch (the root file plus
the package's own). Then decide whether the ask is clear enough to build.

- **Clear enough → proceed.** Do not manufacture questions. A crisp, well-scoped ask gets built,
  not interrogated.
- **Genuinely ambiguous → ask once, in a tight batch.** Product decisions (what the behavior
  should be), a fork with real trade-offs, or anything outward-facing/destructive. Ask all of it
  in one message (use `AskUserQuestion` for discrete options), fold the answers in, and proceed.
  Don't drip questions one at a time.

After this phase you should not need to stop again unless the work *surfaces* a genuine decision.
When it does, see **"Asking about a decision the work surfaced"** below - the timing of that ask is
the single most expensive thing to get wrong in this loop.

## Phase 1 - Branch

Never build on `main`. If you're on `main`, create a feature branch off it
(`git switch -c <type>/<slug>`). If you're already on a feature branch for this work, stay on it.

## Phase 2 - Implement

Do the work per your project's conventions - minimal, surgical, at the right layer; search for an
existing pattern before adding one; match the two nearest similar files; never compromise type
safety. Colocate tests for the logic you add, exercising real dependencies per your
conventions doc's test rules. As you implement, run the local gate incrementally so you don't pile up
breakage: your local gate (format, lint, typecheck, test), stopping on the first
failure you caused.

## Phase 3 - Review-loop

Run `review-loop` over the working tree until it converges (a clean
multi-model pass, or a reported stop condition). Apply its verified fixes. Re-run the local gate
after fixes land.

**Do not cap the rounds, and do not budget them against the diff's size.** Keep going while rounds
are still finding real defects - a small diff that needs six rounds needs six rounds, and stopping
early to save wall clock just ships the defects rounds 3-6 would have caught. The loop ends on one
condition only: **a clean confirming round.** A fix is never the last word; `review-loop` exists
precisely because the fix that clears one finding is the one that introduces the next.

**A high round count is a signal to mine, not a cost to suppress.** Every round that finds something
on a small change is telling you a rule or a guard was missing - that's the defect class the
conventions failed to prevent, and it will recur on the next change until it's captured. So when a
run takes an unusual number of rounds, that's the *most* valuable run you'll have: note what each
round found, and when you finish, feed it to `/add-rule` (or flag it for
`/evaluate-run`) so the next change starts from a higher floor. The goal is for
round counts to fall over time because the environment got better - never because the loop was told
to stop looking.

Wall clock is worth optimizing everywhere *except* here. Reviewing is the part that earns its time;
spend it, and take it out of the CI cycles and the polling instead.

## Phase 4 - E2E verify (locally)

Run `e2e-verify` to drive the change through the real dev stack with
Playwright - the change actually working in the product, not just green unit tests. If it surfaces
a real problem, fix it here.

## Phase 5 - Re-review after E2E fixes

If Phase 4 produced **any** code change, run `review-loop` again - a fix
can introduce a new defect, and this loop's whole premise is that only a clean *re*-review certifies
the diff. If Phase 4 changed nothing, skip.

## Phase 6 - Raise the PR and drive it green

Hand off to `/babysit-pr`: commit, push, open the PR, and babysit CI - polling ~every
10 min, reacting to each failure (lint/type/test/e2e and, if you run a visual check, its diffs - triaged
through your visual tool's MCP if it has one, e.g. UI Verify). `/babysit-pr` does not merge.

## Phase 7 - Converge

Any code change made in Phase 6 (a CI fix, an accepted-vs-fixed visual decision, an answer that
arrived late) **re-enters the loop**: re-run `review-loop` on the new
changes, push, and let `/babysit-pr` re-confirm CI. Keep going until the fixpoint holds simultaneously:

- **CI is fully green** (every check, including any visual check),
- **review-loop is clean** on the final diff, and
- **the change works end-to-end** (Phase 4 held, or was re-confirmed after fixes).

**Check this literally, against the log - it is the step most likely to be skipped.** Before you
report convergence, name the SHA of the last commit on the branch and the review round that covered
it. If no reviewer ran *after* that commit, the diff is not reviewed and you are not converged, no
matter how green CI is. A green pipeline proves the code compiles and passes; it says nothing about
the conventions, and it is exactly the signal that tempts you to call an unreviewed commit done.

That's convergence. Stop and report - **the PR is ready for you to merge.** Do not merge or approve.

## Asking about a decision the work surfaced

Phase 0 batches the questions you can see up front. The expensive ones are the questions the *work*
raises - almost always via a review finding ("this removes the only surface that showed X") or an
e2e observation. For those:

- **Ask at the moment it surfaces, not at the end.** Before the commit, before the push, before CI.
  A question asked during Phase 3 costs nothing; the same question asked after CI is green costs a
  second commit, a second push, a full second CI cycle, and a second round of visual-baseline
  triage - a full CI cycle is expensive, plus a round-trip through the user.
- **Batch and make it answerable.** Use `AskUserQuestion` with discrete options. Questions buried as
  prose bullets in a long status message get partially answered or missed entirely; a decision you
  need is not a footnote.
- **A review finding you intend to override is itself the trigger.** If a reviewer flags a
  behavior/product consequence and you're about to overrule it on your own reading of the ask, that
  is precisely the fork worth one question. Two reviewers flagging the same thing is not a tie you
  break yourself.
- **Never bundle unrelated work past the point of no return.** If you find something worth fixing
  that isn't the ask (a latent bug, a missing guard), decide *before* committing: fold it in and say
  so in the commit, or leave it for `split-pr`. Asking "should this be in
  the PR?" after it's pushed and green isn't a question, it's a chore - the default has already
  shipped.

## When to stop mid-loop (and when NOT to)

**Stop and ask** only for: a genuine product/behavior decision the ask didn't settle (see the
section above for *when* - the timing matters more than the wording); an
outward-facing or destructive/irreversible action needing confirmation (per the harness rules); a
blocker you cannot resolve after a real attempt (a missing secret, an external dependency down, a
test that's failing for reasons you can't reach); or the same check failing ~3 times with no
progress. When you stop, say exactly what you need and what you've done so far.

**Do NOT stop** for: routine implementation choices, fixable failures, review findings you can
address, or "just checking in." The point of this skill is that it converges on its own.

## Capturing lessons

When the loop hits a mistake that would generalize - CI or `review-loop` caught something a rule or
lint guard should have prevented - propose capturing it with `/add-rule` and
act on your agreement, exactly as `/babysit-pr` does. The factory should get smarter each time you run it.
