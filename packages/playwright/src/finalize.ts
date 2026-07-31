/**
 * `finalizeArchive(dir)` — assemble the archive manifest from the per-test snapshot files. Re-exported
 * from `@uiverify/archive-core` (the runner-agnostic implementation, shared with @uiverify/vitest) so
 * the published `@uiverify/playwright/finalize` subpath stays stable. The CLI builds the manifest at
 * upload time, so this is only for callers that want it ahead of time.
 */
export { finalizeArchive } from "@uiverify/archive-core";
