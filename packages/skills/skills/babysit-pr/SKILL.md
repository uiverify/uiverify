---
name: babysit-pr
description: Raise a pull request from the current branch and babysit it to green. Opens the PR, then polls CI (~every 10 min) until every check passes, reacting to each failure by reading the logs, fixing locally, and pushing. When a failure exposes a generalizable lesson it proposes capturing it as a rule (via /add-rule). Does NOT approve or merge. Use when asked to "raise a PR", "open a PR and watch it", "push this and monitor CI", "get this PR green".
argument-hint: '[base-branch - defaults to your default branch]'
---

# /babysit-pr - raise a PR and drive it to green

Open a pull request from the current branch, then **babysit it**: poll CI, react to
every failure until all checks pass, and hand back a PR that is green and ready for a
human to merge. This is the tail of the local agentic loop - it does **not** approve
or merge (that's a deliberate human step for this project), and it does **not** run the
code review (that's `review-loop`, run before you get here).

**Execute directly - do not enter plan mode.** Report progress inline as you go.

## Step 0 - Preconditions (get to a pushable branch)

1. **Never open a PR from your default branch.** If `git branch --show-current` is your default
   branch, create a feature branch first (`git switch -c <descriptive-slug>`) - do not rename the current
   branch if it's already a feature branch.
2. **Commit any uncommitted work** relevant to this change with a clear message, per your commit
   conventions. Don't sweep unrelated changes into the commit.
3. **Push** with upstream tracking (`git push -u origin HEAD`).
4. **Run the local gate first** so you don't burn a CI round on something caught locally -
   from the repo root, stop on the first failure: your local gate (format, lint, typecheck, test).
   Fix and re-push before opening the PR. (If you arrived
   here from `/factory`, this already passed - a quick lint + typecheck is enough.)

## Step 1 - Open the PR

Write the title and body from the actual diff (`git diff origin/<default-branch>...HEAD`), not from
memory. Base defaults to your default branch (or the argument). The body is a tight **what + why**, not a
file-by-file restatement - reviewers and CI read it. End the body with a clear commit message per your
commit conventions.

```bash
gh pr create --base <default-branch> --title "<type(scope): summary>" --body "<what + why>"
```

If a PR for this branch already exists (`gh pr view --json number` succeeds), skip creation
and go straight to monitoring - this skill is idempotent, re-running it resumes the babysit.

## Step 2 - The babysit loop (poll ~every 10 min, react to failures)

Watch the checks until they all settle. Prefer a **backgrounded watch** so a long CI run
notifies you on completion instead of blocking (foreground `sleep` is unavailable):

```bash
gh pr checks <n> --watch --fail-fast    # run in the background; it exits when checks settle
```

**A backgrounded watch is a notifier, not a wait.** It hands control straight back, so you still need
exactly one thing that *parks* the run until the notification lands: a `ScheduleWakeup` (~600s) or a
`Monitor` until-loop. Pairing a backgrounded watch with one `ScheduleWakeup` fallback is the correct
shape, not a redundancy - the wakeup is the heartbeat that keeps the loop alive if the watch never
fires. Say so in the reason (`"fallback heartbeat while CI runs; the watch should notify first"`).

**What is actually forbidden is burning tool calls to pass time.** Never emit a no-op (`echo .`,
"still waiting") to fill a turn, and never re-poll `gh pr checks` faster than the CI cadence - ~10
minutes between reactions, not seconds. If you find yourself checking every few seconds, you have no
parking mechanism armed; arm one instead of polling. Concretely: **one** parking mechanism live at a
time, and zero tool calls between arming it and being woken.

When it returns, read the outcome (`gh pr checks <n>`). Three cases:

- **All green →** stop. Report the PR is green and ready for the user to merge (§4). Do not
  merge or approve.
- **Still running after a poll →** re-arm the watch. Cadence is ~10 min between reactions;
  don't hammer `gh` in a tight loop. If the background watch isn't available, use a
  `ScheduleWakeup` / `/loop`-style ~600s tick to re-check rather than a foreground sleep.
- **A check failed →** go to §3, fix it, push, and the watch restarts on the new commit.

**A full CI cycle here is expensive and slow** - and that makes a *second* cycle the most expensive
thing this skill can trigger, so treat "everything I know I need is in this push" as a precondition,
not a nicety: run the full local gate, settle open questions (see `factory`'s guidance on asking about
a decision the work surfaced), and fold in known follow-ups before pushing rather than after CI goes green.

## Step 3 - React to a failed check

Pull the actual failure - never guess from the check name:

```bash
gh run view <run-id> --log-failed          # the failing job's logs
```

- **Lint / typecheck / unit-test failure:** reproduce locally (your local gate),
  fix at the correct layer per the repo conventions, re-run locally to confirm,
  commit, push.
- **Visual regression check (if you run one, e.g. UI Verify):** a changed-snapshot signal, not
  necessarily a bug. **Triage it by invoking your visual tool's triage skill as the action - for UI
  Verify that is the `triage-visual-changes` skill - not by hand-rolling raw review/MCP calls;** the
  skill carries the guardrails that ad-hoc calls skip. Whatever tool you use, hold three disciplines:
  (1) **adjudicate each story baseline-vs-candidate** - look at BOTH the baseline and the candidate
  image and compare, never judge the candidate alone (a change being caused by your diff says nothing
  about whether the result is correct - a global CSS/theme change can quietly break an unrelated page).
  (2) **Triage stops at the pixels** - classify intended vs regression vs flake and attribute the
  change to the diff, but do NOT assert a code-level mechanism (an animation, a race, a specific CSS
  cause) unless you have verified it against the actual element and code; a metric that contradicts
  your proposed mechanism refutes it (a tiny changed-pixel count cannot be a whole-element fade - a
  missing element is a didn't-render problem, not a frozen frame). Root-causing is a separate step.
  (3) If the diff is an **intended** change, accept the baseline so the check clears; if it's a
  **regression you introduced**, fix the code and push. Never blanket-accept to make the check pass -
  that defeats the whole point of the tool.
- **e2e / integration failure:** read the log, reproduce the flow locally (`/e2e-verify` can
  drive it), fix, push.
- **Flaky / infra failure** (a check that failed for reasons unrelated to the diff): re-run it
  (`gh run rerun <run-id> --failed`) once before treating it as real; if it flakes repeatedly,
  say so rather than silently re-running forever.

After any fix: commit, push, and return to §2 - the fresh CI run is what confirms the fix, the
same way `review-loop` only trusts a clean re-review.

## Step 4 - Capture the lesson (propose a rule)

When a CI failure exposed a **generalizable** mistake - something a rule or a lint guard would
have caught before you pushed (an inline route path, a missing `route.test.ts`, an em dash in
shipped copy, a boundary violation) - **propose capturing it** before you finish:

> "CI caught X. That generalizes - want me to `/add-rule` it so the linter/CLAUDE.md catches
> it next time?"

Only act on a **yes** ("adds a rule agreed"). A one-off typo is not a rule; a mistake you (or a
future agent) would plausibly repeat is. Hand the confirmed lesson to the `/add-rule` skill,
which decides the enforcement layer and writes the rule + guard.

## Step 5 - Report

Report the final state plainly: the PR link, the check trajectory (what failed, what you did,
what's green now), any baseline you accepted through the MCP and why, and any rule you proposed.
End with the explicit handoff: **the PR is green and ready for you to merge** - this skill never
merges.

## Guardrails

- **Never approve or merge.** Green + ready-to-merge is the terminal state; the human clicks merge.
- **Never blanket-accept visual baselines** to force a check green - triage each diff and accept
  only genuinely intended changes.
- **Don't loop forever.** If the same check fails across ~3 fix attempts with no progress, stop
  and surface it for a human decision rather than churning CI.
- **Stay on this branch.** Don't switch the user's branch/worktree; commit and push to the branch
  you were invoked on.
