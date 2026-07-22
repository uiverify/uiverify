import { describe, expect, it } from "vitest";
import { resolveStrict } from "./strict";

describe("resolveStrict", () => {
  const flags = (o: Partial<{ strict: boolean; noStrict: boolean }> = {}) => ({
    strict: false,
    noStrict: false,
    ...o,
  });

  it("no flags → strict by default (an operational failure fails CI)", () => {
    expect(resolveStrict(flags())).toBe(true);
  });

  it("--no-strict → non-strict (explicit opt-out)", () => {
    expect(resolveStrict(flags({ noStrict: true }))).toBe(false);
  });

  it("--strict → strict (explicit, matches the default)", () => {
    expect(resolveStrict(flags({ strict: true }))).toBe(true);
  });

  it("--strict beats a contradictory --no-strict (strict takes priority)", () => {
    expect(resolveStrict(flags({ strict: true, noStrict: true }))).toBe(true);
  });
});
