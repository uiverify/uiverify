import { expect, takeSnapshot } from "../../dist/index.js";
import { suite } from "./fixtures";

const { describe, test } = suite(import.meta.path);

describe("Late stylesheets", () => {
  test("a cross-origin stylesheet added after load, held back 1 s", async (page) => {
    await page.goto("/late-font");
    await page.waitUntil("the stylesheet link", async () => (await page.locator("body[data-sheets]").count()) === 1);
    await takeSnapshot();
  });

  test("a same-origin stylesheet whose @import is held back 1 s", async (page) => {
    await page.goto("/late-import-font");
    await page.waitUntil("the stylesheet link", async () => (await page.locator("body[data-sheets]").count()) === 1);
    await takeSnapshot();
  });

  /** One sheet fails and one never answers. The first snapshot waits out the settle cap for the second; the
   *  next must not, whatever the archive step separately costs for a request that never answers. */
  test("a failed and a never-answering stylesheet cost the cap once", async (page) => {
    await page.goto("/late-broken");
    await page.waitUntil("the stylesheet links", async () => (await page.locator("body[data-sheets]").count()) === 1);
    const started = Date.now();
    await takeSnapshot("first");
    const first = Date.now() - started;
    const next = Date.now();
    await takeSnapshot("second");
    expect(first - (Date.now() - next)).toBeGreaterThan(1_500);
  });

  /** A sheet that failed is finished: it must not cost a wait. */
  test("a failed stylesheet costs no wait", async (page) => {
    await page.goto("/");
    const baseline = Date.now();
    await takeSnapshot("plain");
    const plain = Date.now() - baseline;
    await page.goto("/failed-stylesheet");
    const started = Date.now();
    await takeSnapshot("failed");
    expect(Date.now() - started - plain).toBeLessThan(2_000);
  });
});
