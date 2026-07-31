/**
 * @uiverify/playwright — the client capture SDK. Swap `@playwright/test` for `@uiverify/playwright` in your specs
 * and each test archives its final UI state (serialized DOM + resource bytes) for UI Verify to replay + diff.
 *
 *   import { test, expect } from "@uiverify/playwright";
 *
 * After `playwright test`, run `uiverify upload --static-dir <dir>` — the CLI assembles the bundle
 * manifest itself. `finalizeArchive(dir)` (see ./finalize) is still exported for callers that want to
 * build the manifest ahead of time, but it is no longer a required step.
 */
export { test, expect, type UiVerifyFixture } from "./fixture";
export { PlaywrightArchiver, type ArchiverOptions } from "./archiver";
export {
  finalizeArchive,
  snapshotFileName,
  type ArchivedSnapshot,
  type ArchivedSnapshotParams,
  type ArchiveIndex,
} from "@uiverify/archive-core";
