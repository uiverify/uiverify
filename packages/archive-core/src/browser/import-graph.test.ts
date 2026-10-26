import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BROWSER_DIR = import.meta.dirname;
const NODE_BUILTINS = new Set(builtinModules);

/** Every module specifier `file` imports, re-exports or loads dynamically, type-only imports included
 *  (they're erased, but a type import of the Node index is one edit away from a value import). */
function specifiers(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const statements = /(?:^|\n)\s*(?:import|export)\b(?:[^;"']*?\bfrom)?\s*["']([^"']+)["']/g;
  const dynamic = /\bimport\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(statements), ...source.matchAll(dynamic)].map((m) => m[1] ?? "");
}

/** The files `entry` reaches through relative imports, and every bare specifier along the way. */
function importGraph(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of specifiers(file)) {
      if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), `${spec}.ts`));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => path.relative(BROWSER_DIR, f)), bare: [...bare] };
}

describe("@uiverify/archive-core/browser", () => {
  /** Catches a Node import reaching the in-page code, which breaks every browser bundle it lands in:
   *  @uiverify/vitest 1.0.1 shipped `crypto` into the browser this way. */
  it("imports nothing from Node, and nothing from the Node-side archive code but its types", () => {
    const { files, bare } = importGraph(path.join(BROWSER_DIR, "index.ts"));
    const node = (spec: string) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? "");
    // The package's own name reaches its Node index, as a relative import outside this folder would.
    expect(bare.filter((spec) => node(spec) || spec.startsWith("@uiverify/"))).toEqual([]);
    expect(files.filter((file) => file.startsWith("..")).sort()).toEqual([path.join("..", "archive-types.ts")]);
  });
});
