---
name: evaluate-run
description: Grade a completed factory run (a worktree + its chat) against your standards, cold and adversarially, so the system learns. Squashes the session transcript into a compact digest (prompts + corrections, the ordered tool timeline, the diff), then a fresh evaluator judges how the run went - did it follow the loop, honor your conventions, write real tests, ask at the right moments, handle corrections - and routes every finding to a durable fix (/add-rule for code, a persistent memory for process). This is the OFFLINE complement to the correction hook: the hook catches what you notice live, this catches what you didn't. Use for "evaluate this factory run", "grade this chat", "how did that go, what should it learn".
argument-hint: '[worktree dir | transcript.jsonl - defaults to the current worktree/chat]'
---

# /evaluate-run - grade a factory run, feed the lessons back

You ran `/factory` (or did a complex task by hand) and it converged on a green PR. Green is not the
same as *good*: it can pass CI while bending a convention, mocking a test into meaninglessness,
cutting a corner you didn't notice, or repeating a mistake you already corrected. This skill judges
the run **cold** - from a compressed digest + the real diff, not the agent's own self-narration - and
turns what it finds into durable improvements so the next run is better.

**Execute directly - do not enter plan mode.** Read-only w.r.t. the code under evaluation; the only
things it may write (on your yes) are rules/guards/memories via the routing in the last step.

## Step 1 - Resolve the target and squash it

The argument is the worktree (default: the current one) or an explicit `transcript.jsonl`. Produce a
compact digest of the session (how you export and compress a transcript depends on your harness).

The digest is compact markdown - **prompts (with corrections flagged ⚠️), the diff, and the
ordered tool timeline** - compressing a multi-hundred-KB transcript to a few KB. Read it. Also pull the
real diff for the evaluator to check against (`git diff origin/<default-branch>...HEAD` in that worktree, plus any
uncommitted/untracked). The digest tells you *what happened*; the diff is *ground truth* for whether it
was done right.

> Evaluating the **current** chat is fine, but the digest won't include the in-flight turn. For a clean
> read, evaluate a run that has come to rest (converged, or stopped).

## Step 2 - Judge cold, in a fresh evaluator (a separate context)

Spawn a **fresh subagent** as the evaluator and hand it the digest + the diff. A cold
context is the point - the doer rationalizes its own choices; the evaluator must not inherit them. For a
**thorough** pass, fan out one evaluator per rubric group in parallel and merge; for a quick read, one
evaluator covering all groups is enough. Instruct the evaluator to **open the actual changed files and
verify claims against the code and your conventions docs** - never grade from the digest's summary alone.

### The rubric (score each: ✅ pass / ⚠️ warn / ❌ fail, with `file:line` or digest evidence)

1. **Followed the loop.** implement → `review-loop` → `e2e-verify` → `review-loop` → `/babysit-pr` → converge.
   Which steps ran, which were skipped, and did skipping any matter (e.g. shipped without an e2e drive,
   called a green CI "done" without a clean re-review)?
2. **Honored the conventions** (your conventions docs): type
   safety (no `as`/`any`/`!`/`@ts-ignore`), minimal surgical change at the right layer, searched-before-
   creating (no near-duplicate of an existing util), comments-default-to-none, the perf/batching rule on
   hot paths, project-specific conventions. Flag anything the guards/reviewers *didn't* catch.
3. **Tests are real.** DB-backed where your rules require it (no mocking the thing under test into a
   tautology; exercises the change against real dependencies); the test actually exercises the change
   and would fail without it - not a tautology or a snapshot of fixtures.
4. **Judgment: ask vs proceed.** Did it stop for a genuine decision and *not* stop for trivia? Over-ask
   (interrogated a clear ask) or under-ask (guessed on a real fork and built the wrong thing)?
5. **Corrections handled.** Identify corrections **semantically** - the digest pre-tags the obvious
   ones ⚠️, but that's a regex hint; you read the prompts, so also count the calmly-phrased redirects
   it missed ("use X instead of Y", "make it Z"). For each: did the run (a) fix the instance and (b)
   capture it durably (a rule/guard or a memory)? Did it repeat a mistake it was already corrected on?
   An uncaptured correction is a process failure even if the instance was fixed.
6. **Verification was honest.** It actually ran your gate (format/lint/typecheck/test) and reported
   truthfully - no "done" without evidence, no claimed-passing that the diff contradicts.
7. **Efficiency.** Thrash, re-reading the same file, redundant tool calls, or a subagent that could have
   parallelized - cheap signal, low weight.

The evaluator returns: a per-dimension score with evidence, the **top 3-5 issues ranked by severity**,
and for each a **proposed durable fix** tagged `RULE` (mechanizable/code convention) or `PROCESS`
(how-you-work). Bias toward specific, evidenced findings over vague ones; "this looked fine" is not a
finding.

## Step 3 - Present the report and route the lessons

Merge the evaluator output into one report for the user: the scorecard, the ranked issues with
evidence, and the proposed durable fixes. Then **route each accepted lesson** (act only on the user's
yes, exactly as `/add-rule` requires):

- **`RULE` findings** → hand to `/add-rule`: a conventions-doc rule + a lint guard when
  mechanizable. A convention the run broke that a guard could have caught is the highest-value output of
  the whole exercise - it converts a one-time miss into a permanent floor.
- **`PROCESS` findings** → a persistent **memory** (with the why + how-to-apply), and the root
  conventions doc if it's repo-wide.

End with the one number that matters over time: **how many corrections/new-rules this run produced.** The
whole thesis is that this trends *down* run over run as the environment absorbs the lessons - track it,
call it out, and note whether this run beat the last.

## Guardrails

- **Cold and adversarial.** Judge from the diff + digest, not the agent's self-praise. If the evaluator
  finds nothing, say so plainly - don't manufacture issues to look thorough. A genuinely clean run is the
  goal, and it *should* happen more as the system learns.
- **Read-only on the code under review.** The only writes are the routed rules/guards/memories, on the
  user's yes.
- **Don't re-litigate green CI.** CI already proved it compiles and passes. Your job is the quality CI
  can't see: conventions, test integrity, judgment, and whether corrections stuck.
