---
name: review-loop
description: Iterative multi-model review-and-fix loop. Repeatedly runs the review-multi-model panel over the working tree, applies the verified fixes, and re-reviews - review → fix → review → fix - until a pass finds no verified bug or completeness gap (a missing story, test, or a now-false comment/doc) - each round sweeps completeness exhaustively so gaps land in one pass, not one per round. Use when asked to "review-loop", "loop the review", "keep reviewing and fixing until clean", "review until no issues", "iterate review-multi-model until it's clean".
argument-hint: '[pr-number-or-url] [--claude-only] [--codex-only] [--max-iterations N]'
---

# review-loop - iterate review-multi-model until the diff is clean

Run the [review-multi-model](../review-multi-model/SKILL.md) panel in a loop: **review → apply
verified fixes → re-review → fix → …** until a pass finds **nothing that matters**
(defined below). This exists because **a fix can introduce a new defect** - the
review that clears one issue often surfaces another the previous pass couldn't see,
so a single review+fix is rarely a fixpoint.

**Why loops run long, and what prevents it.** Without discipline, rounds past ~4 keep
surfacing real but small gaps **one or two at a time** - a state with no story in round
5, another in round 7, a stale comment in nearly every round. Missing stories and false
comments are real defects (a state with no story is invisible to visual testing). The
failure is the *drip*: reviewers hunt and report what catches their eye, and each fix
creates new states and comments nobody sweeps. So the reviewer brief makes completeness
an **enumerated sweep** (list every state, behavior and affected comment/doc, then check
each), and the fix step below sweeps its own fixes. Gaps should arrive in round 1 in
bulk, not trickle out. Scope creep feeds the loop too: out-of-scope fixes are new
surface each round reviews fresh.

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

## When Codex is down - a second Claude reviewer fills the seat

The panel is Claude + Codex. When Codex is unavailable (usage limit, not logged in), run
a **second independent Claude reviewer** (a fresh agent with its own context, your
strongest model) as the second seat rather than stalling the loop. Two passes with
independent context still catch complementary defects. Say in the report that Codex
didn't run (see review-multi-model's degraded-panel rule).

## What counts as a finding that matters

Classify every verified finding into one of two buckets - this, not the raw count,
drives the loop:

