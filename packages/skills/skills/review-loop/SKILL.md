---
name: review-loop
description: Iterative multi-model review-and-fix loop. Repeatedly runs the review-multi-model panel over the working tree, applies the verified fixes, and re-reviews - review → fix → review → fix - until a full pass finds zero verified issues (or a safety cap / no-progress guard stops it). Use when asked to "review-loop", "loop the review", "keep reviewing and fixing until clean", "review until no issues", "iterate review-multi-model until it's clean".
argument-hint: '[pr-number-or-url] [--claude-only] [--codex-only] [--max-iterations N]'
---

# review-loop - iterate review-multi-model until the diff is clean

Run the `review-multi-model` panel in a loop: **review → apply
verified fixes → re-review → fix → …** until a full multi-model pass returns **zero
verified findings**. This exists because **a fix can introduce a new defect** - the
review that clears one issue often surfaces another the previous pass couldn't see,
so a single review+fix is rarely a fixpoint. The loop drives the diff to an actual
fixpoint instead of stopping after one round.

**CRITICAL: Do NOT enter plan mode. Execute directly, iterate, and present the
per-iteration progress and a final convergence summary inline.** Do not write
results anywhere except review-multi-model's own scratch dir.

## It loops over the WORKING TREE only

The loop's whole premise is that **round N re-reviews exactly the code round N-1
just edited.** review-multi-model's fix step (`--fix`) writes to the **working tree**, so
the loop only round-trips fixes when the thing being _reviewed_ is also the working
tree - i.e. review-multi-model's **branch mode** (working tree vs. merge-base).

- **Branch mode (default):** the loop works as designed - each round diffs the
  working tree, so it sees the prior round's fixes.
- **PR argument:** the PR must already be **checked out** (ideally in a worktree) so
  the loop can review-and-fix its working tree. Loop in **branch mode against the
  PR's own base branch** - its merge target (e.g. `release/1.x`), which may not be
  the repo default. Prefix review-multi-model's branch-mode block (in the **same** Bash
  call - shell vars don't persist between calls) with its base override set to that
  branch: `REVIEW_BASE=$(gh pr view <n> --json baseRefName -q .baseRefName) || exit 1`
  - abort if that lookup fails rather than letting the base silently fall back to the
  repo default. Fetch that base fresh once before looping (`git fetch origin
"$REVIEW_BASE"`) so a stale local `origin/<base>` doesn't fold already-merged
  changes into the diff. Do **not** loop on `gh pr diff`: that reflects the _pushed_
  PR, never the local uncommitted fixes (which this loop does not commit), so no round
  could observe its own fixes.
- **`--staged` is not supported** and is not a pass-through flag. review-multi-model fixes
  the working tree without re-staging, so `git diff --staged` would show the
  unchanged index every round and the loop would never converge. For a one-shot
  staged review, run `/review-multi-model --staged` (its `--fix` writes to the working
  tree, so `git add` the result afterward if you want it back in the index).

