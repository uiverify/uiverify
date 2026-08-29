/**
 * The `uiverify` argument parser.
 *
 * Every option is declared, so anything the user writes is either recognized or **rejected** — never
 * quietly ignored. That matters more here than in most CLIs: a mistyped `--only-chnged`, a
 * `--only-changed false`, or a `--only-changed=true` that the parser shrugs off all produce a run
 * that looks successful in the CI log while rendering (and billing) something other than what was
 * asked for. The caller fails the run instead, which is the same fail-closed posture as `--strict`.
 *
 * The allowlist is **per subcommand** (`ParseSpec`), so each command accepts exactly its own surface:
 * `upload --story` and `check --only-changed` are both rejected, not silently ignored. `parseArgs`
 * defaults to the `upload` spec so its callers/tests are unchanged.
 */
export interface ParseSpec {
  /** Options that take exactly one value (`--static-dir <dir>`); a later occurrence overwrites. */
  valueOptions: Set<string>;
  /** Options that may repeat and accumulate into `multi` (`--story a --story b`). */
  multiValueOptions: Set<string>;
  /** Bare boolean flags (`--strict`); a value makes them `invalid`. */
  booleanFlags: Set<string>;
}

export const UPLOAD_SPEC: ParseSpec = {
  valueOptions: new Set(["static-dir", "screenshots", "working-directory", "api-url"]),
  multiValueOptions: new Set(),
  booleanFlags: new Set(["auto-accept-changes", "exit-zero-on-changes", "only-changed", "strict", "no-strict"]),
};

/** `uiverify check` (the interactive preview build): capture input + the agent's `--story` targets +
 *  the operational-failure switches. Deliberately NOT the upload gating flags (a preview check is not a
 *  CI gate), so passing one is rejected rather than silently ignored. */
export const CHECK_SPEC: ParseSpec = {
  valueOptions: new Set(["static-dir", "screenshots", "working-directory", "api-url"]),
  multiValueOptions: new Set(["story"]),
  booleanFlags: new Set(["strict", "no-strict"]),
};

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
  /** Accumulated values for repeatable options (each occurrence of `--story`), empty values dropped —
   *  so `--story a --story b` reads back as `["a", "b"]`. Empty for a command with no repeatable option. */
  multi: Map<string, string[]>;
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

export function parseArgs(argv: string[], spec: ParseSpec = UPLOAD_SPEC): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const invalid: string[] = [];
  const removed: string[] = [];
  const pushMulti = (key: string, value: string): void => {
    if (value === "") return; // an empty glob is meaningless — drop it, same as an empty value option
    multi.set(key, [...(multi.get(key) ?? []), value]);
  };
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
    const isValue = spec.valueOptions.has(key);
    const isMulti = spec.multiValueOptions.has(key);
    if (isValue || isMulti) {
      // An empty value — `--api-url=` or `--api-url ""` from an unset CI variable — is treated as
      // absent so the caller's `?? env ?? default` chain still applies. Setting "" would defeat it
      // (nullish coalescing doesn't rescue an empty string) and point every request at a bad URL.
      // A repeatable option accumulates instead of overwriting; both share the same value-reading rules.
      const set = (v: string): void => (isMulti ? pushMulti(key, v) : void (v !== "" && values.set(key, v)));
      if (eq === -1) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) invalid.push(a);
        else {
          set(next);
          i++;
        }
        continue;
      }
      set(a.slice(eq + 1));
      continue;
    }
    const gone = REMOVED_OPTIONS.get(key);
    if (gone) {
      removed.push(`--${key}`);
      // Swallow its value too, so it isn't reported as a stray positional on top of the warning.
      if (gone.takesValue && eq === -1 && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
      continue;
    }
    if (spec.booleanFlags.has(key) && eq === -1) flags.add(key);
    else invalid.push(reported);
  }
  return { flags, values, multi, invalid, removed };
}
