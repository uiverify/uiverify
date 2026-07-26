/**
 * The `uiverify upload` argument parser.
 *
 * Every option is declared, so anything the user writes is either recognized or **rejected** — never
 * quietly ignored. That matters more here than in most CLIs: a mistyped `--only-chnged`, a
 * `--only-changed false`, or a `--only-changed=true` that the parser shrugs off all produce a run
 * that looks successful in the CI log while rendering (and billing) something other than what was
 * asked for. The caller fails the run instead, which is the same fail-closed posture as `--strict`.
 */
const VALUE_OPTIONS = new Set(["static-dir", "working-directory", "api-url"]);

const BOOLEAN_FLAGS = new Set([
  "auto-accept-changes",
  "exit-zero-on-changes",
  "only-changed",
  "strict",
  "no-strict",
]);

/**
 * Options that a previously published release accepted and this one no longer does, mapped to whether
 * they took a value (so their value token is consumed rather than left to look like a stray).
 *
 * They are reported separately from `invalid` because rejecting them would be a worse regression than
 * the silent no-op the allowlist exists to stop: `uiverify@0.2.4` accepted both, 0.2.5 ignored them
 * silently, and a consumer whose workflow still passes one would go straight from "uploads fine" to a
 * red job with nothing uploaded. The caller warns and carries on.
 */
const REMOVED_OPTIONS = new Map<string, { takesValue: boolean }>([
  ["shadow", { takesValue: false }],
  ["build-cmd", { takesValue: true }],
]);

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  /**
   * Tokens that are unknown, malformed, or a boolean given a value — for the caller to reject.
   * **Only ever option names, never a user-supplied value** (in either spelling: `--k=v` keeps the
   * key, and a bare token is reported as `<value>`). The caller echoes these into the CI log, and an
   * unrecognized option is exactly where a secret turns up — `--api-key vt_live_…` from someone who
   * missed that the key comes from the environment — where `redact()` cannot help, since it only
   * knows the one key it was handed.
   */
  invalid: string[];
  /** Options a prior release accepted that this one ignores — the caller warns, but does not fail. */
  removed: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const invalid: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    // Carry no intent and used to parse fine, so skipping them beats failing a working invocation:
    // `--` is the POSIX end-of-options separator that wrapper scripts forward verbatim, and an empty
    // token is what `"$UNSET_VAR"` expands to in a quoted CI argument list.
    if (a === "--" || a === "") continue;
    if (!a.startsWith("--")) {
      // The subcommand is stripped before we get here, so nothing else is a legitimate positional.
      // Reported by POSITION, never content: this is where an unknown option's value lands, and that
      // is the token most likely to be a secret. The index still makes it findable in the command.
      invalid.push(`<value at position ${i + 1}>`);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    // Report the key alone, never the value — see `ParsedArgs.invalid`.
    const reported = eq === -1 ? a : `${a.slice(0, eq)}=…`;
    if (VALUE_OPTIONS.has(key)) {
      // An empty value — `--api-url=` or `--api-url ""` from an unset CI variable — is treated as
      // absent so the caller's `?? env ?? default` chain still applies. Setting "" would defeat it
      // (nullish coalescing doesn't rescue an empty string) and point every request at a bad URL.
      if (eq === -1) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) invalid.push(a);
        else {
          if (next !== "") values.set(key, next);
          i++;
        }
        continue;
      }
      const value = a.slice(eq + 1);
      if (value !== "") values.set(key, value);
      continue;
    }
    const gone = REMOVED_OPTIONS.get(key);
    if (gone) {
      removed.push(`--${key}`);
      // Swallow its value too, so it isn't reported as a stray positional on top of the warning.
      if (gone.takesValue && eq === -1 && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(key) && eq === -1) flags.add(key);
    else invalid.push(reported);
  }
  return { flags, values, invalid, removed };
}
