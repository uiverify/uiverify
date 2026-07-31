import { createHash } from "node:crypto";

/** Deterministic, filesystem-safe filename for a snapshot id: a readable slug plus a short hash of the
 *  full id (so two ids that slugify the same never collide). Shared shape with `finalizeArchive`, which
 *  discovers these files. */
export function snapshotFileName(id: string): string {
  const slug = id
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 10);
  return `${slug || "snapshot"}-${hash}.json`;
}
