import { fired, injectFaults } from "./faults";
import { suite } from "./fixtures";

// The browser's first navigation never answers: the file fails at the start's budget, and no test runs.
injectFaults({ startupTimeoutMs: 3_000, fault: (call) => (call === "open" ? fired(call, "hang") : undefined) });
const { describe, test } = suite(import.meta.path);

describe("Hung start", () => {
  test("never runs", async (page) => {
    await page.goto("/");
  });
});
