/**
 * @uiverify/bun — the client capture SDK for Bun. Visual tests run on `bun test`, drive the installed Chrome
 * through `Bun.WebView`, and each test archives its final DOM (serialized DOM + resource bytes) for UI Verify
 * to replay + diff:
 *
 *   // tests/visual/fixtures.ts
 *   export const visualSuite = defineSuite({ viewports: { "": DEFAULT_VIEWPORT } });
 *   // tests/visual/home.visual.ts
 *   const { test } = visualSuite(import.meta.path);
 *   test("home", async (page) => {
 *     await page.goto("/");
 *     await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
 *   });
 *
 * `run()` from `@uiverify/bun/run` starts the app and runs the files; `uiverify upload --static-dir
 * uiverify-archive` ships the archive.
 */
export { defineSuite, takeSnapshot, type SuiteOptions, type Viewports } from "./suite";
export { expect } from "./expect";
export { serveBundle } from "./serve-bundle";
export { DEFAULT_VIEWPORT, type Viewport } from "./tab";
export type { Locator, Page } from "./page";
export type { Route } from "./routes";
