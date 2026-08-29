/**
 * The single deliberate non-zero exit of a normal (waiting) run: the visual verdict. A pure map from
 * the build's terminal gate status to a process exit code, isolated here so every flag interaction is
 * unit-tested directly — no poll loop, no network.
 *
 * The status is the server's `gateStatus`, so an auto-accepted `changed` build already arrives as
 * `passed`. Cases:
 * - `passed`, or no status at all → 0.
 * - `failed` and `blocked` (shot-quota / payment hard-pause) ALWAYS gate → 1, regardless of the flag —
 *   neither is "just changes to review".
 * - `changed` (a genuine needs-review verdict) → 1 by default; `--exit-zero-on-changes` softens ONLY
 *   this one to 0, so changes stay pending review in the dashboard without turning the CI job red.
 */
export interface GateFlags {
  exitZeroOnChanges: boolean;
}

export function exitCodeFor(status: string | undefined, flags: GateFlags): number {
  if (status === "changed") return flags.exitZeroOnChanges ? 0 : 1;
  if (status === "failed" || status === "blocked") return 1;
  return 0;
}

/**
 * The exit code for `uiverify check` (the interactive preview build). Unlike `upload`, a preview check
 * is NOT a gate — it renders the agent's targets and reports what changed so the agent can review the
 * pixels over MCP and decide. A `changed` verdict is the expected, useful result (it worked and found a
 * diff), so it exits **0**; the changed-story list is on stdout for the agent to read. Only a build that
 * couldn't give a clean answer gates: `failed` (a story errored) / `blocked` (quota/payment) → 1.
 * Operational failures (the check not running at all) are handled separately by `softFail`.
 */
export function previewExitCodeFor(status: string | undefined): number {
  if (status === "failed" || status === "blocked") return 1;
  return 0;
}
