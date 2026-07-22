/**
 * Whether an *operational* failure should fail the CI job (exit 1) or be swallowed (exit 0). An
 * operational failure is the upload itself not happening — a missing/invalid API key, a broken or empty
 * static build, a network/S3/5xx error. This is separate from the visual verdict (changed/failed),
 * which is gated by `exitCodeFor`, never by this.
 *
 * Strict-by-default (fail-closed): a silently-failed upload must not leave CI green ("green but nothing
 * was uploaded"). An explicit `--strict` / `--no-strict` overrides in either direction (and `--strict`
 * wins a contradictory pair); absent either, strict.
 *
 * Isolated here (like `exitCodeFor`) so the flag precedence is unit-tested directly, off the CLI's
 * arg-parsing and process-exit plumbing.
 */
export function resolveStrict(flags: { strict: boolean; noStrict: boolean }): boolean {
  return flags.strict ? true : flags.noStrict ? false : true;
}
