import fs from "node:fs";
import path from "node:path";
import type { ArchivedSnapshot } from "./archive-types";
import { snapshotFileName } from "./snapshot-file";

/**
 * Write one self-contained snapshot to `<outDir>/snapshots/<file>.json`. The manifest (`index.json`) is
 * assembled in a SEPARATE pass (`finalizeArchive`, or the CLI at upload time), never here: a test run
 * writes snapshots from parallel workers, and concurrent writers to one index would race. Returns the
 * path written, for logging/tests.
 */
export function writeSnapshot(outDir: string, snapshot: ArchivedSnapshot): string {
  const dir = path.join(outDir, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, snapshotFileName(snapshot.id));
  fs.writeFileSync(file, JSON.stringify(snapshot));
  return file;
}
