import { expect } from "../../dist/index.js";
import { suite } from "./fixtures";

// Run directly with `bun test --concurrent`: the suite's tests must still run one at a time.
const { test } = suite(import.meta.path, { baseUrl: "http://127.0.0.1:9" });
const spans: [number, number][] = [];

for (const name of ["one", "two", "three"]) {
  test(name, async () => {
    const start = Date.now();
    await Bun.sleep(200);
    spans.push([start, Date.now()]);
    for (const [otherStart, otherEnd] of spans.slice(0, -1)) expect(start >= otherEnd || Date.now() <= otherStart).toBe(true);
  });
}
