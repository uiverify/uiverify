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

  it("redact is a no-op without a secret; maskKey keeps the 8-char prefix", () => {
    expect(redact("plain text", undefined)).toBe("plain text");
    expect(maskKey("uv_proj_secret")).toBe("uv_proj_******");
  });
});
