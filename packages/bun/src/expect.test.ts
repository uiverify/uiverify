import { expect as bunExpect, describe, test } from "bun:test";
import { expect } from "./expect";

describe("expect", () => {
  /** Catches the SDK's expect losing what bun's own has, which a test reaching for it would miss. */
  test("is bun's expect for any value other than a locator, statics included", () => {
    expect(2).toBe(2);
    expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ a: 1 }));
    expect([1]).toEqual([expect.any(Number)]);
    bunExpect(() => expect(1, "the custom message").toBe(2)).toThrow("the custom message");
  });

  test("its assertions count toward expect.assertions", () => {
    expect.assertions(1);
    expect(true).toBe(true);
  });
});
