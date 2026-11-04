import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installRafProbe, waitForStableFrame } from "./stable-frame";

const page = { documentElement: { scrollWidth: 800, scrollHeight: 600 }, querySelectorAll: () => [] };

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.stubGlobal("document", page);
  installRafProbe();
});

afterEach(() => {
  page.documentElement.scrollHeight = 600;
});

/** A finite rAF-driven tween, like react-smooth's line-draw: one step per frame until it reaches `frames`. */
function animate(frames: number): { step: number } {
  const state = { step: 0 };
  const tick = () => {
    state.step++;
    if (state.step < frames) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return state;
}

describe("waitForStableFrame", () => {
  /** Catches a capture that doesn't wait for a JS animation: the archive would hold a mid-tween frame. */
  it("waits for a finite requestAnimationFrame animation to reach its last frame", async () => {
    const animation = animate(20);
    expect(await waitForStableFrame()).toBe(false);
    expect(animation.step).toBe(20);
  });

  /** Catches a cancelled frame counting as pending: every capture after an unmount would wait until the frame
   *  read as never delivered (half a second). */
  it("doesn't wait for a frame the app cancelled", async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    cancelAnimationFrame(requestAnimationFrame(() => undefined));
    const started = performance.now();
    expect(await waitForStableFrame()).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);
  });

  /** Catches the check after fonts and images being dropped: an animation that starts while they load (a
   *  chart re-drawing at its new size) would be archived mid-tween. */
  it("waits for an animation that starts after the first check", async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    let animation = { step: 0 };
    setTimeout(() => (animation = animate(20)), 10);
    expect(await waitForStableFrame()).toBe(false);
    expect(animation.step).toBe(20);
  });

  /** Catches a capture that waits out the whole budget on frames that are never delivered (a paused
   *  Playwright clock, a hidden page): nothing on screen can change until the test moves time. */
  it("treats frames that are never delivered as a still frame", async () => {
    const realRaf = requestAnimationFrame;
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      installRafProbe();
      requestAnimationFrame(() => undefined);
      const started = performance.now();
      expect(await waitForStableFrame()).toBe(false);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      vi.stubGlobal("requestAnimationFrame", realRaf);
      installRafProbe();
    }
  });

  /** Catches the probe failing to wrap again a requestAnimationFrame that replaced it (Playwright's clock
   *  installs its own; the Playwright page script installs the probe again before each capture). */
  it("waits for an animation driven by a requestAnimationFrame installed after the probe", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    installRafProbe();
    const animation = animate(20);
    expect(await waitForStableFrame()).toBe(false);
    expect(animation.step).toBe(20);
  });

  /** Catches the probe wrapping a fake-timers requestAnimationFrame (a setup file that called
   *  `vi.useFakeTimers()` before ours): uninstalling the fake timers would then delete the global. */
  it("leaves a fake-timers requestAnimationFrame alone", () => {
    const realRaf = requestAnimationFrame;
    const fake = Object.assign(() => 0, { clock: {} });
    vi.stubGlobal("requestAnimationFrame", fake);
    try {
      installRafProbe();
      expect(globalThis.requestAnimationFrame).toBe(fake);
    } finally {
      vi.stubGlobal("requestAnimationFrame", realRaf);
      installRafProbe();
    }
  });

  /** Catches a capture taken while the page is still growing (an image or a ResizeObserver re-render). */
  it("waits for the page size to stop changing", async () => {
    const grow = setInterval(() => (page.documentElement.scrollHeight += 10), 10);
    setTimeout(() => clearInterval(grow), 150);
    const started = performance.now();
    await waitForStableFrame();
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    const settled = page.documentElement.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.documentElement.scrollHeight).toBe(settled);
  });

  /** Catches the wait hanging on an animation that never ends: it must give up at its deadline. */
  it("captures an endless animation at the deadline, and says so", async () => {
    let running = true;
    const tick = () => {
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const started = performance.now();
    expect(await waitForStableFrame()).toBe(true);
    running = false;
    expect(performance.now() - started).toBeLessThan(6_000);
  }, 10_000);

  /** Catches the wait ignoring what the test has left: four snapshots of an endless animation would each
   *  spend the full 4 s and time out a test that passes without the wait. */
  it("gives up on an endless animation once its budget runs out", async () => {
    let running = true;
    const tick = () => {
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const started = performance.now();
    expect(await waitForStableFrame({ budgetMs: 300 })).toBe(true);
    running = false;
    expect(performance.now() - started).toBeLessThan(800);
  });
});
