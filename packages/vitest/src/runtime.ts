import type { CapturedSnapshot } from "@uiverify/archive-core";
import { capture, writeCaptured } from "./capture";
import type { DesignImage } from "./design";
import { snapshotIds, type TaskLike } from "./snapshot-id";

/**
 * Per-test capture state, shared between the public `takeSnapshot`/`disableAutoSnapshot` API (called
 * from inside a test) and the setup hooks (which begin each test, take the automatic end-of-test
 * snapshot, and write it once the test has finished). Browser-mode tests in a file run sequentially in one
 * realm, so module-level state is safe: `beginTest` resets it before each test (and each retry), and only
 * one test is ever "current".
 */
let currentTask: TaskLike | null = null;
let manualCount = 0;
let autoDisabledForTest = false;
const pendingCaptures = new Set<Promise<unknown>>();
/** How many manual snapshots of the current test used each id, so a repeat gets its own. */
const idUses = new Map<string, number>();
/** The automatic snapshot, held until every hook has run, or what went wrong taking it; and a mistake in
 *  the test itself to report then. */
let endOfTest: { snapshot?: CapturedSnapshot; captureError?: unknown; testError?: Error } = {};

/** Reset state and mark `task` current. Called by the setup hook before each test. */
export function beginTest(task: TaskLike): void {
  currentTask = task;
  manualCount = 0;
  autoDisabledForTest = false;
  pendingCaptures.clear();
  idUses.clear();
  endOfTest = {};
}

/** Archive the page's current DOM as a named snapshot mid-test. Counts as a manual snapshot, so the
 *  automatic end-of-test snapshot is suppressed (the test is capturing deliberately). A test that takes two
 *  snapshots with the same name gets `#2`, `#3`… on the later ones rather than replacing the first.
 *  `baselineImage` is a design PNG to compare against until a render is accepted: an image import (`import
 *  design from "./home.png"`, passed as-is) or a PNG data URI. `takeSnapshot("", { baselineImage })` keeps
 *  the auto-snapshot's id. */
export async function takeSnapshot(name = "", options: { baselineImage?: DesignImage } = {}): Promise<string> {
  if (!currentTask) {
    throw new Error(
      "@uiverify/vitest: takeSnapshot() was called outside a test. Add uiverifyPlugin() to your vitest.config so the setup hooks run.",
    );
  }
  manualCount++;
  const ids = snapshotIds(currentTask, name);
  const uses = (idUses.get(ids.id) ?? 0) + 1;
  idUses.set(ids.id, uses);
  const id = uses > 1 ? `${ids.id} #${uses}` : ids.id;
  const capturing = capture(currentTask, { ...ids, id }, name, options).then(writeCaptured);
  pendingCaptures.add(capturing);
  try {
    await capturing;
    return id;
  } catch (error) {
    // Nothing was written under the id, so a retry of the same name takes it.
    idUses.set(ids.id, uses - 1);
    throw error;
  } finally {
    pendingCaptures.delete(capturing);
  }
}

/** Turn off the automatic end-of-test snapshot for the current test only. */
export function disableAutoSnapshot(): void {
  autoDisabledForTest = true;
}

/** Take the automatic snapshot, unless the test opted out or already captured manually, and hold it for
 *  {@link finishTest}. A failed test is captured too: it's the test's own report that says it failed,
 *  while a story that vanished from the build would hide that its UI changed. Never throws: it runs among the
 *  user's `afterEach` hooks, and a throw there skips every teardown hook after it, leaving the test's UI
 *  mounted under the next test. */
export async function captureEndOfTest(passed: boolean, autoEnabled: boolean, concurrent = false): Promise<void> {
  const task = currentTask;
  // Concurrent tests share this state, so a capture still in flight may be another test's, awaited there.
  if (pendingCaptures.size && !concurrent) {
    const count = pendingCaptures.size;
    await Promise.allSettled(pendingCaptures);
    // A test that failed (a timeout, say) can leave an awaited capture running too; it's already failing.
    if (passed) endOfTest.testError = notAwaited(count);
  }
  if (!task || !autoEnabled || autoDisabledForTest || manualCount > 0) return;
  try {
    endOfTest.snapshot = await capture(task, snapshotIds(task, ""), "");
  } catch (error) {
    endOfTest.captureError = error;
  }
}

/** Once every hook has run: report a mistake in the test (including a `takeSnapshot()` an `afterEach` left
 *  running), then write the automatic snapshot, unless an `afterEach` took a snapshot of its own or turned the
 *  automatic one off. Why it couldn't be taken is reported only for a passing test; a failed one already has
 *  its own failure. */
export async function finishTest(passed: boolean, concurrent = false): Promise<void> {
  if (pendingCaptures.size && !concurrent) {
    const count = pendingCaptures.size;
    await Promise.allSettled(pendingCaptures);
    if (passed) endOfTest.testError ??= notAwaited(count);
  }
  const { snapshot, captureError, testError } = endOfTest;
  endOfTest = {};
  if (testError) throw testError;
  if (manualCount > 0 || autoDisabledForTest) return;
  if (captureError && passed) throw captureError;
  if (snapshot) await writeCaptured(snapshot);
}

function notAwaited(count: number): Error {
  return new Error(
    `@uiverify/vitest: ${count} takeSnapshot() call${count === 1 ? " was" : "s were"} not awaited. Write \`await takeSnapshot(...)\`.`,
  );
}
