# Adding a third reviewer (e.g. Gemini)

The panel is built so a third model is one more parallel launch in Step 3 plus one
more source in the Step 4 adjudication set. Nothing else changes - same brief, same
verify-and-merge.

## Why it's optional / deferred

A diverse **two-model** pair (Claude + one non-Anthropic model) already captures
most of the ensemble's bug-finding benefit, and Codex covers the "non-Anthropic
voice" that matters most. A third model adds a smaller marginal catch (Gemini's
real strength is concurrency / permission / whole-repo patterns via its long
context) at a meaningfully higher token cost - worth it for a thorough pass, not
for every review.

## Gemini specifics (important)

Google's free/consumer Gemini tooling (the Gemini CLI and the Code Assist PR bot)
has been in flux - availability and quotas shift, so **verify the current CLI /
PR-bot options before relying on a free tier**. The dependable headless path is a
**paid API key** (billing enabled; free AI Studio keys tend to be Flash-only and
too weak for review):

```bash
npm install -g @google/gemini-cli
export GEMINI_API_KEY=...        # from a billing-enabled Google AI Studio / Vertex project
# pin the model to avoid silent Pro→Flash downgrades:
gemini -p "$(cat "$SCRATCH/brief.md")" -m gemini-3-pro-preview \
  --output-format json < "$SCRATCH/diff.patch" > "$SCRATCH/gemini-out.md"
```

Watch for: silent model downgrades under load, and Gemini's tendency to answer with
a verbose redesign instead of pointing at the defect - the strict brief's
"point at the line, do not propose a rewrite" rule is there partly to curb this.

## To wire it in

1. In Step 0 preflight, detect availability: `command -v gemini` and a set
   `GEMINI_API_KEY`. Gate it behind an explicit `--gemini` flag so a normal run
   stays fast and dependency-free.
2. In Step 3, launch it in the background alongside Codex with the same
   `$SCRATCH/brief.md` and `$SCRATCH/diff.patch`.
3. In Step 4, add its findings as a third source; tags become `[claude]`,
   `[codex]`, `[gemini]`, and any 2- or 3-way agreement collapses to `[both]` /
   `[all]`.

Any CLI that can run headless and read a prompt + diff (a second `codex` profile
on a different model, `cursor-agent -p --model ...`, an API wrapper) slots in the
same way.
