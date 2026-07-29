---
name: add-rule
description: Turn a code-owner correction (or a recurring mistake) into a durable rule - the right conventions-doc edit, and a real failing lint guard whenever the rule is mechanically checkable. This is the self-improving loop the factory leans on: when something goes rogue, capture it so the linter/conventions-doc catches it next time instead of a human re-explaining it. Also runs as a weekly sweep over recent merged work. Use when asked to "/add-rule", "turn this into a rule", "make sure this never happens again", "capture this correction", "add a lint guard for X", or "do the weekly rule review".
argument-hint: '[the correction - or "sweep" for the weekly pass]'
---

# /add-rule - capture a correction as a durable, enforced rule

When you (or a reviewer, or CI) correct the same class of mistake twice, that's a rule waiting to
exist. This skill turns a correction into something durable: the **right conventions-doc edit** (a
CLAUDE.md / AGENTS.md, root or a subtree's own), plus a
**real failing guard** whenever the rule can be checked mechanically. "The linter is law" only means
something if new laws actually get written - this is how they do. It's the manual, on-demand version
of the self-improving loop, and the thing `/factory` and `/babysit-pr` call when a failure generalizes.

**Two modes:**

- **Point mode (default):** the argument (or the recent conversation) is a specific correction -
  "stop hand-writing route paths", "always colocate a `route.test.ts`", "don't put an em dash in
  shipped copy". Capture that one.
- **Sweep mode (`/add-rule sweep`):** the weekly pass. Scan recent merged PRs, review outputs, and
  corrections from recent sessions for patterns worth codifying, and propose a batch.
  (This replaces a scheduled cron - you're one developer; run it when you feel the drift.)

**Execute directly - do not enter plan mode.** Always land on a concrete proposal, then act on the
user's yes.

## Step 0 - Route the correction (is this even a code rule?)

A correction has one of three homes - pick before you write anything:

- **A code / codebase-convention mistake** ("stop hand-writing route paths", "colocate the
  `route.test.ts`", "batch this, don't `await` per story") → **this skill**: a conventions-doc rule + a
  lint guard. Continue to Step 1.
- **A how-you-work / process preference** ("stop asking so many questions", "give me a
  recommendation not a survey", "don't over-explain", "always run the tests before saying done")
  → **not a lint rule.** Save it **wherever your harness persists cross-session guidance** with the **why** and
  how-to-apply, so it carries across sessions. If it's specifically about working *in your repo*,
  also add it to the root conventions doc's engineering conventions. Then stop - Steps 1-6 below are
  about mechanical code rules and don't apply.
- **A genuine one-off** (a typo, a this-once preference with no plausible recurrence) → just fix
  the instance and move on. Say so; don't manufacture a rule.

The rest of this skill is the **code-rule** path.

## Step 1 - State the rule in one sentence

Compress the correction to a single **"when X, do Y (not Z)"** with the **why**. If you can't state
it crisply, it's not a rule yet - ask the user to sharpen it, or drop it. A rule that's really a
one-off typo (no plausible recurrence) is not worth capturing; say so and stop.

## Step 2 - Pick the enforcement layer (prefer mechanical over prose)

The order of preference - **a machine catches it before a human has to:**

1. **Linter rule** (your linter - ESLint, oxlint, …)
   - if it's an AST/type pattern your linter already has a rule for (like the existing
   `no-explicit-any` / `no-non-null-assertion`). Cheapest and fastest.
2. **Import-boundary rule** (your import-boundary tool - dependency-cruiser, an ESLint boundaries
   plugin)
   - if it's an **import boundary** (who may import what). Add a `forbidden` entry with
   `severity: "error"` and a `comment`.
3. **Custom guard script** (point at your own custom-lint script, or create a small one) - if it's a
   **prose/regex-checkable** convention your linter can't express (an inline route path, a missing
   colocated test, a banned string in shipped copy). Add a guard following the script's existing
   shape: a `name`, the `rule` text, a `fix` hint, and a `run()` that returns the list of violations
   (each with its file, line, snippet, and detail).
4. **Prose-only conventions-doc rule** - only when it genuinely can't be mechanized (a judgment call,
   a design-taste rule). Prose is the fallback, not the default.

**A mechanical guard MUST be zero-false-positive on the current tree** - it runs on every push, and a
noisy guard trains everyone to ignore your linter/guard. If the clean-tree state already has violations
you can't cheaply fix, either fix them as part of this change, scope the guard tighter, or fall back to
prose and say why (this is exactly why a rule with many pre-existing intentional hits stays prose -
e.g. an em-dash ban with hundreds of pre-existing hits, including intentional ones).

## Step 3 - Place the rule in the right conventions doc

Match scope to file - a rule enforced in the wrong file gets missed:

- **General engineering principle** (types, tests, performance, comments) → your root conventions doc.
- **A framework / app-surface convention** (a particular app or subtree) → that subtree's own
  conventions doc.
- **A package-specific convention** → that package's own conventions doc (create one only if the
  package genuinely needs standing rules; don't spawn empty files).

Write it in the **house voice**: dense, a bolded "when X do Y" lead, the **why** stated (a hidden
invariant, a real trade-off), and a pointer to the guard/decision that enforces or justifies it. Match
the surrounding bullets - don't tack on a differently-styled section.

## Step 4 - Wire prose ↔ guard together

If you added a mechanical guard, the conventions-doc rule should **name it** ("...enforced by
<your guard script>") and the guard's `rule`/`fix` strings should point back at the conventions-doc
rule - so a future reader finds one from the other. They are a pair; never add one without the other
when the rule is mechanizable.

## Step 5 - Prove it, then propose

Before presenting: run the guard/lint on the current tree and confirm it's **green** (no
false-positives), and - for a guard - construct one throwaway example to confirm it actually **fails**
on a real violation (don't ship a no-op guard). Run your linter/guard to confirm the whole chain still
passes.

Then present the concrete change for the user's OK: the one-sentence rule, the layer you chose and why,
the exact conventions-doc diff, and the guard diff if any. **Only write on a yes** ("adds a rule agreed").
If the user amends it, fold that in and re-confirm.

## Step 6 - Offer the decision-log note

If this rule reflects a real *decision* (you chose a convention, reversed one, learned something that
changes the plan), offer to add an entry to your decision log, if you keep one, per your conventions
doc's "ask, don't assume" policy - don't write it unprompted.

## Guardrails

- **Confirm before writing.** This skill proposes; the user's yes is the gate.
- **No noisy guards.** Zero false-positives on the clean tree, or it's prose.
- **Don't over-rule.** Codify recurring, generalizable mistakes - not every one-off. Fewer, sharper,
  enforced rules beat a wall of prose no one reads.
- **Prose and guard travel together** when the rule is mechanizable.
