# Synthesis, revision & convergence (the principal architect)

You (the orchestrator) are the **principal architect**. The critics are advisors; you
decide what is real, and - unlike code review, where you merge findings and stop -
here you own the artifact: you verify the critiques, then **you revise the design**,
and you may issue a full **rewrite mandate** when the approach itself is wrong rather
than patch around it. This asymmetry is deliberate: the strongest measured
design-critique topology routes through a single synthesizing architect with rewrite
authority, not a merge of parallel critiques.

## Why the architect, not a merge

Naive parallel-merge - take every critic's list, dedupe, hand it back - is the
*weakest* design topology in the evidence. Two reasons it fails for design where it's
fine for code review: (1) a diff is local, so merged findings compose; a design is a
whole, so ten locally-reasonable patches can add up to an incoherent design. (2)
Critics disagree on *direction*, not just presence - one says "split this service",
another "keep it monolithic but add a queue". A merge can't resolve a direction
conflict; an architect must **pick one and say why**.

## Step 1 - Verify every critique (the false-positive killer)

For every critique from every critic:

1. **Fuzzy-match the `Quote:` against the design doc.** If the quoted span isn't
   actually in the doc (paraphrased, invented, or from an old version), drop the
   critique - a critic objecting to words the design doesn't contain is hallucinating.
2. **Check the anchor.** It must tie to a rubric dimension or a Step-1 ASR. A critique
   anchored to neither is taste - drop it.
3. **Judge the consequence against the real code.** Open what the design touches and
   confirm the named failure actually follows. Quote-match proves the critic is talking
   about something in the doc; it does **not** prove the objection is right. Drop
   critiques that misread the system, are already handled by the design elsewhere, or
   name no concrete consequence.

Keep only critiques that survive all three. A plausible-but-unconfirmable concern that
is both consequential and cheap for a human to weigh goes under a separate
**"Judgment calls"** section of the report - it does not count as a blocking concern
and does not gate convergence.

## Step 2 - Merge & resolve direction

- **Dedupe** by rubric dimension + root concern (the same underlying weakness), not by
  exact quote - two critics often quote adjacent spans for one problem. Both raised it
  → tag `[both]`; single-source → `[claude]` / `[codex]`.
- **Do not drop a verified concern just because one critic found it** - the
  complementary catches are frequently the highest-value ones.
- **Resolve direction conflicts yourself.** When critics point opposite ways, pick the
  direction that best satisfies the ASRs and the rubric, and **record the rejected
  option and why** in the design's Alternatives section (dimension 12). An unresolved
  fork is not a finding to hand back - it's a decision you owe.

## Step 3 - Revise (or mandate a rewrite)

- **Patch** when the approach is sound and the concerns are local - apply the smallest
  change per verified concern, and re-derive coherence (a fix for one dimension can
  break another).
- **Rewrite mandate** when a BLOCKER means the *approach* is wrong (fails an ASR at its
  core, violates an invariant structurally, wrong layer for the whole feature). Say so
  explicitly - "REWRITE: a synchronous request-path write can't satisfy ASR-3; redraft
  around a queued job" - and redraft the section (or the whole design) rather
  than bolting a caveat onto a design that shouldn't survive.

Write the revised design back to the same doc so the next round critiques exactly what
you just changed.

## Panel-bias guardrails (do this, it's not optional)

Design judging is *more* bias-prone than code review because there's no diff to check
against. Concretely:

- **Author ≠ its own judge.** The model that drafted a section carries self-preference
  bias toward it. Keep the drafting model out of the critic seat for its own work where
  you can; at minimum, weight a critic's objection to a rival model's design higher than
  its praise of its own.
- **Never average scores.** A single biased critic makes a mean-aggregated verdict
  arbitrarily wrong. Judge **per dimension, forced-choice** (sound / concern /
  blocker), and let one verified BLOCKER gate regardless of how many critics liked the
  rest.
- **Neutralize length & order.** Randomize which critic you read first; don't reward a
  longer critique for being longer. Judge the objection, not its verbosity.

## Convergence - when the loop stops

The loop is **draft → critique → verify → revise → re-critique**. It stops at the FIRST
that holds:

- **Converged (success):** a round raises **zero verified
  BLOCKER/MAJOR concerns** (MINORs and Judgment-calls may remain) *and both critic seats
  ran that round*. This is the goal - the design reached a fixpoint. If Codex was
  unavailable, a second independent Claude critic in its seat counts: note the
  degradation, but don't retry the round or wait for Codex before declaring convergence.
- **Round cap:** converge-when-clean, but **cap at 5 rounds** (`--rounds N` overrides;
  can finish in 1). If you hit the cap with BLOCKER/MAJOR concerns still open, stop and
  report them as **open as of the last round** with your recommended direction - do not
  keep churning.
- **Oscillation (design-specific):** if the design **flips between two approaches**
  across rounds (round 1 picks A, round 2 rewrites to B, round 3 back to A), the critics
  are fighting over a genuine trade-off with no dominant answer. Stop, present **both
  options with their trade-offs**, and hand the decision to the user - this is exactly
  the fork a human should break, not a loop.
- **Stagnation:** a specific BLOCKER you've revised for keeps returning across two-plus
  rounds (the revision isn't resolving it). Stop and flag that one - re-running won't
  fix what your revision couldn't.

Never loop forever. A human deciding on two residual trade-offs beats an agent burning
rounds on a direction conflict it can't resolve.

## Report template (present inline; the design doc itself is the durable artifact)

Lead with the design in plain English. The round count, the critic verdicts, and the
per-round findings do **not** go in what the user reads - they live in the design doc.
Match this shape:

```
## <Feature> - the design

<2-5 short paragraphs (or tight bullets), plain English: the problem, then how it works
end to end - the new endpoint / CLI step / table / flag - and *why each piece exists*.
Name what concretely changes and what it costs. No round counts, no "converged", no
dimension/ASR codes. A reader who never saw the critique loop should follow it and be able
to approve it.>

### Decisions for you (omit if none)
- <Plain-English question a reader who never opened the doc can answer.> Recommended: <default + one-line why>.

### Trade-offs worth knowing
- Chose <X> over <Y> because <plain reason> - the alternatives are in the doc.

Design doc: <path in .context/> (survived <N> critique rounds; the trajectory and resolved
concerns are there if you want them).
```

The old template led with `Critics:` / `Trajectory:` / blocker-major tallies - do **not**.
That telemetry is for the doc and the scratch dir, never the user (see `/design` Step 7). Same for a judgment call: restate it as the
decision it stands for with a recommended default, not as `ASR-N` / `dimension N`.

If `--critique-only` was passed, stop after Step 2: present the verified, merged concerns
**in plain English** and do **not** revise the doc - the user wanted the objections, not a
rewrite.
