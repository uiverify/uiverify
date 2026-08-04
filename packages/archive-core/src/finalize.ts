import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_FORMAT_VERSION, type ArchiveIndex, type ArchiveIndexEntry, type ArchivedSnapshot } from "./archive-types";

/**
 * Assemble an archive bundle's manifest from the per-snapshot files written during the test run.
 *
 * Each `writeSnapshot` writes an independent, self-contained `snapshots/<file>.json`. Building the index
 * as a SEPARATE pass (rather than appending to a shared index.json during the run) is deliberate: a test
 * run writes specs across parallel workers, and concurrent writers to one index file would race. This
 * pass runs once, after the test run, reads each snapshot's own id/title/name, and emits `index.json` —
 * the manifest UI Verify reads. Returns the number of snapshots indexed.
 */
export function finalizeArchive(bundleDir: string): number {
  const dir = path.join(bundleDir, "snapshots");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const entries: Record<string, ArchiveIndexEntry> = {};
  let producer: ArchiveIndex["producer"];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const snap: Pick<ArchivedSnapshot, "id" | "title" | "name" | "producer" | "sourcePath"> = JSON.parse(raw);
    entries[snap.id] = {
      id: snap.id,
      type: "story",
      title: snap.title,
      name: snap.name,
      snapshot: path.join("snapshots", file),
      ...(snap.sourcePath ? { sourcePath: snap.sourcePath } : {}),
    };
    // Every snapshot carries the same producer; take the first seen for the manifest.
    producer ??= snap.producer;
  }
  const index: ArchiveIndex = { v: ARCHIVE_FORMAT_VERSION, entries, ...(producer ? { producer } : {}) };
  fs.writeFileSync(path.join(bundleDir, "index.json"), JSON.stringify(index, null, 2));
  return Object.keys(entries).length;
}
