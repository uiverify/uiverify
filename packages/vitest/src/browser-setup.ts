import * as vitest from "vitest";
import { afterEach, beforeEach, inject } from "vitest";
import { server } from "vitest/browser";
import { beginNetworkTest, parkPointer, watchNetwork } from "./capture";
import { beginTest, captureEndOfTest, finishTest } from "./runtime";
import { hookWaitLimit } from "./wait-limit";
import {
  installRafProbe,
  installSeededRandom,
  preloadFonts,
  raiseResourceTimingBuffer,
  resetSeed,
} from "@uiverify/archive-core/browser";

// Flag the page as a UI Verify capture at RECORD time, as this setup module loads - before any test
// renders a component - so `isUIVerify()` is true while the app renders in the test browser (the
// record-side analog of the marker the capturer sets at replay). This is what makes author code like
// `isAnimationActive={!isUIVerify()}` actually disable the animation under capture.
//
// The global name is inlined rather than imported from `@uiverify/archive-core` on purpose: this file
// runs in the BROWSER, and a value import from archive-core's index (unlike its `/browser` subpath) pulls
// its Node `crypto` usage into the browser bundle ("crypto.createHash externalized"). Keep the literal equal
// to archive-core's `UI_VERIFY_GLOBAL`, which its test pins.
Reflect.set(globalThis, "__UI_VERIFY__", true);

// Lift the Resource Timing buffer's 250-entry cap before the app loads any modules (this module runs before
// any test renders), so no asset a capture rediscovers from Resource Timing is ever evicted.
raiseResourceTimingBuffer();

// Record what this test file's document loads from here on, so a capture archives the bytes the page received
// and can wait for its requests to finish. Before the test file's imports, so what they load is recorded too.
// The pointer is wherever the previous test file left it. After this it is parked only once a test has been
// captured and no concurrent test is still running (below), so no park ever runs alongside a test's hooks.
await Promise.all([watchNetwork(), parkPointer()]);

// Seed Math.random at record time, before any component renders, so a random-paced pick (a shuffled list,
// a randomly chosen image) is deterministic in the archive: the archive is a static snapshot, so whatever
// the pick produced at capture is what's baked in.
installSeededRandom();

// Track the app's requestAnimationFrame callbacks from before any component renders, so a capture can wait
// for a JS-driven animation (a recharts line-draw) to reach its last frame instead of archiving a frame
// mid-tween.
installRafProbe();

/**
 * The setup file `uiverifyPlugin()` injects into every browser-mode test run. It is what turns the bare
 * plugin install into "each test archives its final DOM": a `beforeEach` marks the current test, and the
 * automatic snapshot is taken as the test body finishes, before the test's `afterEach` hooks where the
 * runner allows it (see {@link captureBeforeOtherHooks}). It carries no per-test boilerplate for the user.
 */
