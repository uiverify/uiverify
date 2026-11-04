import { expect } from "../../dist/index.js";
import { fired, injectFaults } from "./faults";
import { suite } from "./fixtures";

// The first view's first navigation never answers; the second view fails to enable the Page domain; the third
// is healthy.
let opens = 0;
const faults = injectFaults({
  openTimeoutMs: 3_000,
  fault: (call) => {
    if (call !== "open") return call === "reset Page.enable" && opens === 2 ? fired(call, "fail") : undefined;
    if (++opens === 1) return fired(call, "hang");
    // Read after this, so a real open (which launches Chrome) has its usual time.
    faults.openTimeoutMs = undefined;
    return undefined;
  },
});
const { describe, test } = suite(import.meta.path);

describe("Opening", () => {
  test("a page that never opens fails its test", async () => {});

  test("a page that fails to set up fails its test", async () => {});

  test("the next test opens a fresh page, routed", async (page) => {
    page.route("**/api/items", (route) => route.fulfill({ json: ["routed item"] }));
    await page.goto("/routed");
    await expect(page.getByText("routed item")).toBeVisible();
  });
});
