<div align="center">

<a href="https://uiverify.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://uiverify.ai/brand/logo-mark-dark.png" />
    <img src="https://uiverify.ai/brand/logo-mark-light.png" alt="UI Verify" width="96" height="96" />
  </picture>
</a>

# UI Verify

### Visual testing for agents

Catch unintended UI changes on every pull request. UI Verify renders your components in the cloud, diffs them against a baseline, and lets a coding agent triage what actually changed.

[![uiverify](https://img.shields.io/npm/v/uiverify?label=uiverify&color=2ea44f)](https://www.npmjs.com/package/uiverify)
[![@uiverify/playwright](https://img.shields.io/npm/v/@uiverify/playwright?label=%40uiverify%2Fplaywright&color=2ea44f)](https://www.npmjs.com/package/@uiverify/playwright)
[![@uiverify/vitest](https://img.shields.io/npm/v/@uiverify/vitest?label=%40uiverify%2Fvitest&color=2ea44f)](https://www.npmjs.com/package/@uiverify/vitest)
[![@uiverify/bun](https://img.shields.io/npm/v/@uiverify/bun?label=%40uiverify%2Fbun&color=2ea44f)](https://www.npmjs.com/package/@uiverify/bun)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/uiverify/uiverify/blob/main/LICENSE)

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Vitest SDK](https://www.npmjs.com/package/@uiverify/vitest) &nbsp;·&nbsp; [Bun SDK](https://www.npmjs.com/package/@uiverify/bun) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills)

</div>

---

# @uiverify/playwright

The UI Verify capture SDK for Playwright.

Swap one import in your Playwright specs and every test also becomes a visual-regression test: the SDK archives each test's final UI state (the serialized DOM via [rrweb](https://github.com/rrweb-io/rrweb) plus the bytes of every resource the page loaded), and UI Verify replays that archive and pixel-diffs it, with an AI intended-vs-regression review. No extra setup: the archive is captured straight from the tests you already run.

```ts
// before
import { test, expect } from "@playwright/test";
// after
import { test, expect } from "@uiverify/playwright";
```

That's it, each test auto-archives its final state. To capture intermediate/named states:

```ts
import { test, expect } from "@uiverify/playwright";

test("checkout flow", async ({ page, uiVerify }) => {
  await page.goto("/cart");
  await uiVerify.snapshot("cart");
  await page.click("#checkout");
  await expect(page.locator("#confirm")).toBeVisible();
  // final state auto-archived at test end
});
```

Then upload the archive with the `uiverify` CLI (it assembles the bundle manifest itself):

```bash
playwright test                          # archives land in uiverify-archive/ (UIVERIFY_ARCHIVE_DIR)
uiverify upload --static-dir uiverify-archive
```

Every test renders on each upload unless the archive carries a module graph. To have UI Verify skip the tests a change can't reach, put a `preview-stats.json` in the archive directory before uploading, in the [module graph format](https://uiverify.ai/docs/skip-unchanged#module-graph-format). Each snapshot records its spec file relative to the Playwright config's directory, so list your spec files as modules in the graph.

## How it works

Capture is single-browser: it waits for a stable frame (see Notes), serializes the DOM (scripts stripped, so the app's JS never re-runs on replay) and buffers resource bytes. The rest of the fidelity work (cross-browser, the render's own determinism, the diff, the AI review) happens in UI Verify, off the archive. This package talks to nothing at runtime; it only writes an archive directory the CLI uploads.

## Notes

- **Peer dependency:** `@playwright/test` (>= 1.40).
- **Every snapshot waits for a stable frame.** Before it archives, a snapshot waits for `requestAnimationFrame` animations (a chart's line-draw, a framer-motion entry) to reach their last frame, for fonts and images to load (`loading="lazy"` images below the fold included, so they replay instead of showing broken; their `loading` attribute is put back once the snapshot is taken, but the images stay loaded, so take a mid-test snapshot after any assertion about your own lazy loading), and for the page size to stop changing. Each wait has a deadline, so an animation that never ends is captured as it is after about 4 seconds (sooner when the test is close to its timeout, so the wait never times a test out), with a warning naming the snapshot; stop it while UI Verify captures with `isUIVerify()`. `uiVerify.snapshot(name, { waitForStableFrame: false })` skips the animation and layout wait (fonts and images still load).
- **Content that loads on scroll** (an infinite list, an IntersectionObserver that mounts a section) is not in the DOM until the test scrolls to it, so scroll there before the snapshot.
- **Animations:** CSS animations freeze on replay.
- The test fixture is exposed as `uiVerify` (`async ({ page, uiVerify })`).
