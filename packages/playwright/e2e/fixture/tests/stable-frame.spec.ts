import { expect, test } from "@uiverify/playwright";

/** A 1x1 PNG, so the image really loads. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/** A rAF-driven tween like recharts' line-draw: writes its progress every frame, then "done" on its last. */
const ANIMATION = `<p id="out"></p><script>
  let step = 0;
  const tick = () => {
    step++;
    out.textContent = step < 40 ? "frame " + step : "done";
    if (step < 40) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
</script>`;

/** The same tween, scheduled through a requestAnimationFrame saved when the page loads, as framer-motion's
 *  frame loop does: only a probe installed before the page's scripts sees its frames. */
const SAVED_RAF_ANIMATION = ANIMATION.replace("<script>", "<script>const raf = requestAnimationFrame;").replaceAll(
  "requestAnimationFrame(tick)",
  "raf(tick)",
);

test.beforeEach(async ({ page }) => {
  await page.route("https://assets.test/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("https://app.test/", (route) => route.fulfill({ contentType: "text/html", body: ANIMATION }));
  await page.route("https://app.test/empty", (route) =>
    route.fulfill({ contentType: "text/html", body: '<p id="out"></p>' }),
  );
  await page.route("https://app.test/saved", (route) =>
    route.fulfill({ contentType: "text/html", body: SAVED_RAF_ANIMATION }),
  );
});

test("lazy image below the fold", async ({ page }) => {
  await page.setContent(
    '<div style="height: 8000px"></div><img loading="lazy" src="https://assets.test/below.png" width="10" height="10">',
  );
});

test("lazy image below the fold, captured right now", async ({ page, uiVerify }) => {
  await page.setContent(
    '<div style="height: 8000px"></div><img loading="lazy" src="https://assets.test/right-now.png" width="10" height="10">',
  );
  await uiVerify.snapshot("", { waitForStableFrame: false });
});

test("finite animation", async ({ page }) => {
  await page.goto("https://app.test/");
});

test("finite animation through a saved requestAnimationFrame", async ({ page }) => {
  await page.goto("https://app.test/saved");
});

test("finite animation, page set by content", async ({ page }) => {
  await page.setContent(ANIMATION);
});

test("finite animation under a running clock", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2024-01-01T00:00:00Z"));
  await page.goto("https://app.test/");
});

test("finite animation under a clock installed after the page loaded", async ({ page }) => {
  await page.goto("https://app.test/empty");
  await page.clock.install();
  await page.evaluate(() => {
    const out = document.getElementById("out");
    let step = 0;
    const tick = () => {
      step++;
      if (out) out.textContent = step < 40 ? `frame ${step}` : "done";
      if (step < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
});

test("lazy image restored after a snapshot", async ({ page, uiVerify }) => {
  await page.setContent(
    '<div style="height: 8000px"></div><img loading="lazy" src="https://assets.test/restored.png" width="10" height="10">',
  );
  // A second lazy image, mounted by an animation while the snapshot waits for it to finish.
  await page.evaluate(() => {
    let step = 0;
    const tick = () => {
      if (++step < 20) return void requestAnimationFrame(tick);
      document.body.insertAdjacentHTML("beforeend", '<img loading="lazy" src="https://assets.test/late.png" width="10" height="10">');
    };
    requestAnimationFrame(tick);
  });
  await uiVerify.snapshot("mid-test");
  await expect(page.locator("img")).toHaveCount(2);
  for (const img of await page.locator("img").all()) await expect(img).toHaveAttribute("loading", "lazy");
});

test("finite animation, captured right now", async ({ page, uiVerify }) => {
  await page.setContent(ANIMATION);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await uiVerify.snapshot("", { waitForStableFrame: false });
});

test("endless animation", async ({ page }) => {
  await page.setContent(`<p id="out"></p><script>
    let step = 0;
    const tick = () => {
      out.textContent = "frame " + ++step;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  </script>`);
});

test("endless animation, several snapshots", async ({ page, uiVerify }) => {
  test.setTimeout(15_000);
  await page.setContent(`<p id="out"></p><script>
    let step = 0;
    const tick = () => {
      out.textContent = "frame " + ++step;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  </script>`);
  for (const name of ["one", "two", "three", "four", "five"]) await uiVerify.snapshot(name);
});

test("paused clock, page set by content", async ({ page }) => {
  await page.clock.install({ time: new Date("2024-01-01T00:00:00Z") });
  await page.setContent("<p>frozen</p>");
  await page.clock.pauseAt(new Date("2024-01-02T00:00:00Z"));
});

test("paused clock, page navigated", async ({ page }) => {
  await page.clock.install({ time: new Date("2024-01-01T00:00:00Z") });
  await page.goto("https://app.test/");
  await page.clock.pauseAt(new Date("2024-01-02T00:00:00Z"));
});
