/**
 * @uiverify/archive-core — the runner-agnostic pieces shared by the UI Verify capture SDKs
 * (@uiverify/playwright, @uiverify/vitest): the archive format types, the deterministic snapshot
 * filename, the per-snapshot writer, the manifest builder, and the output-dir resolution.
 *
 * This package is INTERNAL: it is bundled into each SDK at build time and never published on its own.
 * It carries no runner (Playwright/Vitest) dependency — only the archive format and Node fs helpers.
 */
export type {
  ArchivedResource,
  ArchivedSnapshot,
  ArchivedSnapshotParams,
  ArchiveIndex,
  ArchiveIndexEntry,
} from "./archive-types";
export { ARCHIVE_FORMAT_VERSION } from "./archive-types";
export { snapshotFileName } from "./snapshot-file";
export { resolveOutDir } from "./out-dir";
export { writeSnapshot } from "./write";
export { finalizeArchive } from "./finalize";
