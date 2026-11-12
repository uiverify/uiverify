import { expect, test } from "bun:test";
import { seconds, StartupSteps } from "./startup";

test("a step is timed whether it finishes or throws, and named in order", async () => {
  const steps = new StartupSteps();
  await steps.run("launch", () => Bun.sleep(30));
  await steps.run("setup", () => Promise.reject(new Error("broke"))).catch(() => {});
  expect(steps.summary()).toMatch(/^launch 0\.\ds, setup 0\.0s$/);
  expect(steps.totalMs).toBeGreaterThanOrEqual(25);
});

test("seconds rounds to a tenth", () => {
  expect(seconds(61_049)).toBe("61.0s");
});
