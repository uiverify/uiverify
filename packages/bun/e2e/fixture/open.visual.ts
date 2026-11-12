import { expect } from "../../dist/index.js";
import { fired, injectFaults } from "./faults";
import { suite } from "./fixtures";

// The browser starts, healthy. The second test's reset fails, so its view is replaced and the replacement's
// first navigation never answers; the third test's view fails to enable the Page domain; the fourth is healthy.
let opens = 0;
let navigations = 0;
const faults = injectFaults({
  fault: (call) => {
    if (call === "reset Page.navigate") {
      if (++navigations !== 2) return undefined;
      // The budget is read as the replacement starts, so it is short for that one open only.
      faults.openTimeoutMs = 3_000;
      return fired(call, "fail");
    }
    if (call === "open") {
      if (++opens !== 2) return undefined;
      faults.openTimeoutMs = undefined;
      return fired(call, "hang");
    }
    return call === "reset Page.enable" && opens === 3 ? fired(call, "fail") : undefined;
  },
});
const { describe, test } = suite(import.meta.path);

describe("Opening", () => {
  test("the browser starts", async () => {});

  test("a page that never reopens fails its test", async () => {});

  test("a page that fails to set up fails its test", async () => {});

  test("the next test opens a fresh page, routed", async (page) => {
    page.route("**/api/items", (route) => route.fulfill({ json: ["routed item"] }));
    await page.goto("/routed");
    await expect(page.getByText("routed item")).toBeVisible();
  });
});
