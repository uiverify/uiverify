import { afterEach, beforeEach, inject } from "vitest";
import { autoSnapshot, beginTest } from "./runtime";

// Flag the page as a UI Verify capture at RECORD time, as this setup module loads - before any test
// renders a component - so `isUIVerify()` is true while the app renders in the test browser (the
// record-side analog of the marker the capturer sets at replay). This is what makes author code like
// `isAnimationActive={!isUIVerify()}` actually disable the animation under capture.
//
// The global name is inlined rather than imported from `@uiverify/archive-core` on purpose: this file
// runs in the BROWSER, and a value import from archive-core's index pulls its Node `crypto` usage into
// the browser bundle ("crypto.createHash externalized"). Keep the literal equal to archive-core's
// `UI_VERIFY_GLOBAL`, which its test pins.
Reflect.set(globalThis, "__UI_VERIFY__", true);

/**
 * The setup file `uiverifyPlugin()` injects into every browser-mode test run. It is what turns the bare
 * plugin install into "each test archives its final DOM": a `beforeEach` marks the current test, and an
 * `afterEach` takes the automatic snapshot. It carries no per-test boilerplate for the user.
 */
declare module "vitest" {
  interface ProvidedContext {
    __uiverify: { disableAutoSnapshot: boolean };
  }
}

/** The plugin's global `disableAutoSnapshot` option, passed through Vitest's provide/inject. Best-effort:
 *  if it is unavailable the default (auto-snapshot on) applies, and per-test `disableAutoSnapshot()` still
 *  works regardless. */
function globalAutoDisabled(): boolean {
  try {
    return Boolean(inject("__uiverify")?.disableAutoSnapshot);
  } catch {
    return false;
  }
}

beforeEach((ctx) => {
  beginTest(ctx.task);
});

afterEach(async (ctx) => {
  if (globalAutoDisabled()) return;
  // Skip a failed test: `result.state` is set by the time afterEach runs; anything but an explicit
  // "fail" is treated as passing (a missing result should not silently drop the snapshot).
  const passed = ctx.task.result?.state !== "fail";
  await autoSnapshot(passed);
});