If the user passes a PR that is not checked out, say so and stop before iteration 1
(`gh pr checkout <n>` first) - do not switch their branch/worktree yourself, and a
fix loop that cannot see its own fixes is pointless anyway. `--claude-only` /
`--codex-only` pass through unchanged; the fix step is always on (it's a fix loop).

## What one iteration is

One iteration = **one complete review-multi-model run with its fixes applied**: its review
phase (compute the working-tree diff → dual reviewers → adjudicate → present)
followed by its fix step (`--fix` - apply the verified, agreed fixes). Follow
the `review-multi-model` skill verbatim each round - do not reimplement the
review; this skill only wraps it in a loop. Every round starts **fresh** (new diff,
new scratch dir, two fresh reviewers), so a regression a fix introduced shows up
next round.

## The loop

Each **iteration** is a review followed - only if needed - by a fix:

1. **Review** (review-multi-model's review phase). Record the verified-finding count,
   whether any consequential **Unverified** items were flagged, whether the full
   requested panel actually ran, and a fingerprint of each finding (see below).
2. **Decide** from that review, before touching code:
   - Clean (zero verified findings, no consequential Unverified, full panel ran) →
     **converged**, stop and report success.
   - A **no-progress** or **only-un-appliable** stop condition fires → stop, report.
   - Otherwise → go to step 3.
3. **Fix** (review-multi-model's fix step): apply the verified fixes, then begin the next
   iteration - a fresh review that _confirms_ them. A clean confirming review is the
   only thing that lets you call the diff clean; a fix on its own never does.

`--max-iterations` bounds the run when you pass it; it is unset by default. **Convergence is
always decided by a clean review, never assumed after a fix.** If you reach the cap
and the last review still had findings, you will have applied that round's fixes
without a further review to confirm them - report those as **applied but
unconfirmed**, list the findings open as of the last review, and suggest re-running
with a higher `--max-iterations` to confirm.

## Finding fingerprint (for the no-progress guard)

Fingerprint a finding by **the defect and where it lives** - the file plus the
specific construct/region it points at (or the thing a fix would change) - matched
**semantically**. Two findings are "the same" if they describe the same defect in
the same place, even if the two rounds **word it differently** ("missing null
guard" vs. "nullable value dereferenced") or the **line number drifted** because
edits above it shifted the file. Do not match on exact wording or line number - that
lets one persistent defect masquerade as a new one and churn to the cap.

## Stop conditions (stop at the FIRST that holds)

- **Converged (success):** a review yields **zero verified findings and no
  consequential Unverified items**, _and the full requested panel actually ran that
  round_ - the diff reached a fixpoint. This is the goal. If a reviewer failed or was
  unavailable that round (e.g. review-multi-model fell back to Claude-only because Codex
  died), do **not** call it a clean multi-model pass: note the degradation and retry
  the round with the full panel before claiming convergence. An **empty diff** also
  counts as converged: if a round's fixes leave nothing to review (review-multi-model
  reports "nothing to review" - e.g. the fixes reverted the branch to its base), stop
  and report that - there is nothing left to be wrong.
- **Iteration cap:** `--max-iterations` bounds the run, but it is **unset by default** -
  rounds keep going while they keep finding real defects, per "a clean pass is the goal"
  above. Pass it explicitly to bound an exploratory run. If a cap is set and reached
  without a clean review, stop and report as above - the findings open as of the last
  review, plus any applied-but-unconfirmed last-round fixes.
- **No progress / oscillation:** keep a **cumulative** record across all rounds - for
  each finding fingerprint, which rounds reported it and which rounds you applied a
  fix for it. Two things stop the loop:
  - **Stagnation** - a finding you have **already applied a fix for** keeps getting
    reported in later rounds (the fix isn't resolving it). New findings appearing is
    fine and is progress - but a _specific defect that a fix has failed to clear
    across two-plus rounds_ is stuck; stop and flag that one, even if other findings
    are moving. (This is keyed on _fix-attempted-but-still-present_, so a steadily
    growing pile `{A}→{A,B}→{A,B,C}` where the fixes for A, B never take **does** trip
    it - A alone stalls the loop.)
  - **Oscillation** - a finding you applied a fix for **disappeared and then
    reappeared** in a later round. Because the reviewers are non-deterministic, key
    this on _fixed-then-returned_, not mere absence (a finding missed in one pass and
    re-found later was never fixed - that's not oscillation, keep going). A genuine
    fixed→gone→back flip-flop means two fixes are fighting; stop and flag it.

  Report the stuck or flip-flopping finding(s) so the user can break the cycle.

- **Only un-appliable findings remain:** if the sole survivors are ones review-multi-model's
  fix step deliberately **skipped** (low-confidence, or needing a human decision) or
  are consequential **Unverified** items, stop - re-running the identical review will
  keep skipping them. List them for the user.

Never loop forever. If you are unsure whether the set is shrinking, err toward
stopping and reporting - a human deciding on 2 residual findings beats an agent
burning tokens on an infinite churn.

## Guardrails

- **Working tree only, no commits.** The loop mutates the working tree via
  review-multi-model's fix step; it does **not** commit, push, or open a PR unless the user
  asks after it converges.
- **Verify each fix stuck.** Because the next round re-reviews from a fresh
  working-tree diff, a fix that didn't land (or broke something) reappears as a
  finding - that is the safety net. Never hand-wave "fixed" without the follow-up
  review confirming it.
- **A clean pass is the goal - the cap is a safety valve, not a budget.** The iteration
  cap and the no-progress guard exist to stop *pathology* (a fix that won't take, an
  oscillating finding), not to license stopping while rounds are still finding real
  defects. Rounds are cheap relative to shipping the defect that round 4 would have
  caught, so keep going while findings keep landing, however small the diff. Never stop
  on a round in which you applied a fix.

## After the loop

Report the trajectory and final state plainly - the per-round `found / fixed` counts
(e.g. `iter1: 9/8 → iter2: 5/5 → iter3: 0 → clean`), why it stopped, and anything
left unresolved. If it converged, say the diff is clean per the panel. If it stopped
on the cap or a stuck finding, list what remains open and recommend the next step (a
human decision or a targeted manual fix). Then - only if the user asks - commit the
accumulated fixes.

**Read the trajectory as data about the rules, not just about the diff.** A small change
that took several rounds is telling you which defect classes the conventions currently
fail to prevent - each finding is one a rule or lint guard could have caught before the
first round ran. That makes a long run the most informative one you'll have, so end the
report by naming the recurring classes and offering `add-rule`
for the ones that generalize. Round counts should fall over time because the environment
improved, never because the loop stopped looking.
