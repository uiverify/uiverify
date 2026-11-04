/**
 * Snapshot ids: `<file basename> > <describe>… > <test>`, then `::<variant>` (a viewport key other than
 * `""`), `::<name>` (a named snapshot) or `::<name>::<variant>`. A second `test()` declared with the same
 * path gets ` (2)` before any `::`; a name repeated within one test gets ` #2` after it.
 */

const SEPARATOR = "::";

/** A test's id, before any snapshot name or viewport: its name path, ` (n)` for the n-th declaration of it. */
export function testId(path: string[], declaration: number): string {
  const joined = path.join(" > ");
  return declaration > 1 ? `${joined} (${declaration})` : joined;
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const last = n % 100;
  return `${n}${suffixes[(last - 20) % 10] ?? suffixes[last] ?? "th"}`;
}

/** A test declaration in words, for an error that names two of them. */
export function describeDeclaration(path: string[], declaration: number): string {
  const joined = JSON.stringify(path.join(" > "));
  return declaration > 1 ? `the ${ordinal(declaration)} test named ${joined}` : `the test ${joined}`;
}

/** A `takeSnapshot` call in words: the `use`-th of that name in its test. */
export function describeSnapshotCall(name: string, use: number): string {
  const call = `takeSnapshot(${name ? JSON.stringify(name) : ""})`;
  return use > 1 ? `the ${ordinal(use)} ${call}` : call;
}

export interface SnapshotIds {
  id: string;
  /** The dashboard's grouping label. */
  title: string;
  /** The capture's label within it; display only. */
  name: string;
}

/** The ids of one snapshot of a test: `path` is its name path, `use` how many times this test has already
 *  taken a snapshot of this name, plus one. */
export function snapshotIds(
  test: { path: string[]; declaration: number; variant: string },
  name: string,
  use = 1,
): SnapshotIds {
  const id = testId(test.path, test.declaration);
  const repeat = use > 1 ? ` #${use}` : "";
  if (!name && !repeat && !test.variant) return { id, title: test.path.slice(0, -1).join(" > "), name: "" };
  const named = (name ? `${id}${SEPARATOR}${name}` : id) + repeat;
  const label = `${name}${repeat}`.trim();
  return {
    id: test.variant ? `${named}${SEPARATOR}${test.variant}` : named,
    title: id,
    name: label && test.variant ? `${label} (${test.variant})` : label || test.variant,
  };
}

export function checkViewportKey(key: string): void {
  if (key.includes(SEPARATOR)) {
    throw new Error(`@uiverify/bun: the viewport key "${key}" contains "::", which separates the parts of a snapshot id.`);
  }
}

export function checkSnapshotName(name: string, viewportKeys: string[]): void {
  if (name.includes(SEPARATOR)) {
    throw new Error(`@uiverify/bun: the snapshot name "${name}" contains "::", which separates the parts of a snapshot id.`);
  }
  if (name && viewportKeys.includes(name)) {
    throw new Error(
      `@uiverify/bun: the snapshot name "${name}" is also one of this test's viewport keys, so its id would be ambiguous. Rename one of them.`,
    );
  }
}
