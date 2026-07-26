import { describe, it, expect } from "vitest";
import { maskKey, redact } from "./redact";

describe("redact", () => {
  it("redact masks every occurrence of the secret, keeping only the prefix", () => {
    const key = "uv_proj_abcdef1234567890";
    const line = `uploading with ${key} done (${key})`;
    const out = redact(line, key);
    expect(!out.includes("abcdef1234567890")).toBeTruthy();
    expect(out.includes("uv_proj_")).toBeTruthy();
  });

  it("leaves ordinary text alone; maskKey keeps the 8-char prefix", () => {
    expect(redact("plain text", undefined)).toBe("plain text");
    expect(redact("uploading 42 stories to https://uiverify.ai")).toBe("uploading 42 stories to https://uiverify.ai");
    expect(maskKey("uv_proj_secret")).toBe("uv_proj_******");
  });

  // The key reaches a log by routes the caller can't anticipate — typed onto the command line by
  // someone who missed that it comes from the environment, echoed inside a server error, quoted in a
  // retry reason. In none of those does the caller know the value, so shape has to be enough.
  it.each([
    ["a current-format key", "uv_proj_abcdef1234567890", "uv_proj_"],
    ["a legacy key", "vt_live_abcdef1234567890", "vt_live_"],
  ])("masks %s even when the secret is unknown", (_label, key, visiblePrefix) => {
    const out = redact(`unrecognized argument: --api-key ${key}`);
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain(visiblePrefix); // enough to recognize which key, not enough to use it
  });

  it("does not re-mangle an already-masked key", () => {
    const once = redact("uv_proj_abcdef1234567890");
    expect(redact(once)).toBe(once);
  });
});
