/**
 * Build a stable baseline id from a Vitest task. The id is the archive's baseline key (analogous to a
 * Storybook story id), so it must be identical run-to-run and machine-to-machine: we derive it from the
 * test file (relative to the project root) plus the enclosing `describe` names plus the test name, never
 * from an absolute path or anything time/order dependent. Tests that share all of those are told apart by
 * where they're defined in the file, which no run, failure or filter changes.
 */

/** A Vitest task, reduced to the shape we need (structurally matches the runner's Test/Suite/File task). */
export interface TaskLike {
  name: string;
  type?: string;
  suite?: TaskLike;
  file?: TaskLike;
  tasks?: TaskLike[];
}

/** The ordered name path for a task: the test file (root-relative), then each enclosing `describe`, then
 *  the test name. The file object is skipped in the suite walk (it is re-added once, up front) so it is
 *  never counted twice regardless of whether it appears in the `suite` chain. */
export function snapshotIdParts(task: TaskLike): string[] {
  const file = task.file;
  const suites: string[] = [];
  let cur = task.suite;
  while (cur && cur !== file) {
    if (cur.name) suites.unshift(cur.name);
    cur = cur.suite;
  }
  const parts: string[] = [];
  if (file?.name) parts.push(file.name);
  parts.push(...suites, task.name);
  return parts;
}

/** Each file's tests grouped by name path, in definition order. Built once per file task, which Vitest
 *  creates afresh for every run. */
const testsByPath = new WeakMap<TaskLike, Map<string, TaskLike[]>>();

function testsSharingPath(task: TaskLike, path: string): TaskLike[] {
  const file = task.file;
  if (!file) return [task];
  let byPath = testsByPath.get(file);
  if (!byPath) {
    byPath = new Map();
    const visit = (t: TaskLike) => {
      if (t.type === "test") {
        const key = snapshotIdParts(t).join(" > ");
        byPath?.set(key, [...(byPath.get(key) ?? []), t]);
      }
      for (const child of t.tasks ?? []) visit(child);
    };
    visit(file);
    testsByPath.set(file, byPath);
  }
  return byPath.get(path) ?? [task];
}

/** The `{ id, title }` for a capture: `id` is the baseline key (the parts joined, plus the optional
 *  snapshot `name`), `title` is the grouping label (everything but the test name). A test whose name path
 *  another test in the file also has (two `it("renders")` in one describe, `test.each` rows that print the
 *  same title) gets ` (2)`, ` (3)`… by its position among them; without it their captures would write the
 *  same archive file. Mirrors the `@uiverify/playwright` fixture's id/title shape so both SDKs produce
 *  interchangeable archives. */
export function snapshotIds(task: TaskLike, name: string): { id: string; title: string } {
  const parts = snapshotIdParts(task);
  const path = parts.join(" > ");
  const position = testsSharingPath(task, path).indexOf(task);
  const idBase = position > 0 ? `${path} (${position + 1})` : path;
  const title = parts.length > 1 ? parts.slice(0, -1).join(" > ") : (parts[0] ?? "");
  return { id: name ? `${idBase}::${name}` : idBase, title };
}
