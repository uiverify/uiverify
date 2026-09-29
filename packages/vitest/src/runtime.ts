import { capture } from "./capture";
import type { DesignImage } from "./design";
import type { TaskLike } from "./snapshot-id";

/**
 * Per-test capture state, shared between the public `takeSnapshot`/`disableAutoSnapshot` API (called
 * from inside a test) and the setup hooks (which begin each test and take the automatic end-of-test
 * snapshot). Browser-mode tests in a file run sequentially in one realm, so module-level state is safe:
 * `beginTest` resets it before each test, and only one test is ever "current".
 */
let currentTask: TaskLike | null = null;
let manualCount = 0;
let autoDisabledForTest = false;

/** Reset state and mark `task` current. Called by the setup hook before each test. */
export function beginTest(task: TaskLike): void {
  currentTask = task;
  manualCount = 0;
  autoDisabledForTest = false;
}

/** Archive the page's current DOM as a named snapshot mid-test. Counts as a manual snapshot, so the
 *  automatic end-of-test snapshot is suppressed (the test is capturing deliberately). `baselineImage` is a
 *  design PNG to compare against until a render is accepted: an image import (`import design from
 *  "./home.png"`, passed as-is) or a PNG data URI. `takeSnapshot("", { baselineImage })` keeps the
 *  auto-snapshot's id. */
export async function takeSnapshot(name = "", options: { baselineImage?: DesignImage } = {}): Promise<string> {
  if (!currentTask) {
    throw new Error(
      "@uiverify/vitest: takeSnapshot() was called outside a test. Add uiverifyPlugin() to your vitest.config so the setup hooks run.",
    );
  }
  manualCount++;
  return capture(currentTask, name, options);
}

/** Turn off the automatic end-of-test snapshot for the current test only. */
export function disableAutoSnapshot(): void {
  autoDisabledForTest = true;
}

/** Take the automatic end-of-test snapshot, unless the test opted out, already captured manually, or did
 *  not pass (we never baseline a broken/aborted UI). Called by the setup hook after each test. */
export async function autoSnapshot(passed: boolean): Promise<void> {
  if (!currentTask || autoDisabledForTest || manualCount > 0 || !passed) return;
  await capture(currentTask, "");
}
