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

- `takeSnapshot(name?, { baselineImage? })` - archive the current DOM as a named checkpoint. A test that
  calls it is not also auto-snapshotted at the end. `baselineImage` is a design PNG to compare against until
  a render is accepted: an image import passed as-is (`import design from "./home.png"`), or a
  `data:image/png;base64,...` string. `takeSnapshot("", { baselineImage })` keeps the test's usual snapshot id.
- `disableAutoSnapshot()` - opt the current test out of the automatic end-of-test snapshot (or pass `disableAutoSnapshot: true` to `uiverifyPlugin()` to turn it off for every test).

On Vitest 4.1 and later the automatic snapshot is taken as soon as the test body finishes, before your `afterEach` hooks run, so a cleanup hook can't empty the page first (except for concurrent tests and with `sequence.hooks: "parallel"`, where hooks have no order). Wait for the page to settle inside the test; a wait in an `afterEach` comes too late unless that hook calls `takeSnapshot()` itself (or `disableAutoSnapshot()`). A failed test is captured too, so its UI shows up in the build instead of vanishing from it. Always `await takeSnapshot()`: a call still running when the test ends fails the test.

Each snapshot's id is the test file, the `describe` names and the test name (plus `::name` for a named checkpoint). Tests that share all of those get ` (2)`, ` (3)` and so on by their order in the file, and a test that takes two snapshots with the same name gets ` #2` on the second. Ids don't include the Vitest project: running the same tests in several browser projects or `browser.instances` into one archive folder keeps one capture per test and prints a warning.

## Upload

Archives are written to `./uiverify-archive` (override with `UIVERIFY_ARCHIVE_DIR` or the plugin's `outDir`). Each run first clears the previous run's archive there, so snapshots of deleted tests don't get uploaded; anything else in the folder is left alone. After your run, upload with the [`uiverify`](https://www.npmjs.com/package/uiverify) CLI:

```bash
npx playwright install --with-deps   # one-time: browsers for Vitest browser mode
npx vitest run
UIVERIFY_API_KEY=your_key npx -y uiverify@latest upload --static-dir ./uiverify-archive
```

## Options

```ts
uiverifyPlugin({
  outDir: "./uiverify-archive", // where archives are written
  disableAutoSnapshot: false,   // capture only via takeSnapshot() when true
});
```

## How it works

In Vitest browser mode the test runs inside the page, so the DOM is serialized in the same realm with [`rrweb-snapshot`](https://www.npmjs.com/package/rrweb-snapshot); the resources that DOM uses (images, fonts, stylesheets and what they reference) are fetched, from Node when the page can't read them (a cross-origin image with no CORS headers), with a warning naming any that still can't be archived; and a Vitest browser command writes the snapshot JSON to disk, each resource stored once per archive in its `resources/` folder however many snapshots share it. Nothing runs at runtime beyond your test - the CLI uploads the archive folder as is.

## License

MIT
