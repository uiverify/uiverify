import { clearArchive } from "@uiverify/archive-core";

const clearedDirs = new WeakMap<object, Set<string>>();

/** Clear `outDir` the first time `run` asks for it: `configureVitest` runs once per project, and projects
 *  sharing a dir must not clear it again. */
export function clearOncePerRun(run: object, outDir: string): void {
  const cleared = clearedDirs.get(run) ?? new Set<string>();
  clearedDirs.set(run, cleared);
  if (cleared.has(outDir)) return;
  cleared.add(outDir);
  clearArchive(outDir);
}
