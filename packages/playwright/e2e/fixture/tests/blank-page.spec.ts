import type { Browser, Page } from "@playwright/test";
import { expect, test } from "@uiverify/playwright";

/** Tests run in order in one worker, and the failing one replaces it, so the last "drives its own page" runs in a fresh process. */
async function driveOwnPage(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent("<h1>own</h1>");
  await context.close();
}

test("API test opted out", async ({ request, uiVerify }) => {
  uiVerify.disableAutoSnapshot();
  expect(request).toBeDefined();
});

test("drives its own page", async ({ browser }) => {
  await driveOwnPage(browser);
});

test("drives its own page and fails", async ({ browser }) => {
  await driveOwnPage(browser);
  throw new Error("fails on purpose");
});

test("drives its own page again", async ({ browser }) => {
  await driveOwnPage(browser);
});

test("snapshots a blank page explicitly", async ({ uiVerify }) => {
  await uiVerify.snapshot("blank");
});

test("fills page through a shadow root", async ({ page }) => {
  await page.evaluate(() => {
    document.body.attachShadow({ mode: "open" }).innerHTML = "<h1>shadow</h1>";
  });
});

test("sets empty content", async ({ page }) => {
  await page.setContent("");
});

test("fills page through evaluate", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = "<h1>evaluated</h1>";
  });
});

test("styles page through an adopted stylesheet", async ({ page }) => {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html { background: rgb(255, 0, 0); }");
    document.adoptedStyleSheets = [sheet];
  });
});

const navigatedFirst = test.extend({
  page: async ({ page }, use) => {
    await page.route("http://uiverify.test/**", (route) =>
      route.request().url().endsWith("/never.png")
        ? undefined
        : route.fulfill({ contentType: "text/html", body: '<h1>slow</h1><img src="/never.png">' }),
    );
    await page.goto("http://uiverify.test/", { waitUntil: "domcontentloaded" });
    await use(page);
  },
});

navigatedFirst.describe(() => {
  navigatedFirst.describe.configure({ timeout: 5000 });
  navigatedFirst("page navigated before the fixture, its load never comes", async ({ uiVerify }) => {
    uiVerify.disableAutoSnapshot();
  });
});

const sharedPage = test.extend<object, { workerPage: Page }>({
  workerPage: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      await use(await context.newPage());
      await context.close();
    },
    { scope: "worker" },
  ],
  page: async ({ workerPage }, use) => {
    await use(workerPage);
  },
});

const events = ["load", "domcontentloaded", "framenavigated"] as const;
let listenersInFirstTest: number[] = [];

sharedPage("page shared across tests, first", async ({ page, uiVerify }) => {
  uiVerify.disableAutoSnapshot();
  listenersInFirstTest = events.map((event) => page.listenerCount(event));
});

sharedPage("page shared across tests, second", async ({ page, uiVerify }) => {
  uiVerify.disableAutoSnapshot();
  expect(listenersInFirstTest.every((count) => count > 0)).toBe(true);
  expect(events.map((event) => page.listenerCount(event))).toEqual(listenersInFirstTest);
});
