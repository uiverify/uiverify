import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { disableAutoSnapshot, takeSnapshot } from "@uiverify/vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

test("cleaned up after", () => {
  document.body.innerHTML = "<h1>rendered</h1>";
});

describe("snapshot in afterEach", () => {
  afterEach(async () => {
    await takeSnapshot();
  });

  test("settles in a hook", () => {
    document.body.innerHTML = "<h1>settled</h1>";
  });
});

describe("opt-out in afterEach", () => {
  afterEach(() => {
    disableAutoSnapshot();
  });

  test("not visual", () => {
    document.body.innerHTML = "<h1>not visual</h1>";
  });
});

describe("failing afterEach", () => {
  afterEach(() => {
    expect("teardown").toBe("ok");
  });

  test("fails after the body", () => {
    document.body.innerHTML = "<h1>failed later</h1>";
  });
});

describe("fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("image under a frozen clock", async () => {
    const img = document.createElement("img");
    img.src = `${__ASSETS__}/frozen.png`;
    document.body.replaceChildren(img);
    await new Promise((resolve) => {
      img.addEventListener("load", resolve);
      img.addEventListener("error", resolve);
    });
  });
});
