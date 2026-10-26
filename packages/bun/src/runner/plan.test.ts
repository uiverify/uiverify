import { describe, expect, test } from "bun:test";
import { MEMORY_PER_SHARD, normalizePath, parseArgs, planShards, shardSlots } from "./plan";

const GiB = 1024 ** 3;

describe("parseArgs", () => {
  test("takes paths and -t <pattern>, refuses any other flag", () => {
    expect(parseArgs(["a.visual.ts", "-t", "home", "b.visual.ts"])).toEqual({ files: ["a.visual.ts", "b.visual.ts"], pattern: "home" });
    expect(parseArgs([])).toEqual({ files: [] });
    expect(() => parseArgs(["--shard=1/2"])).toThrow("unknown option --shard=1/2");
    expect(() => parseArgs(["-t"])).toThrow("-t needs a test name pattern");
  });
});

describe("planShards", () => {
  const discovered = ["tests/a.visual.ts", "tests/app.visual.ts", "tests/b.visual.ts"];

  /** Catches a stateful file's shards sharing a server (they'd change each other's data), and any shift in
   *  the shard-to-server mapping, which resource URLs carry as the port. */
  test("shard k of a perShard file uses server k; every other file uses server 0", () => {
    const plan = planShards(["tests/a.visual.ts", "tests/app.visual.ts"], discovered, {
      shards: { "tests/a.visual.ts": 3, "tests/app.visual.ts": 2 },
      webServer: { command: ["bun", "s.ts"], port: 3000, perShard: ["tests/app.visual.ts"] },
    });
    expect(plan.servers).toBe(2);
    expect(plan.shards.map((s) => `${s.file}#${s.index}/${s.count}@${s.server}`)).toEqual([
      "tests/a.visual.ts#0/3@0",
      "tests/a.visual.ts#1/3@0",
      "tests/a.visual.ts#2/3@0",
      "tests/app.visual.ts#0/2@0",
      "tests/app.visual.ts#1/2@1",
    ]);
  });

  test("servers count only the perShard files this run includes; no webServer means none", () => {
    const options = {
      shards: { "tests/app.visual.ts": 3 },
      webServer: { command: ["x"], port: 1, perShard: ["tests/app.visual.ts"] },
    };
    expect(planShards(["tests/b.visual.ts"], discovered, options).servers).toBe(1);
    expect(planShards(["tests/b.visual.ts"], discovered, { shards: options.shards }).servers).toBe(0);
  });

  /** Catches a renamed file's shard setting silently falling back to one process. */
  test("an option naming no *.visual.ts file fails", () => {
    expect(() => planShards([], discovered, { shards: { "tests/gone.visual.ts": 2 } })).toThrow("tests/gone.visual.ts");
    expect(() =>
      planShards([], discovered, { webServer: { command: ["x"], port: 1, perShard: ["tests/gone.visual.ts"] } }),
    ).toThrow("tests/gone.visual.ts");
  });

  test("paths are normalized against the cwd", () => {
    expect(normalizePath("/repo", "./tests/../tests/a.visual.ts")).toBe("tests/a.visual.ts");
    expect(normalizePath("/repo", "/repo/tests/a.visual.ts")).toBe("tests/a.visual.ts");
  });
});

describe("shardSlots", () => {
  /** Catches a huge unconstrained-memory sentinel letting every shard's Chrome start at once. */
  test("one shard per 768 MiB of the smaller of the machine and the container, at least one", () => {
    expect(shardSlots(6.8 * GiB, undefined)).toBe(9);
    expect(shardSlots(16 * GiB, 2 * GiB)).toBe(2);
    expect(shardSlots(8 * GiB, Number.MAX_SAFE_INTEGER)).toBe(Math.floor((8 * GiB) / MEMORY_PER_SHARD));
    expect(shardSlots(512 * 1024 * 1024, 0)).toBe(1);
  });
});
