import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArchivedResource, ArchivedSnapshot, CapturedResource, CapturedSnapshot } from "./archive-types";
import { snapshotFileName } from "./snapshot-file";

/** The archive's shared resource store: one file per distinct resource body, named by its SHA-256. */
const RESOURCES_DIR = "resources";

/** Store `resource`'s bytes under their content hash (once per archive) and return the stored reference. */
function storeResource(outDir: string, resource: CapturedResource): ArchivedResource {
  const bytes = Buffer.from(resource.body, "base64");
  const file = path.posix.join(RESOURCES_DIR, createHash("sha256").update(bytes).digest("hex"));
  writeOnce(path.join(outDir, file), bytes);
  return { contentType: resource.contentType, status: resource.status, file };
}

/** Write content-addressed `bytes` to `target` unless it exists. Parallel test workers can write the same
 *  bytes at once, so each writes a private temp file and renames it into place: a reader never sees a
 *  half-written file, and the loser of the race replaces identical bytes. */
function writeOnce(target: string, bytes: Buffer): void {
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
}

/**
 * Write one snapshot to `<outDir>/snapshots/<file>.json`, its resource bytes into the shared
 * `<outDir>/resources/` store. The manifest (`index.json`) is assembled in a SEPARATE pass
 * (`finalizeArchive`, or the CLI at upload time), never here: a test run writes snapshots from parallel
 * workers, and concurrent writers to one index would race. Returns the snapshot path written.
 */
export function writeSnapshot(outDir: string, snapshot: CapturedSnapshot): string {
  const resources: Record<string, ArchivedResource> = {};
  for (const [url, resource] of Object.entries(snapshot.resources)) resources[url] = storeResource(outDir, resource);
  const archived: ArchivedSnapshot = { ...snapshot, resources };
  const dir = path.join(outDir, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, snapshotFileName(snapshot.id));
  fs.writeFileSync(file, JSON.stringify(externalizeBaselineImage(outDir, archived)));
  return file;
}

/**
 * Move a data-URI design baseline into `<outDir>/design/<sha256>.png` and point the snapshot at that path.
 * Keeps the manifest small (UI Verify parses it on every upload), and the content-hash name lets UI Verify
 * see an unchanged design without downloading the bundle. Identical designs share one file.
 */
function externalizeBaselineImage(outDir: string, snapshot: ArchivedSnapshot): ArchivedSnapshot {
  const src = snapshot.baselineImage;
  const base64 = src ? /^data:image\/png;base64,(.*)$/s.exec(src)?.[1] : undefined;
  if (base64 === undefined) return snapshot;
  const bytes = Buffer.from(base64, "base64");
  const rel = `design/${createHash("sha256").update(bytes).digest("hex")}.png`;
  writeOnce(path.join(outDir, rel), bytes);
  return { ...snapshot, baselineImage: rel };
}
