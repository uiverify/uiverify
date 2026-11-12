import { injectFaults, once } from "./faults";
import { suite } from "./fixtures";

// The browser answers its first navigation 5 s late, past the 3 s each test gets: the start has a budget of
// its own, so the first test is green and the slow start is reported.
injectFaults({ testTimeoutMs: 3_000, slowMs: 2_000, fault: once((call) => call === "open", 5_000) });
const { describe, test } = suite(import.meta.path);

describe("Slow start", () => {
  test("the first test passes however long the browser took to start", async (page) => {
    page.route("**/", async (route) => {
      await Bun.sleep(2_500);
      route.fulfill({ body: "<h1>slow</h1>", contentType: "text/html" });
    });
    await page.goto("/");
  });

  test("the second test is as usual", async (page) => {
    await page.goto("/");
  });
});

