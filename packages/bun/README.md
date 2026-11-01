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

# @uiverify/bun

The [UI Verify](https://uiverify.ai) capture SDK for Bun. Visual tests run on `bun test` and drive the
Chrome you have installed through `Bun.WebView`; each test archives its final page (the serialized DOM plus
the bytes of its images, fonts and stylesheets) for UI Verify to replay and diff. It talks to nothing at
runtime: `uiverify upload --static-dir uiverify-archive` ships the archive.

Needs Bun 1.3.12 or later and Google Chrome or Chromium (`BUN_CHROME_PATH` points at another).

```sh
bun add -d @uiverify/bun
```

## A suite and a test

```ts
// tests/visual/fixtures.ts
import { DEFAULT_VIEWPORT, defineSuite } from "@uiverify/bun";

export const visualSuite = defineSuite(
  { viewports: { "": DEFAULT_VIEWPORT, mobile: { width: 390, height: 844 } } },
  (page) => {
    // Runs at the start of every test.
    page.route("**/api/flags", (route) => route.fulfill({ json: { newCheckout: false } }));
  },
);

// tests/visual/home.visual.ts
import { expect, takeSnapshot } from "@uiverify/bun";
import { visualSuite } from "./fixtures";

const { describe, test } = visualSuite(import.meta.path);

describe("Home", () => {
  test("signed out", async (page) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  });

  test("menu", async (page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).click();
    await takeSnapshot("open");
  });
});
```

A test that never calls `takeSnapshot()` is snapshotted once when it ends. Each viewport entry runs the test
once; a snapshot's id is `<file> > <describe>… > <test>`, plus `::<name>` and `::<viewport key>`.

`expect` is `bun:test`'s, with retrying assertions for a locator (`toBeVisible`, `toBeAttached`,
`toHaveCount`, `toBeDisabled`, `toHaveValue`, `toHaveAttribute`, and `.not`). Await them, and pass them a
locator: with `@testing-library/jest-dom`'s types installed, `expect(element).toBeVisible()` on a DOM element
is jest-dom's matcher.

## Running

```ts
// tests/visual/run.ts — `bun tests/visual/run.ts [files…] [-t <name pattern>]`
import { run } from "@uiverify/bun/run";

process.exitCode = await run({
  shards: { "tests/visual/home.visual.ts": 2 },
  webServer: { command: ["bun", "server.ts"], port: 3000, ready: "Listening" },
});
```

`run()` starts the web servers (with `PORT` and `UI_VERIFY=1` set), runs every `*.visual.ts` in its own
`bun test` process, and writes the archive's index. Its test processes ignore the app's `bunfig.toml` (a test
preload such as happy-dom replaces `fetch`), so fixtures must not import modules that need a loader or
`define` registered there.

## What every capture pins

The page clock starts at the suite's `now` (default `2026-01-01T00:00:00Z`, read as UTC unless it names an
offset) and runs until `page.pauseClock()`; `Math.random` is seeded; animations and transitions finish
instantly; the timezone is UTC, the locale en-US, motion reduced, and the colour scheme the suite's
`colorScheme`. Before a snapshot it waits up to 3 s for the fonts in use, then up to 3 s for every image and CSS
background to load, then for the page to stop moving: a page whose elements keep moving (a `requestAnimationFrame` loop,
a Lottie) fails after 10 s. A canvas that keeps redrawing in place isn't detected and is captured mid-frame.
Stop either while UI Verify captures, by checking `isUIVerify()`.

Each test starts on a blank page with no routes or init scripts, the storage of every origin the previous
test requested cleared, no cookies and no history. Chrome's caches persist, but a route always sees the
requests of a test's first page; a second `goto` in the same test may take assets from memory, so register
routes before the first.

## Notes

- `page.addInitScript(fn)` sends `fn` as source: it can't use variables from around it.
- `serveBundle({ entrypoint, plugins, define })` builds and serves a component page. `Bun.build` inlines no
  env, so a `process.env.PUBLIC_*` the components read goes in `define`. Fonts are waited for once they are in
  use: a component that measures its text on mount should have its entry await `document.fonts.load(…)` before
  rendering.
- A tab the page opens (a `target=_blank` link, `window.open`) is closed at once; the test stays on its page.
- A cross-site iframe runs in a process of its own: its requests aren't routed, it gets no init scripts or
  clock, and its storage isn't reset between tests.
- Capture in CI on Linux: a baseline captured on a Mac renders text differently.
