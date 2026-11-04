import { realNow, sleep } from "./real-timers";
import { settle, type SettleOptions } from "./settle";

/** How long after the app's last `requestAnimationFrame` callback, with none pending, the animation counts as
 *  finished: covers a loop that schedules its next frame from a timer rather than from the frame itself. */
const RAF_QUIET_MS = 100;
/** When no frame has run for this long and one requested this long ago is still pending, frames aren't being
 *  delivered (a paused Playwright clock, a hidden page), so the frame on screen won't change until the test
 *  moves it. */
const RAF_STALLED_MS = 500;
/** Longer than a normal finite entry animation (react-smooth's default is 1.5 s); an endless loop is
 *  captured as it is at this point. */
const RAF_BUDGET_MS = 4_000;
/** The least the check after fonts and images gets, however long they took to load. */
const RAF_RECHECK_MS = 2_000;
const RAF_POLL_MS = 50;
/** The page size must hold across this gap (about two frames, so a ResizeObserver re-render lands). */
const LAYOUT_SAMPLE_MS = 32;
const LAYOUT_BUDGET_MS = 1_000;

/** The app's rAF callbacks requested and not yet run or cancelled (with when each was requested), and when
 *  one last ran. */
const pendingFrames = new Map<number, number>();
let lastFrame: number | undefined;
let wrapper: typeof requestAnimationFrame | undefined;

/** Wrap `requestAnimationFrame` to track the app's pending frames, so {@link waitForStableFrame} can tell
 *  when a JS-driven animation (a recharts line-draw, a framer-motion entry) has finished: it changes only
 *  inline styles, so nothing else sees it. A running loop always has its next frame pending, so a frame that
 *  is late under load doesn't read as the end. Install it before app code runs. Calling it again wraps
 *  whatever replaced it since (Playwright's clock installs its own), which only the Playwright page script
 *  does: Vitest's fake timers delete a global they find replaced when they're uninstalled. It only waits, on
 *  the real clock: it never freezes or shifts the animation's time. */
export function installRafProbe(): void {
  if (typeof requestAnimationFrame !== "function" || globalThis.requestAnimationFrame === wrapper) return;
  // Fake timers (`vi.useFakeTimers()` in a setup file that ran first) mark their fakes with `clock`, and
  // delete a global they find replaced once they're uninstalled.
  if (Reflect.has(requestAnimationFrame, "clock")) return;
  const raf = requestAnimationFrame.bind(globalThis);
  const cancel = cancelAnimationFrame.bind(globalThis);
  // Frames requested through a replaced one may never report back.
  pendingFrames.clear();
  lastFrame = realNow();
  wrapper = (callback) => {
    const id = raf((time) => {
      pendingFrames.delete(id);
      lastFrame = realNow();
      callback(time);
    });
    pendingFrames.set(id, realNow());
    return id;
  };
  globalThis.requestAnimationFrame = wrapper;
  globalThis.cancelAnimationFrame = (id) => {
    pendingFrames.delete(id);
    cancel(id);
  };
}

function rafSettled(): boolean {
  if (lastFrame === undefined) return true;
  const now = realNow();
  if (pendingFrames.size === 0) return now - lastFrame >= RAF_QUIET_MS;
  return now - lastFrame >= RAF_STALLED_MS && Math.min(...pendingFrames.values()) <= now - RAF_STALLED_MS;
}

/** Resolves `true` when the loop was still running at `deadline`. Polled on the real `setTimeout`, not on
 *  rAF, so a paused or throttled page can't hang it. */
async function rafQuiet(deadline: number): Promise<boolean> {
  while (!rafSettled()) {
    if (realNow() >= deadline) return true;
    await sleep(RAF_POLL_MS);
  }
  return false;
}

function pageSize(): string {
  const root = document.documentElement;
  return root ? `${root.scrollWidth}x${root.scrollHeight}` : "";
}

async function layoutStable(end: number): Promise<void> {
  const deadline = Math.min(realNow() + LAYOUT_BUDGET_MS, end);
  let previous = pageSize();
  while (realNow() < deadline) {
    await sleep(LAYOUT_SAMPLE_MS);
    const next = pageSize();
    if (next === previous) return;
    previous = next;
  }
}

export interface StableFrameOptions extends SettleOptions {
  /** The most the animation and layout waits may take, in ms: what the test has left of its timeout, so a page
   *  that animates forever can't time out a test that passes without the wait. Fonts and images keep their own
   *  time box. No limit by default. */
  budgetMs?: number;
}

/** Wait for the next stable frame before a capture: the page's animation loop quiet, fonts and images loaded
 *  ({@link settle}), then the page size holding still. Every step has a deadline, so it never hangs; an
 *  endless animation is captured as it is at the deadline. Resolves `true` when that happened, so the SDK
 *  can tell the author. */
export async function waitForStableFrame({
  budgetMs = Number.POSITIVE_INFINITY,
  ...options
}: StableFrameOptions = {}): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const start = realNow();
  const end = start + Math.max(0, budgetMs);
  const deadline = Math.min(start + RAF_BUDGET_MS, end);
  const animating = await rafQuiet(deadline);
  await settle(options);
  await layoutStable(end);
  // Loading an image or a font can start an animation of its own (a chart re-drawing at its new size).
  return animating || rafQuiet(Math.min(Math.max(deadline, realNow() + RAF_RECHECK_MS), end));
}
