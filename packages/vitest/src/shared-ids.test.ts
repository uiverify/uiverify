import { describe, expect, it } from "vitest";
import { sharedIdWarning } from "./shared-ids";

describe("sharedIdWarning", () => {
  /** Catches two browser projects (or two browser.instances) running one file and silently overwriting
   *  each other's captures. */
  it("warns once per run when a second project writes an id", () => {
    const run = {};
    expect(sharedIdWarning(run, "/out", "desktop", "a > renders")).toBeUndefined();
    expect(sharedIdWarning(run, "/out", "mobile", "a > renders")).toContain('"desktop" and "mobile"');
    expect(sharedIdWarning(run, "/out", "mobile", "b > renders")).toBeUndefined();
    expect(sharedIdWarning(run, "/out", "desktop", "b > renders")).toBeUndefined();
  });

  it("stays quiet for projects writing to different archive dirs", () => {
    const run = {};
    sharedIdWarning(run, "/desktop", "desktop", "a > renders");
    expect(sharedIdWarning(run, "/mobile", "mobile", "a > renders")).toBeUndefined();
  });

  it("stays quiet for a retry rewriting its own project's id, and for a new run", () => {
    const run = {};
    sharedIdWarning(run, "/out", "visual", "a > renders");
    expect(sharedIdWarning(run, "/out", "visual", "a > renders")).toBeUndefined();
    expect(sharedIdWarning({}, "/out", "other", "a > renders")).toBeUndefined();
  });
});
