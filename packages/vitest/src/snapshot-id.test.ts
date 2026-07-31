import { describe, it, expect } from "vitest";
import { snapshotIdParts, snapshotIds, type TaskLike } from "./snapshot-id";

/** A file task, and a test nested some suites deep, built the way Vitest links them (`suite` chain ends
 *  at the file task; `file` points at that same object). */
function taskInFile(fileName: string, suiteNames: string[], testName: string): TaskLike {
  const file: TaskLike = { name: fileName };
  file.file = file;
  let parent = file;
  for (const name of suiteNames) {
    const suite: TaskLike = { name, suite: parent, file };
    parent = suite;
  }
  return { name: testName, suite: parent, file };
}

describe("snapshotIdParts", () => {
  it("is file, then describe names, then the test name", () => {
    const task = taskInFile("src/Menu.test.tsx", ["Menu", "when open"], "shows items");
    expect(snapshotIdParts(task)).toEqual(["src/Menu.test.tsx", "Menu", "when open", "shows items"]);
  });

  it("handles a top-level test with no describe", () => {
    const task = taskInFile("src/Button.test.tsx", [], "renders");
    expect(snapshotIdParts(task)).toEqual(["src/Button.test.tsx", "renders"]);
  });

  it("never counts the file twice even when it heads the suite chain", () => {
    const task = taskInFile("a.test.ts", ["outer"], "inner");
    expect(snapshotIdParts(task).filter((p) => p === "a.test.ts")).toHaveLength(1);
  });
});

describe("snapshotIds", () => {
  it("joins parts for the id and drops the test name for the title", () => {
    const task = taskInFile("src/Menu.test.tsx", ["Menu"], "shows items");
    expect(snapshotIds(task, "")).toEqual({
      id: "src/Menu.test.tsx > Menu > shows items",
      title: "src/Menu.test.tsx > Menu",
    });
  });

  it("appends a named checkpoint to the id with ::", () => {
    const task = taskInFile("src/Menu.test.tsx", ["Menu"], "shows items");
    expect(snapshotIds(task, "open").id).toBe("src/Menu.test.tsx > Menu > shows items::open");
  });
});
