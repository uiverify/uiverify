# @uiverify/vitest

Vitest browser-mode capture SDK for [UI Verify](https://uiverify.ai) - visual regression testing for agent-written UI, and an alternative to Chromatic and Percy.

Add one plugin to your Vitest config and every browser-mode test archives its final DOM (the serialized DOM plus the bytes of every resource the page loaded). UI Verify re-renders and pixel-diffs that archive in the cloud, so you get deterministic, cross-browser visual tests from the component tests you already have - no Storybook required.

## Requirements

- Vitest 4 in **browser mode** on the Playwright provider (`@vitest/browser-playwright`) with Chromium.

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
  render(<Menu />);
  await takeSnapshot("closed"); // optional named checkpoint
  // the final state is archived automatically at the end of the test
});
```

- `takeSnapshot(name?)` - archive the current DOM as a named checkpoint mid-test.
- `disableAutoSnapshot()` - opt the current test out of the automatic end-of-test snapshot (or pass `disableAutoSnapshot: true` to `uiverifyPlugin()` to turn it off for every test).

## Upload

Archives are written to `./uiverify-archive` (override with `UIVERIFY_ARCHIVE_DIR` or the plugin's `outDir`). After your run, upload with the [`uiverify`](https://www.npmjs.com/package/uiverify) CLI:

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

In Vitest browser mode the test runs inside the page, so the DOM is serialized in the same realm with [`rrweb-snapshot`](https://www.npmjs.com/package/rrweb-snapshot); the resources the page loaded are fetched and base64-encoded; and the assembled archive is written to disk by a Vitest browser command. Nothing runs at runtime beyond your test - the archive is a plain JSON bundle the CLI uploads.

## License

MIT
