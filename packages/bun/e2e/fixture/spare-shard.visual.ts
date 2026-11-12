import { fired, injectFaults } from "./faults";
import { suite } from "./fixtures";

// Dealt two shards for one test, so one shard has nothing to run and must not start the browser: each start
// that does is one fired fault.
injectFaults({ fault: (call) => (call === "open" ? fired(call, "fail") : undefined) });
const { describe, test } = suite(import.meta.path);

describe("Spare shard", () => {
  test("the only test", async () => {});
});
