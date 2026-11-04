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

# @uiverify/vitest

Vitest browser-mode capture SDK for [UI Verify](https://uiverify.ai) - visual regression testing for agent-written UI, and an alternative to Chromatic and Percy.

Add one plugin to your Vitest config and every browser-mode test archives its final DOM (the serialized DOM plus the bytes of every resource it uses). UI Verify re-renders and pixel-diffs that archive in the cloud, so you get deterministic, cross-browser visual tests from the component tests you already have - no Storybook required.

## Requirements

- Vitest 4 or 5 in **browser mode** on the Playwright provider (`@vitest/browser-playwright`) with Chromium.

## Install

```bash
npm i -D @uiverify/vitest @vitest/browser-playwright
```

## Configure

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { uiverifyPlugin } from "@uiverify/vitest/plugin";

export default defineConfig({
  plugins: [uiverifyPlugin()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
```

That is the whole setup. Every browser-mode test now archives its final rendered DOM.

## Capture points

```ts
import { test } from "vitest";
import { render } from "vitest-browser-react"; // or your framework's browser render helper
import { takeSnapshot, disableAutoSnapshot } from "@uiverify/vitest";

test("menu", async () => {
  await render(<Menu />); // render() is async - await it so the DOM is committed before capture
  await takeSnapshot("closed"); // optional named checkpoint
});

test("footer", async () => {
  await render(<Footer />);
  // no takeSnapshot(): the final state is archived automatically at the end of the test
});
```

- `takeSnapshot(name?, { baselineImage?, waitForStableFrame? })` - archive the current DOM as a named checkpoint. A test that
  calls it is not also auto-snapshotted at the end. `baselineImage` is a design PNG to compare against until
  a render is accepted: an image import passed as-is (`import design from "./home.png"`), or a
  `data:image/png;base64,...` string. `takeSnapshot("", { baselineImage })` keeps the test's usual snapshot id.
  `waitForStableFrame: false` captures the page as it is right now (see below).
- `disableAutoSnapshot()` - opt the current test out of the automatic end-of-test snapshot (or pass `disableAutoSnapshot: true` to `uiverifyPlugin()` to turn it off for every test).

On Vitest 4.1 and later the automatic snapshot is taken as soon as the test body finishes, before your `afterEach` hooks run, so a cleanup hook can't empty the page first (except for concurrent tests and with `sequence.hooks: "parallel"`, where hooks have no order). Wait for the page to settle inside the test; a wait in an `afterEach` comes too late unless that hook calls `takeSnapshot()` itself (or `disableAutoSnapshot()`). A failed test is captured too, so its UI shows up in the build instead of vanishing from it. Always `await takeSnapshot()`: a call still running when the test ends fails the test.

With the Playwright provider on Chromium, every snapshot, automatic or `takeSnapshot()`, first waits for the test's network requests to finish: it is taken once nothing has been loading for 100 ms, so data a component fetches after `render()`, and the images it then shows, make it into the snapshot without an extra wait in the test. The wait gives up after `networkIdleTimeout` (5 s by default), never fails the test, and prints which request was still loading. A request that never finishes (a stream, a long poll, a mock with an infinite delay) is waited for once per test that starts it, so mock it in the test or lower `networkIdleTimeout`. Two consequences worth knowing when you upgrade: a test that snapshots a loading state against a mock with a finite delay now captures the loaded state, and a test that keeps a request pending on purpose to show a skeleton spends `networkIdleTimeout` once. Lazy chunks a component imports after render are not waited for, and React Suspense can reveal content after the network has gone quiet: await the content in the test (`await expect.element(...)`) in both cases.

Every snapshot, automatic or not, waits for the next stable frame before it archives: a `requestAnimationFrame` animation (a chart's line-draw, a framer-motion entry) runs to its last frame, fonts and images finish loading, and the page size stops changing. Each wait has a deadline, so an animation that never ends is captured as it is after about 4 seconds (sooner when the test is close to its timeout, so the wait never times a test out), with a warning saying which snapshot. `takeSnapshot(name, { waitForStableFrame: false })` skips the animation and layout wait (fonts and images still load).

A snapshot keeps the interactive state the test left the page in: an element it hovered (`userEvent.hover`), focused (`.focus()`, keyboard navigation, typing into it) or is pressing renders hovered, focused or pressed, focus ring included. With the Playwright provider, the plugin moves the pointer off the page when a test file starts and after each test is captured, so a snapshot shows only the hover its own test made, never one left behind by an earlier test. That includes a hover set up in a `beforeAll`: it holds for the first test only, so hover in a `beforeEach` to have it in every test. Concurrent tests share one pointer, so the plugin parks it only once none of them is still running: a concurrent test that hovers can show up hovered in a sibling's snapshot. Worth knowing when you upgrade: a test that ends right after `userEvent.click()` leaves the pointer over what it clicked, and one that ends after `click()`, `type()` or `fill()` leaves that element focused, so those snapshots now show its hover and focus styles (and the focus ring, for a text field or keyboard focus). To capture it idle, call the element's `.blur()` and hover something that has no hover style (`userEvent.unhover()` hovers the middle of the page body, which can be the component again).

Each snapshot's id is the test file, the `describe` names and the test name (plus `::name` for a named checkpoint). Tests that share all of those get ` (2)`, ` (3)` and so on by their order in the file, and a test that takes two snapshots with the same name gets ` #2` on the second. Ids don't include the Vitest project: running the same tests in several browser projects or `browser.instances` into one archive folder keeps one capture per test and prints a warning.

## Upload

Archives are written to `./uiverify-archive` (override with `UIVERIFY_ARCHIVE_DIR` or the plugin's `outDir`). Each run first clears the previous run's archive there, so snapshots of deleted tests don't get uploaded; anything else in the folder is left alone. After your run, upload with the [`uiverify`](https://www.npmjs.com/package/uiverify) CLI:

```bash
npx playwright install --with-deps   # one-time: browsers for Vitest browser mode
npx vitest run
UIVERIFY_API_KEY=your_key npx -y uiverify@latest upload --static-dir ./uiverify-archive
```

Only the tests your change could affect render; the rest keep their baselines. The plugin writes the module graph that makes this possible (`preview-stats.json`) into the archive when the project is a git checkout, after checking each test's imports against git. A test whose imports pass through files git doesn't track (bundler output, a workspace package's built `dist/`, gitignored generated code), or that imports no tracked source, is left out of the graph and renders on every upload; the run prints `[uiverify] The tests in N file(s) always render: ...` with the reason.

## Options

```ts
uiverifyPlugin({
  outDir: "./uiverify-archive", // where archives are written
  disableAutoSnapshot: false,   // capture only via takeSnapshot() when true
  networkIdleTimeout: 5000,     // ms a snapshot waits for the test's requests to finish; 0 skips the wait
});
```

## How it works

In Vitest browser mode the test runs inside the page, so the DOM is serialized in the same realm with [`rrweb-snapshot`](https://www.npmjs.com/package/rrweb-snapshot). With the Playwright provider on Chromium, the plugin also records, on the Node side, the bytes of every image, font, stylesheet and media file each test file's page received, so the archive holds what the page showed rather than a second download (which a one-time, signed or changing URL would answer differently). The resources that DOM uses (images, fonts, stylesheets and what they reference) come from that recording first, and are otherwise fetched, from Node when the page can't read them (a cross-origin image with no CORS headers), with a warning naming any that still can't be archived; and a Vitest browser command writes the snapshot JSON to disk, each resource stored once per archive in its `resources/` folder however many snapshots share it. Nothing runs at runtime beyond your test - the CLI uploads the archive folder as is.

## License

MIT
