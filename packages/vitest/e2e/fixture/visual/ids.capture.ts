import { afterEach, describe, test } from "vitest";
import { takeSnapshot } from "@uiverify/vitest";

test("two snapshots", async () => {
  document.body.innerHTML = "<p>one</p>";
  await takeSnapshot();
  document.body.innerHTML = "<p>two</p>";
  await takeSnapshot();
});

test("same title", () => {
  throw new Error("the first of two");
});

test("same title", () => {
  document.body.innerHTML = "<p>second</p>";
});

test("not awaited", () => {
  document.body.innerHTML = "<p>unawaited</p>";
  void takeSnapshot("oops");
});

describe("not awaited in afterEach", () => {
  afterEach(() => {
    void takeSnapshot("late");
  });

  test("left running", () => {
    document.body.innerHTML = "<p>late</p>";
  });
});
