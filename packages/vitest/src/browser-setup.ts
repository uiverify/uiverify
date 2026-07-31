import { afterEach, beforeEach, inject } from "vitest";
import { autoSnapshot, beginTest } from "./runtime";

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
