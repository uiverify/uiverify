# Adjudication & report

You (the orchestrator) are the neutral judge. The reviewers are advisors; you
decide what is real. This is where multi-model review earns its keep - without
verification you just merge two piles of noise.

## Verify before you trust

For every finding from every reviewer:

1. **Open the cited file at the cited line** and read enough surrounding code to
   confirm the claim. Reviewers hallucinate line numbers and misread control flow;
   roughly half of a model's "extra" findings do not reproduce.
2. **Keep it only if it's a real, reproducible defect.** Drop: findings that misread
   the code, findings already handled elsewhere (a guard the reviewer missed), pure
   style nitpicks, and vague "consider" suggestions with no concrete failure.
3. If a finding is plausible but you cannot confirm it from the code, keep it
   **out of the counted Findings list** - it is not a verified defect. Drop it
   outright unless it is both consequential and cheap for a human to check, in
   which case surface it under the separate "Unverified" section of the report
   (which does not count toward the verified total) with what you'd need to check.

## Merge

- **Dedupe** by file + root cause (the same underlying defect), not exact line - two
  reviewers often anchor one defect to adjacent lines (a missing guard vs. the
  dereference it fails to protect). When both flagged the same real issue, collapse to
  one finding tagged `[both]`.
- Tag single-source findings `[claude]` or `[codex]`.
- **Do not drop a verified finding just because only one model found it.** The
  complementary single-model catches are frequently the highest-value ones.
- **Rank** Critical → High → Medium → Low. Within a tier, put `[both]` first.

## Report template (present inline, do not write to a file)

```
## Multi-model review - <N> verified findings

Reviewers: Claude (<claude verdict>) · Codex (<codex verdict>)<, or "Codex: unavailable">
<one-sentence overall take>

### Findings

1. [both] CRITICAL - path/to/file.ts:142 · correctness
   <what's wrong, one or two sentences>
   Failure: <concrete scenario>
   Fix: <the surgical change>

2. [codex] HIGH - path/to/other.ts:88 · security
   ...

3. [claude] MEDIUM - ...

<... ranked ...>

### Complementary catches
- Only Codex flagged: <finding(s)> - <why it matters>
- Only Claude flagged: <finding(s)> - <why it matters>

### Unverified - needs a human check (N) - omit this section if none
- <file:line> - <the claim> → <what you couldn't confirm from the code, and how to check it>

### Dropped as false positives (N)
- <file:line> - <reviewer's claim> → <why it doesn't hold> (kept brief)
```

Notes:

- The `<N> verified findings` count in the title covers only the Findings list -
  Unverified items are excluded from it.
- If both reviewers returned `APPROVE` and nothing survived verification, say the
  panel found no blocking issues, list any dropped false positives briefly, and stop.
- The "Dropped as false positives" section is worth keeping short but present - it
  shows the verification actually happened and helps the user calibrate trust.
- Keep every finding's `Fix:` line concrete enough to act on; if `--fix` was passed,
  these become the edits you apply.
