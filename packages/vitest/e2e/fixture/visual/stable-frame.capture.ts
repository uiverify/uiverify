import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { takeSnapshot } from "@uiverify/vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

/** A rAF-driven tween like recharts' line-draw: writes its progress every frame, then "done" on its last. */
function animate(frames: number): void {
  const el = document.createElement("p");
  document.body.append(el);
  let step = 0;
  const tick = () => {
    step++;
    el.textContent = step < frames ? `frame ${step}` : "done";
    if (step < frames) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// First in the file, so the tests after it run once fake timers have been installed and uninstalled.
describe("fake timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("snapshot under fake timers", async () => {
    document.body.innerHTML = "<p>frozen</p>";
    await takeSnapshot();
  });
});

test("requestAnimationFrame survives fake timers", () => {
  expect(typeof requestAnimationFrame).toBe("function");
  expect(typeof cancelAnimationFrame).toBe("function");
});

test("finite animation", () => {
  animate(40);
});

test("finite animation, captured right now", async () => {
  animate(40);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await takeSnapshot("", { waitForStableFrame: false });
});

test("lazy image, captured right now", async () => {
  document.body.innerHTML = '<img loading="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">';
  await takeSnapshot("", { waitForStableFrame: false });
});

test("endless animation", async () => {
  const el = document.createElement("p");
  document.body.append(el);
  let step = 0;
  const tick = () => {
    el.textContent = `frame ${++step}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await takeSnapshot();
});

test("endless animation, several snapshots", { timeout: 10_000 }, async () => {
  const el = document.createElement("p");
  document.body.append(el);
  let step = 0;
  const tick = () => {
    el.textContent = `frame ${++step}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  for (const name of ["one", "two", "three", "four"]) await takeSnapshot(name);
});