- **Matters (keeps the loop going):**
  - a behavior bug a *real* user, a *real* CI run, or the product's own tooling can hit -
    wrong output, a crash, a stuck/hung state, data loss, a CI break, a wrong
    customer-facing message; a regression a previous round's fix introduced;
  - any security defect where an attacker *gains* something (cross-tenant access, a
    secret, someone else's data);
  - a **completeness gap** - a UI state with no story, a behavior change with no test
    that would fail without it (or a test that claims more than it covers), a comment
    or doc (an internal architecture doc, the user-facing docs, a skill) that the code now
    contradicts.
- **Polish (never keeps the loop going):** naming and wording taste where nothing is
  *false*, duplicated test fixtures, and **inputs someone would have to hand-craft whose
  worst outcome only hurts themselves** (a crafted archive that fails *their own* build,
  a pathological file mode, a 600 MB manifest).

When unsure, ask: *"Would I block the PR on this if a human reviewer raised it?"* If
not, it's polish.

## Stay inside the change

Fix findings that are **in the change the user asked for**. A finding about adjacent
code the branch didn't set out to change - a pre-existing gap, a related subsystem, a
"while we're here" hardening - goes on a **follow-up list** in the final report, not
into the diff. Every out-of-scope fix is new surface the next round reviews fresh, which
is exactly how a loop keeps "finding new things" forever.

## What one iteration is

One iteration = **one complete review-multi-model run with its fixes applied**: its review
phase (compute the working-tree diff → dual reviewers → adjudicate → present)
followed by its fix step (`--fix` - apply the verified, agreed fixes). Follow
the [review-multi-model](../review-multi-model/SKILL.md) skill verbatim each round - do not reimplement the
review; this skill only wraps it in a loop. Every round starts **fresh** (new diff,
new scratch dir, two fresh reviewers), so a regression a fix introduced shows up
next round.

## The loop

Each **iteration** is a review followed - only if needed - by a fix:

1. **Review** (review-multi-model's review phase). Record the verified-finding count,
   whether any consequential **Unverified** items were flagged, whether the full
   requested panel actually ran, and a fingerprint of each finding (see below).
2. **Decide** from that review, before touching code:
   - Nothing that **matters** (zero *matters*-bucket findings, no consequential
     Unverified) → **converged**. Apply any polish findings in-place (they're cheap and
     don't change behavior), run the gate, and stop - **no confirming round for
     polish-only fixes**. Report success.
   - A **no-progress** or **only-un-appliable** stop condition fires → stop, report.
   - Otherwise → go to step 3.
3. **Fix** (review-multi-model's fix step): apply the verified fixes, **then run the
   completeness sweep from [the reviewer brief](../review-multi-model/references/reviewer-brief.md)
   over your own fixes** - a fix that adds a render branch adds its story, a fix that
   changes behavior greps for the comments/docs describing it and updates them, and gets
   a test. Late-round findings are most often the unswept byproducts of the
   previous round's fix. Then begin the next iteration - a fresh review that _confirms_ them. A behavior-changing fix always gets
   a confirming round (a fix to the code path is where the next bug comes from); a
   round whose fixes were all polish does not.

`--max-iterations` bounds the run; **it defaults to 5**. **Convergence is decided by a
review with nothing that matters, never assumed after a behavior fix.** If you reach the cap
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

- **Converged (success):** a review yields **no finding that matters and no
  consequential Unverified items** - polish may remain and is applied in-place without
  another round. This is the goal. If a reviewer failed or was unavailable that round
  (e.g. Codex out of credits), run the second Claude seat (see above) and treat
  that as the full panel - note the degradation in the report, but do **not** keep
  looping or wait for Codex to come back just to get a "real" multi-model pass. An **empty diff** also
  counts as converged: if a round's fixes leave nothing to review (review-multi-model
  reports "nothing to review" - e.g. the fixes reverted the branch to its base), stop
  and report that - there is nothing left to be wrong.
- **Iteration cap (default 5):** a healthy loop converges in 2-4 rounds. Reaching 5
  means either the change is genuinely risky or the loop is chasing polish - stop and
  report which, in plain words, with the open findings and any applied-but-unconfirmed
  fixes. Only go past 5 if the user passed a higher `--max-iterations`, or if round 5
  itself found a *matters* bug (then one more confirming round, and stop).
- **Diminishing returns:** **two consecutive rounds with nothing that matters** - or
  a round whose only *matters* finding is a regression from the previous round's own
  fix, *and* that fix was itself polish or out-of-scope - stop. The loop is now
  generating its own work; revert the out-of-scope fix instead of patching it.
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
- **What matters is the goal, not a zero count.** Keep going while rounds find real
  bugs or completeness gaps; stop the moment they only find polish. Rounds are not free:
  each one costs ~10+ minutes of the user's wall clock, so a round that finds one missing
  story is a sign the sweep was skipped, not that the loop is working.
- **Narrate the value, not just the count.** Each round's progress line says what kind
  of thing it found ("round 2: 1 real bug - a crash on a malformed link; 3 missing
  stories; 2 stale comments"), so the user can see at a glance whether the loop is still earning its time -
  they should never have to interrupt to ask.

## After the loop

Report the trajectory and final state plainly - what each round caught that mattered
(one line each), why it stopped, the polish applied in bulk, and anything left
unresolved, including the out-of-scope follow-up list. If it converged, say the diff is clean per the panel. If it stopped
on the cap or a stuck finding, list what remains open and recommend the next step (a
human decision or a targeted manual fix). Then - only if the user asks - commit the
accumulated fixes.

**Read the trajectory as data about the rules, not just about the diff.** A small change
that took several rounds is telling you which defect classes the conventions currently
fail to prevent - each *matters* finding is one a rule or lint guard could have caught
before the first round ran. End the report by naming the recurring classes and offering
[`add-rule`](../add-rule/SKILL.md) for the ones that generalize.
