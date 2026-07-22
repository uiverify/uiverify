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
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/uiverify/uiverify/blob/main/LICENSE)

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills)

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

## How it works

Capture is deliberately cheap and single-browser: it just serializes the DOM (scripts stripped, so the app's JS never re-runs on replay) and buffers resource bytes. All the fidelity work (determinism, cross-browser, the diff, the AI review) happens in UI Verify, off the archive. This package talks to nothing at runtime; it only writes an archive directory the CLI uploads.

## Notes

- **Peer dependency:** `@playwright/test` (>= 1.40).
- **Load the assertions you'll snapshot.** Below-the-fold lazy images / content must be loaded (e.g. scroll) before the snapshot, or they replay blank.
- **Animations:** CSS animations freeze on replay; JS/`requestAnimationFrame`-driven animation is captured at whatever frame is on screen, so pause it (or use `prefers-reduced-motion`) at the snapshot point for stable diffs.
- The test fixture is exposed as `uiVerify` (`async ({ page, uiVerify })`).
