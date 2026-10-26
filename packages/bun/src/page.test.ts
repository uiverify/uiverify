import { describe, expect, test } from "bun:test";
import { nameMatches } from "./page";

describe("nameMatches", () => {
  test("Playwright's matching: substring, case-insensitive, whitespace-normalized, unless exact", () => {
    expect(nameMatches("  Save   changes ", "save changes")).toBe(true);
    expect(nameMatches("Save changes", "Save", true)).toBe(false);
    expect(nameMatches("Save", "Save", true)).toBe(true);
    expect(nameMatches("anything", undefined)).toBe(true);
  });

  /** Catches a caller's /g RegExp skipping every other element with the same name. */
  test("a global RegExp matches every time", () => {
    const name = /Save/g;
    expect([nameMatches("Save", name), nameMatches("Save", name), nameMatches("Save", name)]).toEqual([true, true, true]);
  });
});
