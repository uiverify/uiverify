import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "@uiverify/playwright";

/** The suite runs with the fixture as its working directory. */
const FONT = fs.readFileSync("assets/font.ttf");

const html = (family: string, head: string, script: string) =>
  `<!doctype html><html><head>${head}</head><body><p style="font-family: ${family}">Late text</p><script>
    addEventListener("load", () => setTimeout(() => { ${script}; document.body.dataset.sheets = "added"; }, 50));
  </script></body></html>`;

const append = (...hrefs: string[]) =>
  hrefs
    .map((href) => `document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "${href}" }))`)
    .join("; ");

const slow = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pages whose stylesheets arrive after the page has loaded, as an app's theme or a route's CSS does. */
test.beforeEach(async ({ page }) => {
  const doc = (body: string) => ({ contentType: "text/html", body });
  const css = (body: string) => ({ contentType: "text/css", body });
  const font = { contentType: "font/ttf", headers: { "access-control-allow-origin": "*" }, body: FONT };
  await page.route("https://app.test/late-font", (route) =>
    route.fulfill(doc(html("LateFont", "", append("https://fonts.test/late.css")))),
  );
  await page.route("https://app.test/late-import", (route) =>
    route.fulfill(doc(html("LateImportFont", "", append("https://app.test/importer.css")))),
  );
  await page.route("https://app.test/late-href", (route) =>
    route.fulfill(
      doc(
        html(
          "LateHrefFont",
          '<link id="theme" rel="stylesheet" href="https://app.test/light.css">',
          'document.getElementById("theme").href = "https://fonts.test/dark.css"',
        ),
      ),
    ),
  );
  await page.route("https://app.test/late-broken", (route) =>
    route.fulfill(doc(html("Serif", "", append("https://app.test/broken.css", "https://app.test/never.css")))),
  );
  await page.route("https://app.test/failed", (route) =>
    route.fulfill(doc(html("Serif", '<link rel="stylesheet" href="https://app.test/broken.css">', ""))),
  );
  await page.route("https://app.test/light.css", (route) => route.fulfill(css("p { color: black }")));
  await page.route("https://app.test/importer.css", (route) => route.fulfill(css("@import url(https://app.test/late-imported.css);")));
  await page.route("https://app.test/late-imported.css", async (route) => {
    await slow(1000);
    await route.fulfill(css("@font-face { font-family: LateImportFont; src: url(https://app.test/late-import.ttf) format('truetype'); }"));
  });
  await page.route("https://app.test/late-import.ttf", (route) => route.fulfill(font));
  await page.route("https://app.test/broken.css", (route) => route.fulfill({ status: 500, body: "nope" }));
  await page.route("https://app.test/never.css", () => new Promise(() => {}));
  await page.route("https://fonts.test/late.css", async (route) => {
    await slow(1000);
    await route.fulfill(css("@font-face { font-family: LateFont; src: url(https://fonts.test/late.ttf) format('truetype'); }"));
  });
  await page.route("https://fonts.test/dark.css", async (route) => {
    await slow(1000);
    await route.fulfill(css("@font-face { font-family: LateHrefFont; src: url(https://fonts.test/dark.ttf) format('truetype'); }"));
  });
  await page.route("https://fonts.test/*.ttf", (route) => route.fulfill(font));
});

const sheetsAdded = (page: Page) => expect(page.locator("body[data-sheets]")).toHaveCount(1);

test("cross-origin stylesheet added after load", async ({ page }) => {
  await page.goto("https://app.test/late-font");
  await sheetsAdded(page);
});

test("stylesheet whose import arrives late", async ({ page }) => {
  await page.goto("https://app.test/late-import");
  await sheetsAdded(page);
});

test("link whose href is changed after load", async ({ page }) => {
  await page.goto("https://app.test/late-href");
  await sheetsAdded(page);
});

test("failed and never-answering stylesheets cost the cap once", async ({ page, uiVerify }) => {
  test.setTimeout(60_000);
  uiVerify.disableAutoSnapshot();
  await page.goto("https://app.test/late-broken");
  await sheetsAdded(page);
  const started = Date.now();
  await uiVerify.snapshot("first");
  const first = Date.now() - started;
  const next = Date.now();
  await uiVerify.snapshot("second");
  expect(first - (Date.now() - next)).toBeGreaterThan(1_500);
});

test("failed stylesheet costs no wait", async ({ page, uiVerify }) => {
  uiVerify.disableAutoSnapshot();
  await page.setContent("<p>plain</p>");
  const plainStart = Date.now();
  await uiVerify.snapshot("plain");
  const plain = Date.now() - plainStart;
  await page.goto("https://app.test/failed");
  const started = Date.now();
  await uiVerify.snapshot("failed");
  expect(Date.now() - started - plain).toBeLessThan(2_000);
});
