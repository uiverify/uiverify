import { expect, type Page, takeSnapshot } from "../../dist/index.js";
import { injectFaults, once } from "./faults";
import { suite } from "./fixtures";

// Each test named "times out" runs past a short timeout on purpose, and keeps going: bun:test can't stop a test
// body. The test after it checks that nothing the timed-out one did late reached its page.
const SHORT_MS = 8_000;
const faults = injectFaults({});
const { describe, test } = suite(import.meta.path);

function timesOut(name: string, body: (page: Page) => Promise<void>): void {
  faults.testTimeoutMs = SHORT_MS;
  test(`times out: ${name}`, body);
  faults.testTimeoutMs = undefined;
}

/** Waits out whatever the timed-out test before it still does, then is snapshotted on its own page. */
async function intact(page: Page): Promise<void> {
  await page.goto("/locators");
  await expect(page.getByRole("heading", { name: "Locators" })).toBeVisible();
  await Bun.sleep(SHORT_MS);
}

describe("Timeouts", () => {
  test("opens the browser", async (page) => {
    await page.goto("/");
  });

  timesOut("a capture still running", async (page) => {
    await page.goto("/");
    faults.fault = once((call) => call.includes(".capture("), SHORT_MS + 2_000);
    await takeSnapshot("late");
  });
  test("after a capture outlived its test", intact);

  timesOut("a goto made after it", async (page) => {
    await page.goto("/");
    // Late enough to land while the next test sleeps, after its own goto.
    await Bun.sleep(SHORT_MS + 3_000);
    await page.goto("/timers");
  });
  test("after a late goto", intact);

  timesOut("a goto with a hash whose URL check is answered after it", async (page) => {
    await page.goto("/");
    faults.fault = once((call) => call === "location.href", SHORT_MS + 3_000);
    await page.goto("/timers#late");
  });
  test("after a late hash goto", intact);

  timesOut("an error thrown after it", async (page) => {
    await page.goto("/");
    await Bun.sleep(SHORT_MS + 1_000);
    throw new Error("thrown after its test timed out");
  });
  test("after a late error", intact);

  timesOut("a call the browser never answers", async (page) => {
    await page.goto("/");
    faults.fault = once((call) => call === "page Page.addScriptToEvaluateOnNewDocument", "hang");
    await page.addInitScript(() => {});
  });
  // The reset gives up on the wedged view after 5 s and opens a fresh one; queueing behind the wedged call
  // instead would wait out its 15 s first.
  faults.testTimeoutMs = 14_000;
  test("after a wedged view", async (page) => {
    await page.goto("/locators");
    await expect(page.getByRole("heading", { name: "Locators" })).toBeVisible();
  });
  faults.testTimeoutMs = undefined;
});
