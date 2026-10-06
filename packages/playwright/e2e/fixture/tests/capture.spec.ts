import { expect, test } from "@uiverify/playwright";

test("passes", async ({ page }) => {
  await page.setContent("<h1>passed</h1>");
});

test("fails an assertion", async ({ page }) => {
  await page.setContent("<h1>broken</h1>");
  await expect(page.locator("h1")).toHaveText("fixed", { timeout: 100 });
});

test("times out", async ({ page }) => {
  test.setTimeout(1000);
  await page.setContent("<h1>stuck</h1>");
  await new Promise(() => {});
});

test("expected to fail with its page closed", async ({ page }) => {
  test.fail();
  await page.close();
  throw new Error("expected");
});
