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
