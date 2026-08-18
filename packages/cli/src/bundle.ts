import fs from "node:fs";
import path from "node:path";
import { create } from "tar";
import { z } from "zod";

const ARCHIVE_FORMAT_VERSION = 1;

/** The capture SDK that produced an archive (npm name + version), stamped into each snapshot by the SDK
 *  and lifted into `index.json` here. Kept as a local type - the CLI vendors the archive format rather
 *  than depending on `@uiverify/archive-core`. */
const producerSchema = z.object({ name: z.string(), version: z.string() });
export type ArchiveProducer = z.infer<typeof producerSchema>;

// The bits of an archived snapshot the manifest needs; the file carries more (dom, resources, …).
const snapshotMeta = z.object({
  id: z.string(),
  title: z.string(),
  name: z.string(),
  producer: producerSchema.optional(),
  sourcePath: z.string().optional(),
});

/**
 * A Playwright archive dir carries per-test `snapshots/*.json` but no `index.json` — the parallel test
 * workers can't safely co-write one shared manifest during the run. Assemble it here, at bundle time,
 * so `uiverify upload` is the only step the user runs (no separate finalize). No-op for a Storybook
 * static dir, which already ships an `index.json`.
 */
export function finalizeArchiveIfNeeded(staticDir: string): void {
  const snapshotsDir = path.join(staticDir, "snapshots");
  const indexPath = path.join(staticDir, "index.json");
  if (fs.existsSync(indexPath) || !fs.existsSync(snapshotsDir)) return;

  const entries: Record<
    string,
    { id: string; type: "story"; title: string; name: string; snapshot: string; sourcePath?: string }
  > = {};
  let producer: ArchiveProducer | undefined;
  for (const file of fs.readdirSync(snapshotsDir)) {
    if (!file.endsWith(".json")) continue;
    const snap = snapshotMeta.parse(JSON.parse(fs.readFileSync(path.join(snapshotsDir, file), "utf8")));
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
  fs.writeFileSync(
    indexPath,
    JSON.stringify({ v: ARCHIVE_FORMAT_VERSION, entries, ...(producer ? { producer } : {}) }, null, 2),
  );
}

/** The capture SDK that produced the bundle, read from the finalized `index.json` (`createBundle` writes
 *  it first). Null for a Storybook bundle (no SDK) or an archive from a pre-stamp SDK. The CLI forwards
 *  it at register as `x-uiverify-sdk-*` so UI Verify can nudge an outdated capture SDK. Best-effort: a
 *  missing/malformed index simply reports no SDK. */
export function readArchiveProducer(staticDir: string): ArchiveProducer | null {
  const indexPath = path.join(staticDir, "index.json");
  if (!fs.existsSync(indexPath)) return null;
  try {
    const parsed = z
      .object({ producer: producerSchema.optional() })
      .safeParse(JSON.parse(fs.readFileSync(indexPath, "utf8")));
    return parsed.success ? (parsed.data.producer ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Why `--only-changed` will quietly do nothing for this bundle, or `null` if it should work.
 *
 * Skipping is decided server-side, so a no-op looks exactly like a working opt-in in the CI log and the
 * user keeps paying for full runs with nothing to notice. Both no-op causes are provable locally, so
 * both get named:
 *  - `"no-graph"` — a Storybook bundle built without `--stats-json`, so there is no dependency graph.
 *  - `"archive"` — a Playwright archive, which has no graph to build; the server always renders it in full.
 *
 * A Vitest archive is the exception: @uiverify/vitest emits a `preview-stats.json` (the Vite module
 * graph), so an archive that carries one IS skip-capable — reported as `null`, not `"archive"`.
 *
 * Storybook is identified by its own marker, `iframe.html` (the preview frame every static build emits),
 * rather than by ruling an archive out. Both archive-shaped tests drift: `snapshots/` alone misreads a
 * Storybook build that copies a `snapshots/` asset dir, and "`snapshots/` and no `index.json`" flips to
 * Storybook the moment `finalizeArchiveIfNeeded` writes that manifest, so a re-run over the same archive
 * dir would start getting Storybook advice. A `staticDir` that doesn't exist has a real error coming and
 * is left alone rather than pre-empted with a misleading hint.
 */
export function onlyChangedNoOpReason(staticDir: string): "no-graph" | "archive" | null {
  if (fs.existsSync(path.join(staticDir, "iframe.html"))) {
    return fs.existsSync(path.join(staticDir, "preview-stats.json")) ? null : "no-graph";
  }
  if (!fs.existsSync(path.join(staticDir, "snapshots"))) return null;
  return fs.existsSync(path.join(staticDir, "preview-stats.json")) ? null : "archive";
}

/** Create the bundle .tgz from a built static dir (files at the archive root). A Playwright archive dir
 *  is finalized first — its `index.json` manifest assembled — so it uploads with no separate step. */
export async function createBundle(staticDir: string, outPath: string): Promise<void> {
  finalizeArchiveIfNeeded(staticDir);
  await create({ gzip: true, file: outPath, cwd: staticDir }, ["."]);
}

const SCREENSHOT_FORMAT_VERSION = 1;
const IMAGE_EXT = /\.(png|jpe?g)$/i;

/** Recursively collect image files under `root`, returned as paths relative to `root`. */
function collectImages(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectImages(root, abs, out);
    else if (IMAGE_EXT.test(entry.name)) out.push(path.relative(root, abs));
  }
  return out;
}

/**
 * Screenshot upload (Model 3): the user points `--screenshots` at a directory of finished PNGs their own
 * harness produced (native / mobile / React Native). Assemble the manifest UI Verify's `screenshot-upload`
 * capturer reads — each image keyed by its POSIX bundle-relative path with the extension dropped, so a
 * screen maps to the same baseline every build and a partial upload is a subset of the same id space. The
 * server derives everything else; this is pure client-side assembly, no rendering. Throws on an empty dir
 * (nothing to upload) or a colliding id (two files that reduce to the same key).
 */
export function finalizeScreenshots(dir: string): void {
  const images = collectImages(dir);
  if (images.length === 0) throw new Error(`no screenshots (*.png, *.jpg, *.jpeg) found in ${dir}`);
  const entries: Record<string, { id: string; type: "story"; title: string; name: string; image: string }> = {};
  for (const rel of images) {
    const image = rel.split(path.sep).join("/");
    const id = image.replace(IMAGE_EXT, "");
    if (entries[id]) throw new Error(`two screenshots map to the same id "${id}" (differ only by extension): ${dir}`);
    const posixDir = path.posix.dirname(image);
    entries[id] = {
      id,
      type: "story",
      title: posixDir === "." ? "" : posixDir,
      name: path.posix.basename(image).replace(IMAGE_EXT, ""),
      image,
    };
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: SCREENSHOT_FORMAT_VERSION, entries }, null, 2));
}

/** Create the bundle .tgz for a screenshot upload: assemble the manifest, then tar the dir (PNGs +
 *  index.json) exactly like `createBundle`. Swapped in for `createBundle` when `--screenshots` is used. */
export async function createScreenshotBundle(dir: string, outPath: string): Promise<void> {
  finalizeScreenshots(dir);
  await create({ gzip: true, file: outPath, cwd: dir }, ["."]);
}
