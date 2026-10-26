import { expect, takeSnapshot } from "../../dist/index.js";
import { suite } from "./fixtures";

const { describe, test } = suite(import.meta.path);

describe("Failures", { viewports: { "": { width: 800, height: 600 }, mobile: { width: 390, height: 844 } } }, () => {
  test("a page error fails its test", async (page) => {
    await page.goto("/error");
    await expect(page.getByRole("heading", { name: "Error page" })).toBeVisible();
  });

  test("a route that throws fails its test", async (page) => {
    page.route("**/api/items", () => {
      throw new Error("no answer recorded");
    });
    await page.goto("/routed");
  });

  test("an un-awaited takeSnapshot fails its test", async (page) => {
    await page.goto("/");
    void takeSnapshot("unawaited");
  });

  test("a snapshot name with :: is refused", async (page) => {
    await page.goto("/");
    await takeSnapshot("a::b");
  });

  test("a snapshot name equal to a viewport key is refused", async (page) => {
    await page.goto("/");
    await takeSnapshot("mobile");
  });

  test("an error on an earlier document of the test fails it", async (page) => {
    await page.goto("/error");
    await page.goto("/");
    await takeSnapshot();
  });

  test("an unhandled rejection fails its test", async (page) => {
    await page.goto("/rejection");
  });

  test("a timer that throws on resume is the page's error, and the next timer still runs", async (page) => {
    await page.goto("/timers");
    await page.pauseClock();
    await page.getByRole("button", { name: "Two timers" }).click();
    await Bun.sleep(200);
    await page.resumeClock();
    await expect(page.getByText("Second timer ran")).toBeVisible();
  });

  test("a route that breaks the page's document is named when the test fails on it", async (page) => {
    page.route("**/routed", () => {
      throw new Error("the document route broke");
    });
    await page.goto("/routed");
  });

  test(
    "a page that never stops moving fails, naming what moves",
    async (page) => {
      await page.goto("/moving");
      await takeSnapshot();
    },
    { viewports: { "": { width: 800, height: 600 } } },
  );

  test("after the failures, a test is intact", async (page) => {
    await page.goto("/locators");
    await expect(page.getByRole("heading", { name: "Locators" })).toBeVisible();
  });
});
