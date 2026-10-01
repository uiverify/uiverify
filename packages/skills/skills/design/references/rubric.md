# The design rubric (the anchor)

A design has no diff to verify against, so **this rubric is the ground-truth
stand-in.** Every critique the panel raises must tie to one of these dimensions (or
to a stated requirement/ASR from Step 1) - a critique anchored to neither is taste,
and taste gets dropped. The rubric is also what the loop scores against to decide
convergence: a design is done when a full cross-model pass raises no unresolved,
rubric-anchored, quote-verified concern.

**Tune it to your repo (project-specific coupling - fill this in).** A generic
scalability/security/maintainability checklist misses the invariants that actually
break in *your* system. The dimensions below are the general shape; the examples in
each are placeholders. Replace them with your repo's own load-bearing invariants (the
ones your conventions doc, e.g. `CLAUDE.md` / `AGENTS.md`, already calls out), or have
the critics read those docs, any decision records, and the relevant architecture doc
before critiquing - the design is only right *in the context it runs in*.

## Dimensions

1. **Problem & requirement fit** - does it actually solve the stated problem and
   satisfy each ASR/acceptance criterion from Step 1? Is the scope right-sized, or is
   the blast radius larger than the problem it solves?
2. **Fit with the existing system** - placed at the right layer/subsystem; consistent
   with recorded decisions and the documented architecture; **reuses existing seams**
   (the repositories, registries, queues, and services already there) instead of
   inventing parallel machinery. Does it contradict a decision already recorded?
3. **Correctness & invariants** - does it preserve the system's load-bearing
   invariants (e.g. idempotency on retry, a value the server must derive rather than
   accept from a client, a column that records a request vs. one that records an
   outcome)? Any reachable inconsistent state?
4. **Data model & migrations** - schema changes sound; migrations ordered and named so
   two branches can't collide; durable vs transient data respected; reversible or with
   a stated forward-only reason.
5. **Scale & performance** - the hot path stays **O(batches), not O(items)**; no
   per-item `await` / round-trip where one batched statement does it; independent I/O
   fanned out and bounded where it touches memory-heavy resources.
6. **Failure modes & recovery** - crash/timeout/retry behavior; partial failure and
   idempotency; graceful shutdown. Does a failure leave the system in a bad state?
7. **Security & tenancy** - authz/permission checks; cross-tenant isolation; nothing
   trusts a client- or worker-supplied value the server should own (a storage key, an
   id that grants access, a price).
8. **Cost & billing** - impact on what the product meters or charges, and on your own
   costs (compute, third-party/LLM spend); whether it ships **dark** and how it goes
   live.
9. **Observability & instrumentation** - a real user/business milestone emits an
   analytics event at the **committed, bounded seam** (not per-item, not pure intent);
   the change is diagnosable in production (logs, metrics, errors).
10. **Rollout & back-compat** - ships behind a flag where the behavior is user-visible;
    no breaking change to existing callers, data, or public API; reversible; CI/deploy
    path filters cover every input the artifact is built from.
11. **Testability & verification** - can it be exercised by a test against **real
    dependencies** at a service boundary? Name the verification path. If the flow
    crosses process boundaries (a CLI → an API → a queue → a worker) and no single
    automated test can drive it, say so - that's the signal e2e-verify is the tool.
12. **Alternatives & tradeoffs** - were the viable alternatives named and rejected
    *with reasons*? Software quality attributes trade off against each other - a design
    that claims to optimize everything hasn't made the decision yet. Is the chosen
    trade-off explicit and defensible?
13. **Doc surfaces** - if the design changes user-visible behavior, does it name
    **both** the internal architecture doc for the mechanism **and** the user-facing
    docs page for the behavior (or flag that no page covers it yet)?

Not every dimension applies to every design - a pure algorithm change won't touch
billing or tenancy. A critic marks a dimension **N/A** rather than inventing a concern
to fill it. Padding the rubric with manufactured concerns is the same failure as a code
reviewer padding with style nitpicks.

## Severity

- **BLOCKER** - the design is wrong or will not work: violates an invariant, breaks a
  caller or existing data, cannot satisfy an ASR, reachable inconsistent state, a scale
  bug that goes O(items) on a hot path.
- **MAJOR** - a real weakness that will cost later: wrong layer, missing failure-mode
  handling, an unstated trade-off that turns out to matter, a missing flag/rollout
  story.
- **MINOR** - worth fixing but not load-bearing: a naming/placement nit, a doc surface
  to remember, an alternative worth a sentence.

Only BLOCKER and MAJOR gate convergence. MINORs are reported but don't keep the loop
running.
