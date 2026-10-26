import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunContext, RUN_ENV } from "./run-context";

describe("readRunContext", () => {
  const dir = mkdtempSync(join(tmpdir(), "uiverify-run-context-"));
  const file = join(dir, "shard.json");
  writeFileSync(file, JSON.stringify({ token: "abc", shard: { index: 1, count: 2 }, baseUrl: "http://127.0.0.1:1" }));

  test("reads the shard run() wrote for this process", () => {
    expect(readRunContext({ [RUN_ENV]: `abc@${file}` })).toEqual({
      token: "abc",
      shard: { index: 1, count: 2 },
      baseUrl: "http://127.0.0.1:1",
    });
    expect(readRunContext({})).toBeUndefined();
  });

  /** Catches the variable working as hand-set configuration (a shard split with no runner behind it). */
  test("refuses a value run() didn't write", () => {
    expect(() => readRunContext({ [RUN_ENV]: `other@${file}` })).toThrow("don't set it yourself");
    expect(() => readRunContext({ [RUN_ENV]: "0/2" })).toThrow("don't set it yourself");
  });
});
