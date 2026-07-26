import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("reads a value option in both spellings", () => {
    expect(parseArgs(["--static-dir", "storybook-static"]).values.get("static-dir")).toBe("storybook-static");
    expect(parseArgs(["--static-dir=storybook-static"]).values.get("static-dir")).toBe("storybook-static");
  });

  it("collects a bare boolean flag wherever it appears in the argv", () => {
    expect(parseArgs(["--only-changed", "--static-dir", "sb"]).flags.has("only-changed")).toBe(true);
    expect(parseArgs(["--static-dir", "sb", "--only-changed"]).flags.has("only-changed")).toBe(true);
  });

  // Each of these used to (or could) end as a silent no-op: the run renders and bills the full suite
  // while the CI log is byte-identical to a successful opt-in. They must fail loudly instead.
  it.each([
    ["a boolean given a value", ["--only-changed", "true"]],
    ["a boolean negated with =, which we do not interpret", ["--only-changed=false"]],
    ["a misspelled flag", ["--only-chnged"]],
    ["a misspelled value option", ["--statc-dir=/tmp/sb"]],
    ["an empty key", ["--=foo"]],
    ["a value option with no value", ["--static-dir", "--only-changed"]],
    ["a stray positional", ["oops"]],
  ])("rejects %s", (_label, argv) => {
    expect(parseArgs(argv).invalid.length).toBeGreaterThan(0);
  });

  // `--only-changed false` reads as "off" to a human but would parse as the flag plus a stray token.
  // Acting on it either way is a guess, so the invocation is rejected and the caller fails the run —
  // what must never happen is proceeding with a policy the user didn't ask for.
  it("rejects a flag written with a value rather than guessing which way it meant", () => {
    expect(parseArgs(["--only-changed", "false"]).invalid).toEqual(["<value at position 2>"]);
    expect(parseArgs(["--only-changed=true"]).flags.has("only-changed")).toBe(false);
  });

  // `--api-url=${{ vars.UNSET }}` expands to `--api-url=`; setting it to "" would defeat the caller's
  // `?? UIVERIFY_API_URL ?? "https://uiverify.ai"` chain and point every request at a malformed URL.
  it("treats an empty inline value as absent so the default still applies", () => {
    expect(parseArgs(["--api-url="]).values.has("api-url")).toBe(false);
    expect(parseArgs(["--api-url="]).invalid).toEqual([]);
  });

  it("keeps a value option's value even when it looks like a flag", () => {
    expect(parseArgs(["--api-url=--weird"]).values.get("api-url")).toBe("--weird");
  });

  // The allowlist's own risk: drop an entry and every consumer passing that option starts hard-failing
  // CI with nothing uploaded. Every option the CLI documents must parse clean.
  it.each([
    ["--static-dir", "sb"],
    ["--working-directory", "."],
    ["--api-url", "https://uiverify.ai"],
    ["--auto-accept-changes"],
    ["--exit-zero-on-changes"],
    ["--only-changed"],
    ["--strict"],
    ["--no-strict"],
  ])("accepts the documented option %s", (...argv) => {
    expect(parseArgs(argv).invalid).toEqual([]);
  });

  // An unknown option is exactly where a secret turns up, and `redact()` can't mask a value it was
  // never given. Neither spelling may put the value into a string the caller logs.
  it("never echoes a value, so a secret can't reach the CI log", () => {
    expect(parseArgs(["--api-key=vt_live_SECRET"]).invalid).toEqual(["--api-key=…"]);
    expect(parseArgs(["--api-key", "vt_live_SECRET"]).invalid).toEqual(["--api-key", "<value at position 2>"]);
    for (const argv of [["--api-key=vt_live_SECRET"], ["--api-key", "vt_live_SECRET"]]) {
      expect(parseArgs(argv).invalid.join(" ")).not.toContain("vt_live_SECRET");
    }
  });

  // `uiverify@0.2.4` accepted these and 0.2.5 ignored them silently. Rejecting them now would take a
  // workflow that uploads fine straight to a red job on upgrade — worse than the no-op we're guarding
  // against — so they warn and the run continues.
  it("warns about a removed option instead of failing the run", () => {
    const { invalid, removed } = parseArgs(["--static-dir", "sb", "--shadow"]);
    expect(removed).toEqual(["--shadow"]);
    expect(invalid).toEqual([]);
  });

  it("swallows a removed option's value so it isn't also reported as a stray", () => {
    const { invalid, removed, values } = parseArgs(["--build-cmd", "npm run build-storybook", "--static-dir", "sb"]);
    expect(removed).toEqual(["--build-cmd"]);
    expect(invalid).toEqual([]);
    expect(values.get("static-dir")).toBe("sb");
  });

  it("ignores a bare -- separator that wrapper scripts forward", () => {
    const { values, invalid } = parseArgs(["--", "--static-dir", "sb"]);
    expect(invalid).toEqual([]);
    expect(values.get("static-dir")).toBe("sb");
  });

  it("treats an empty space-separated value as absent, like its inline sibling", () => {
    expect(parseArgs(["--api-url", ""]).values.has("api-url")).toBe(false);
  });

  it("accepts a full realistic invocation with nothing left over", () => {
    const { flags, values, invalid } = parseArgs([
      "--static-dir",
      "storybook-static",
      "--only-changed",
      "--auto-accept-changes",
      "--no-strict",
    ]);
    expect(invalid).toEqual([]);
    expect(values.get("static-dir")).toBe("storybook-static");
    expect([...flags].sort()).toEqual(["auto-accept-changes", "no-strict", "only-changed"]);
  });
});
