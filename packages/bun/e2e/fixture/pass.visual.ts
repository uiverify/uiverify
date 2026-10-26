import { expect, takeSnapshot } from "../../dist/index.js";
import { suite } from "./fixtures";

const { describe, beforeEach, test } = suite(import.meta.path);

describe("Locators", () => {
  test("find by role, text, label, placeholder and test id", async (page) => {
    await page.goto("/locators");
    await expect(page.getByRole("heading", { name: "locators" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bold", pressed: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disabled action" })).toBeDisabled();
    await expect(page.getByText("second ITEM")).toHaveCount(1);
    await expect(page.getByText("Second", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("email")).toHaveAttribute("id", "email");
    await expect(page.getByLabel("Wrapped name", { exact: true })).toHaveAttribute("id", "wrapped");
    await expect(page.getByLabel("External label")).toHaveAttribute("id", "labelled");
    await expect(page.getByLabel("Search everything")).toHaveAttribute("id", "aria");
    await expect(page.getByLabel("Email address")).toHaveCount(1);
    await page.getByPlaceholder("YOU@example").fill("a@b.c");
    await expect(page.getByLabel("Email address")).toHaveValue("a@b.c");
    await expect(page.getByTestId("the-box").getByText("inner text")).toBeVisible();
    await expect(page.locator('li:text-is("First item")')).toHaveCount(1);
    await expect(page.getByText("inner text").locator("..")).toHaveAttribute("data-testid", "the-box");
    await expect(page.locator("li").first()).toHaveCount(1);
    await expect(page.getByText("Nowhere")).not.toBeAttached();
    expect(await page.locator("li").count()).toBe(2);
  });

  test("a click below the fold scrolls only as far as it must", async (page) => {
    await page.goto("/scroll");
    await page.getByRole("button", { name: "Far button" }).click();
    await page.waitUntil("the click", async () => (await page.locator("body[data-scroll-y]").count()) === 1);
  });

  test("concurrent click and fill both land", async (page) => {
    await page.goto("/concurrent");
    await Promise.all([
      page.getByRole("button", { name: "Concurrent button" }).click(),
      page.getByPlaceholder("Concurrent field").fill("typed"),
    ]);
    await expect(page.getByRole("button", { name: "Concurrent button" })).toHaveAttribute("data-clicked", "yes");
    await expect(page.getByPlaceholder("Concurrent field")).toHaveValue("typed");
  });
});

describe("Routes and scripts", () => {
  test("a route answers and an init script runs first", async (page) => {
    page.route("**/api/items", (route) => route.fulfill({ json: ["routed item"] }));
    await page.addInitScript(() => {
      Reflect.set(window, "__initScript", "ran");
    });
    await page.goto("/routed");
    await expect(page.getByText("routed item")).toBeVisible();
    await expect(page.locator("#init")).toHaveCount(1);
    await expect(page.getByText("ran", { exact: true })).toBeVisible();
  });

  test("a never-answered request leaves the page loading, and it can be captured", async (page) => {
    await page.goto("/loading");
    await expect(page.getByRole("heading", { name: "Loading…" })).toBeVisible();
    await takeSnapshot();
  });

  /** A paused document holds page calls; once its frame is gone, nothing should wait for it. */
  test("a frame removed while its document is still paused doesn't hold the page", async (page) => {
    page.route("**/never-answered-frame", () => new Promise(() => {}));
    await page.goto("/detached-frame");
    await expect(page.getByText("Frame removed")).toBeVisible();
    const started = Date.now();
    await expect(page.getByRole("heading", { name: "Detached frame" })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("dialogs and beforeunload never block the page", async (page) => {
    await page.goto("/dialogs");
    await expect(page.getByText("Arrived late")).toBeVisible();
    // A beforeunload prompt needs the user to have interacted with the page first.
    await page.getByRole("heading", { name: "Dialogs" }).click();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Fixture home" })).toBeVisible();
  });

  test("a cross-site frame inserted after load doesn't stop locators", async (page) => {
    await page.goto("/iframe");
    await page.waitUntil("the frame", async () => (await page.locator("iframe").count()) === 1);
    await page.getByRole("button", { name: "Inside page" }).click();
    await expect(page.getByRole("heading", { name: "With a frame" })).toBeVisible();
  });

  test("a click to a server-rendered page with a stylesheet, then hover", async (page) => {
    await page.goto("/nav");
    await page.getByRole("link", { name: "Go to rendered" }).click();
    await expect(page.getByRole("heading", { name: "Rendered page" })).toBeVisible();
    await page.getByRole("button", { name: "Hover me" }).hover();
    await expect(page.getByRole("button", { name: "Hovered" })).toBeVisible();
  });

  for (const name of ["No content", "Download", "New tab"]) {
    test(`a "${name}" link never holds the page`, async (page) => {
      await page.goto("/links");
      await page.getByRole("link", { name }).click();
      await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();
    });
  }

  test("CORS for routed cross-origin fetches", async (page) => {
    page.route("**/api/plain", (route) => route.fulfill({ json: "plain" }));
    page.route("**/api/credentialed", (route) => route.fulfill({ json: "credentialed" }));
    page.route("**/api/preflighted", (route) => route.fulfill({ json: "preflighted" }));
    page.route("**/api/own", (route) => route.fulfill({ json: "own", headers: { "Access-Control-Allow-Origin": "*" } }));
    await page.goto("/cors");
    await expect(
      page.getByText('{"credentialed":"credentialed","own":"own","plain":"plain","preflighted":"preflighted"}'),
    ).toBeVisible();
  });

  test("the outside-page channel only hands back visual assets Chrome loaded", async (page) => {
    await page.goto("/outside");
    await expect(page.locator("#out:not(:empty)")).toHaveCount(1);
  });
});

describe("API", () => {
  test("checked, selected, a RegExp name, a right click, remove, and fill with nothing", async (page) => {
    await page.goto("/locators");
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(1);
    await expect(page.getByRole("checkbox", { checked: true })).toHaveAttribute("aria-label", "Checked box");
    await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
    await expect(page.getByRole("tab", { selected: false })).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("button", { name: /Bold|Disabled/g })).toHaveCount(2);
    await page.getByText("Right-click target").click({ button: "right" });
    await expect(page.getByText("Right-click target")).toHaveAttribute("data-menu", "opened");
    await page.locator("li").remove();
    await expect(page.locator("li")).toHaveCount(0);
    await page.getByLabel("Email address").fill("a@b.c");
    await page.getByLabel("Email address").fill("");
    await expect(page.getByLabel("Email address")).toHaveValue("");
    const scope = page.locator("#scope");
    await expect(scope.getByRole("button", { name: "Scoped button" })).toHaveCount(1);
    await expect(scope.getByLabel("Inner field")).toHaveAttribute("id", "inner");
    await expect(scope.getByPlaceholder("Scoped placeholder")).toHaveAttribute("id", "inner");
    await expect(scope.getByTestId("scoped")).toHaveCount(1);
    await expect(scope.getByText("out of scope")).toHaveCount(0);
    await page.locator("#editable").fill("new text");
    await expect(page.getByText("new text", { exact: true })).toHaveCount(1);
    await expect(page.getByText("old text")).toHaveCount(0);
  });

  /** Not to be confused with a state that doesn't hold: the element must exist. */
  test("a negated state assertion on a locator that matches nothing fails", async (page) => {
    await page.goto("/locators");
    await expect(expect(page.getByRole("button", { name: "No such button" })).not.toBeDisabled()).rejects.toThrow(
      'timed out after 15s waiting for expect(getByRole("button", {"name":"No such button"})).not.toBeDisabled()',
    );
  });

  test("the timezone, the locale (Intl, navigator.language, Accept-Language) and reduced motion are pinned", async (page) => {
    await page.goto("/environment");
    await expect(page.getByText("accept: en-US")).toBeVisible();
    await expect(
      page.getByText('{"timeZone":"UTC","locale":"en-US","language":"en-US","languages":["en-US"],"reducedMotion":true}'),
    ).toBeVisible();
  });

  test("a route handler sees the request's URL, method and lower-cased headers", async (page) => {
    page.route("**/api/items", (route) => {
      const request = route.request();
      const names = Object.keys(request.headers());
      route.fulfill({
        json: [`${request.method()} ${new URL(request.url()).pathname} lower:${names.every((name) => name === name.toLowerCase())} ua:${"user-agent" in request.headers()}`],
      });
    });
    await page.goto("/routed");
    await expect(page.getByText("GET /api/items lower:true ua:true")).toBeVisible();
  });

  test("a URL the page loaded twice is archived as it last answered", async (page) => {
    await page.goto("/reloaded-image");
    await page.waitUntil("the image", async () => (await page.locator("img").count()) === 1);
    // A second visit loads it again (no-store), and now it answers differently.
    await page.goto("/reloaded-image");
    await page.waitUntil("the image", async () => (await page.locator("img").count()) === 1);
  });

  test("a URL routed once, then left to the network, is archived as the network answered", async (page) => {
    const blue = new Uint8Array(await Bun.file(new URL("./assets/blue.png", import.meta.url)).arrayBuffer());
    let routed = false;
    page.route("**/routed-once.png", (route) => {
      if (routed) return route.fallback();
      routed = true;
      route.fulfill({ body: blue, contentType: "image/png", headers: { "cache-control": "no-store" } });
    });
    await page.goto("/routed-once-image");
    await page.waitUntil("the image", async () => (await page.locator("img").count()) === 1);
    await page.goto("/routed-once-image");
    await page.waitUntil("the image", async () => (await page.locator("img").count()) === 1);
  });

  test("an app's own data-vt-ref survives the capture", async (page) => {
    await page.goto("/marked");
    await expect(page.getByRole("heading", { name: "Marked" })).toBeVisible();
    await expect(page.getByText("App-owned mark")).toBeVisible();
    await page.locator("#counter").click();
    // Each copy the app makes of the marked counter, mark and all, goes before it, and is another element:
    // a query counts it,
    const copy = page.getByRole("button", { name: "Copy the counter" });
    await copy.click();
    await expect(page.getByRole("button", { name: "Count", exact: true })).toHaveCount(2);
    // a click aimed at the counter doesn't land on it,
    await copy.click();
    await page.locator("#counter").click();
    await expect(page.locator("#counter")).toHaveAttribute("data-clicks", "2");
    await expect(page.locator("#copy2")).toHaveAttribute("data-clicks", "1");
    // and the capture doesn't keep its mark.
    await copy.click();
  });

  test("a mark on an element the app detached during a capture doesn't outlive it", async (page) => {
    await page.goto("/marked");
    await expect(page.getByText("Panel text")).toBeVisible();
    const toggle = page.getByRole("button", { name: "Toggle panel" });
    await toggle.click();
    // A copy of a marked element, held detached across the capture too.
    await page.locator("#counter").click();
    await page.getByRole("button", { name: "Hold a copy" }).click();
    await takeSnapshot("panel detached");
    await toggle.click();
    await page.getByRole("button", { name: "Attach the copy" }).click();
    await expect(page.locator("#panel")).toHaveCount(1);
    await takeSnapshot("panel back");
  });

  test("an SVG document embedded in the page doesn't break the page script", async (page) => {
    await page.goto("/svg-embed");
    await page.waitUntil("the object", async () => (await page.locator("object").count()) === 1);
  });

  /** Role queries reach into open shadow roots; actions on what they find must too. */
  test("a role locator inside a shadow root is visible and clickable", async (page) => {
    await page.goto("/shadow");
    await expect(page.getByRole("button", { name: "Shadow button" })).toBeVisible();
    await page.getByRole("button", { name: "Shadow button" }).click();
    await expect(page.locator("shadow-host[data-clicked=yes]")).toHaveCount(1);
  });

  test("a goto that changes only the hash", async (page) => {
    await page.goto("/hash#first");
    await page.goto("/hash#second");
    await expect(page.getByText("hash #second")).toBeVisible();
  });

  test("a string timer handler runs", async (page) => {
    await page.goto("/string-timer");
    await expect(page.locator("body[data-ran=yes]")).toHaveCount(1);
  });

  test("a paused clock holds timers and Date until it resumes", async (page) => {
    await page.goto("/timers");
    await page.pauseClock();
    await page.getByRole("button", { name: "Start timer" }).click();
    await page.getByRole("button", { name: "Stamp" }).click();
    await Bun.sleep(300);
    await page.getByRole("button", { name: "Stamp" }).click();
    await page.getByRole("button", { name: "Start cancelable" }).click();
    await Bun.sleep(150);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Timer fired")).toHaveCount(0);
    await page.resumeClock();
    await expect(page.getByText("Timer fired")).toBeVisible();
    await Bun.sleep(200);
    await expect(page.getByText("Cancelled timer fired")).toHaveCount(0);
  });

  test("addStyleTag, a waitUntil timeout, and locator assertions counted by expect.assertions", async (page) => {
    expect.assertions(4);
    await page.goto("/");
    await page.addStyleTag({ content: "h1 { color: rgb(1, 2, 3); }" });
    await expect(page.getByRole("heading", { name: "Fixture home" })).toBeVisible();
    const started = Date.now();
    await expect(page.waitUntil("something that never happens", () => false, 300)).rejects.toThrow("timed out after 0.3s");
    await expect(page.waitUntil("a check that never settles", () => new Promise<boolean>(() => {}), 300)).rejects.toThrow(
      "timed out after 0.3s",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a repeated name gets #2", async (page) => {
    await page.goto("/");
    await takeSnapshot("same");
    await takeSnapshot("same");
  });

  test("declared twice", async (page) => void (await page.goto("/")));
  test("declared twice", async (page) => void (await page.goto("/")));

  describe("Outer", () => {
    describe("Inner", () => {
      test("deep", async (page) => void (await page.goto("/")));
    });
    test("after the inner describe", async (page) => void (await page.goto("/")));
  });

  test("per-test overrides", async (page) => void (await page.goto("/scheme")), {
    viewports: { "": { width: 500, height: 400 } },
    colorScheme: "dark",
  });
});

describe("Captures", { viewports: { "": { width: 800, height: 600 }, mobile: { width: 390, height: 844 } } }, () => {
  test("two viewports and a named snapshot", async (page) => {
    await page.goto("/");
    expect(await takeSnapshot("named")).toContain("::named");
  });
});

describe("Resources", () => {
  test("css, images, fonts, a background, a lazy image, cross-origin assets and a blob", async (page) => {
    await page.goto("/resources");
    await page.waitUntil("the blob image", async () => (await page.locator('#blob[src^="blob:"]').count()) === 1);
  });

  test("seeded Math.random, the same in every test", async (page) => {
    await page.goto("/random");
  });

  test("seeded Math.random, again", async (page) => {
    await page.goto("/random");
  });
});

describe("Options", { now: "2030-06-01T12:00:00Z" }, () => {
  beforeEach(async (page) => {
    await page.goto("/clock");
  });

  test("a describe's now, on a second document", async (page) => {
    await page.getByRole("link", { name: "next" }).click();
    await expect(page.getByRole("heading", { name: "Second document" })).toBeVisible();
  });
});

describe("Scheme", { colorScheme: "dark" }, () => {
  test("dark", async (page) => {
    await page.goto("/scheme");
    await expect(page.getByText("dark", { exact: true })).toBeVisible();
  });
});