declare module "vitest" {
  interface ProvidedContext {
    __uiverify: { disableAutoSnapshot: boolean; networkIdleTimeout: number };
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

/** The runner's hook registry, exposed as `TestRunner.getSuiteHooks` from Vitest 4.1. It returns the
 *  suite's live hook lists, which the runner reads when the test finishes. */
interface HookRegistry {
  getSuiteHooks(suite: object): unknown;
}

function isHookRegistry(value: unknown): value is HookRegistry {
  return typeof value === "function" && typeof Reflect.get(value, "getSuiteHooks") === "function";
}

function isHookList(value: unknown): value is Array<() => unknown> {
  return Array.isArray(value);
}

const runnerApi: unknown = Reflect.get(vitest, "TestRunner");
const hookRegistry = isHookRegistry(runnerApi) ? runnerApi : undefined;

/** Tests whose automatic snapshot is taken by the hook {@link captureBeforeOtherHooks} installed. */
const hookedTests = new WeakSet<object>();

type TestContext = {
  task: { suite?: object; file?: object; concurrent?: boolean; result?: { state?: string } };
  onTestFinished(fn: () => unknown): void;
};

/** Install the automatic snapshot as the first `afterEach` to run for this test, so it captures the page
 *  as the test body left it. Every other `afterEach` is teardown (testing-library's automatic `cleanup`, an
 *  unmount, a store reset), and the order of hooks registered with `afterEach()` depends on where each was
 *  registered, so a capture running among them would see an empty page in some suites and not others. The
 *  innermost suite's hooks run first; the runner reads them in reverse under the default
 *  `sequence.hooks: "stack"` and in order under `"list"`. Under `"parallel"` all hooks run at once, so no
 *  position runs first and the setup-file hook below is used instead, as it is for a concurrent test. */
function captureBeforeOtherHooks(registry: HookRegistry, ctx: TestContext): void {
  const order = server.config.sequence.hooks;
  // Concurrent tests share the suite's hook list, and under "list" the runner walks it while other tests
  // would be adding and removing their hooks.
  if (order === "parallel" || ctx.task.concurrent) return;
  const suite = ctx.task.suite ?? ctx.task.file;
  const hooks = suite ? registry.getSuiteHooks(suite) : undefined;
  const afterEachHooks: unknown = typeof hooks === "object" && hooks ? Reflect.get(hooks, "afterEach") : undefined;
  if (!isHookList(afterEachHooks)) return;
  const hook = () => captureEndOfTest(ctx.task.result?.state !== "fail", !globalAutoDisabled());
  if (order === "list") afterEachHooks.unshift(hook);
  else afterEachHooks.push(hook);
  // Removed once every hook has run: under "list" the runner iterates this very array, so removing it
  // from inside the hook would skip the next one.
  ctx.onTestFinished(() => {
    const at = afterEachHooks.indexOf(hook);
    if (at !== -1) afterEachHooks.splice(at, 1);
  });
  hookedTests.add(ctx.task);
}

/** Concurrent tests still running, any of which may be hovering with the shared pointer. */
let concurrentRunning = 0;

beforeEach(async (ctx) => {
  resetSeed();
  // Preload fonts before the test renders, so a component that measures text width on mount (e.g. a
  // sliding tab/switch highlight) sees the real font metrics on its first layout - a mid-load font would
  // otherwise bake a 1px-shifted position that settling after render can't undo. The test's CSS is
  // already imported by now (module load precedes beforeEach), so the @font-faces are registered.
  await preloadFonts();
  beginTest(ctx.task);
  await beginNetworkTest();
  if (hookRegistry) captureBeforeOtherHooks(hookRegistry, ctx);
  // Written once every `afterEach` has run, so a hook that takes a snapshot of its own, or calls
  // `disableAutoSnapshot()`, still decides whether the automatic one is kept. The pointer is parked after that
  // rather than before the next test, so a hover made in a `beforeEach` (even under `sequence.hooks:
  // "parallel"`) is never undone, and only once no concurrent test is still running, since moving it would
  // un-hover a sibling mid-test.
  if (ctx.task.concurrent) concurrentRunning++;
  ctx.onTestFinished(async () => {
    try {
      await finishTest(ctx.task.result?.state !== "fail", ctx.task.concurrent);
    } finally {
      if (ctx.task.concurrent) concurrentRunning--;
      if (concurrentRunning === 0) await parkPointer();
    }
  });
});

// Where the hook above can't be installed (Vitest before 4.1 exposes no hook registry, hooks run in
// parallel, or the test is concurrent), the snapshot is taken by this setup-file hook instead, which under
// the default "stack" order runs after any `afterEach` the test file registered.
afterEach(async (ctx) => {
  if (hookedTests.has(ctx.task)) return;
  await captureEndOfTest(ctx.task.result?.state !== "fail", !globalAutoDisabled(), ctx.task.concurrent, hookWaitLimit(server.config.hookTimeout));
});
