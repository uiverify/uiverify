import { describe, expect, test } from "bun:test";
import { checkSnapshotName, checkViewportKey, snapshotIds, testId } from "./ids";

const path = ["app.visual.ts", "Home", "workspace list"];

describe("snapshot ids", () => {
  /** Catches an id or title drifting from the shape existing baselines are keyed by: every one would show as
   *  new, and the old ones as removed. */
  test("a plain capture and a viewport variant keep the ids and titles existing baselines are keyed by", () => {
    expect(snapshotIds({ path, declaration: 1, variant: "" }, "")).toEqual({
      id: "app.visual.ts > Home > workspace list",
      title: "app.visual.ts > Home",
      name: "",
    });
    expect(snapshotIds({ path, declaration: 1, variant: "mobile" }, "")).toEqual({
      id: "app.visual.ts > Home > workspace list::mobile",
      title: "app.visual.ts > Home > workspace list",
      name: "mobile",
    });
  });

  test("a named snapshot, alone and at a variant", () => {
    expect(snapshotIds({ path, declaration: 1, variant: "" }, "open")).toEqual({
      id: "app.visual.ts > Home > workspace list::open",
      title: "app.visual.ts > Home > workspace list",
      name: "open",
    });
    expect(snapshotIds({ path, declaration: 1, variant: "mobile" }, "open")).toEqual({
      id: "app.visual.ts > Home > workspace list::open::mobile",
      title: "app.visual.ts > Home > workspace list",
      name: "open (mobile)",
    });
  });

  /** Catches repeats overwriting each other's snapshot file, as Vitest numbers them. */
  test("a repeated declaration gets (n) before any ::, a repeated name #n after it", () => {
    expect(testId(path, 2)).toBe("app.visual.ts > Home > workspace list (2)");
    expect(snapshotIds({ path, declaration: 2, variant: "mobile" }, "").id).toBe("app.visual.ts > Home > workspace list (2)::mobile");
    expect(snapshotIds({ path, declaration: 1, variant: "" }, "open", 2).id).toBe("app.visual.ts > Home > workspace list::open #2");
    expect(snapshotIds({ path, declaration: 1, variant: "" }, "", 2).id).toBe("app.visual.ts > Home > workspace list #2");
  });

  /** Catches `takeSnapshot("a mobile")` and `takeSnapshot("a")` at `mobile` colliding, as joining them
   *  with a space would. */
  test("names and viewport keys that would make an id ambiguous are refused", () => {
    expect(() => checkSnapshotName("a::b", [""])).toThrow('contains "::"');
    expect(() => checkSnapshotName("mobile", ["", "mobile"])).toThrow("also one of this test's viewport keys");
    expect(() => checkSnapshotName("", ["", "mobile"])).not.toThrow();
    expect(() => checkViewportKey("x::y")).toThrow('contains "::"');
  });
});
