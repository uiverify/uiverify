import { expect, takeSnapshot } from "../../dist/index.js";
import { suite } from "./fixtures";

// Tests that depend on the one before them, so this file runs in one process.
const { describe, test } = suite(import.meta.path);

describe("Sequence", () => {
  test("leaves storage, a cookie, history, window.name, an init script and a route behind", async (page) => {
    page.route("**/api/items", (route) => route.fulfill({ json: ["left-behind route"] }));
    await page.addInitScript(() => {
      Reflect.set(window, "__initScript", "leaked");
      localStorage.setItem("left-behind", "yes");
      document.cookie = "left=behind";
      window.name = "left-behind";
    });
    await page.goto("/routed");
    await expect(page.getByText("left-behind route")).toBeVisible();
    await page.goto("/isolation");
    await expect(page.getByText('"storage":"yes","cookie":"left=behind"', { exact: false })).toBeVisible();
  });

  test("the next test starts clean", async (page) => {
    await page.goto("/isolation");
    await expect(page.getByText('"storage":null,"cookie":"","history":2,"name":"","init":null')).toBeVisible();
    await page.goto("/routed");
    await expect(page.getByText("from the server")).toBeVisible();
  });

  test("a page on another origin writes that origin's storage", async (page) => {
    await page.goto("/to-other-origin");
    await page.getByRole("link", { name: "To the other origin" }).click();
    await expect(page.getByText("previous: null")).toBeVisible();
  });

  test("the next test starts with that origin's storage cleared too", async (page) => {
    await page.goto("/to-other-origin");
    await page.getByRole("link", { name: "To the other origin" }).click();
    await expect(page.getByText("previous: null")).toBeVisible();
  });

  test("an earlier test loads an image", async (page) => {
    await page.goto("/load-earlier");
    await page.waitUntil("the image", async () => (await page.locator("img").count()) === 1);
  });

  test("the outside-page channel won't hand that image to this test", async (page) => {
    await page.goto("/ask-earlier");
    await expect(page.getByText("refused", { exact: true })).toBeVisible();
  });

  test("a load left hanging", async (page) => {
    await page.goto("/");
    await takeSnapshot();
    void page.goto("/hang").catch(() => {});
  });

  test("after a hanging load, the next test is intact", async (page) => {
    await page.goto("/locators");
    await expect(page.getByRole("heading", { name: "Locators" })).toBeVisible();
  });

});
