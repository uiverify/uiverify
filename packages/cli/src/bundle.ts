import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { create, list } from "tar";
import { z } from "zod";

const ARCHIVE_FORMAT_VERSION = 1;

/** The algorithm-version tag on every `bundle_content_hash`. A change to the hashing rules below bumps
 *  this (to `v2`), so a hash computed by a newer CLI can never MATCH one an older CLI stored — drift
 *  falls through to a render (a safe miss), never a wrong skip. */
const BUNDLE_HASH_VERSION = "v1";

/** Files kept OUT of the bundle content hash: build METADATA that varies across rebuilds of the identical
 *  source without affecting the rendered screenshots. Two back-to-back Storybook builds of the same commit
 *  differ ONLY in these two — `project.json` carries a `generatedAt` timestamp, and `preview-stats.json` is
 *  the dependency graph (absolute paths / ordering) the browser never loads. Hashing them would give every
 *  CI re-run a new hash, so the same-commit rebuild skip would never fire; any change that actually affects
 *  the render also touches a hashed asset, so excluding these two can't mask a real difference. (Neither
 *  file exists in an archive/screenshot bundle, so the exclusion is a no-op there.) */
const HASH_EXCLUDED_FILES = new Set(["project.json", "preview-stats.json"]);

/**
 * A deterministic content hash of the built bundle `.tgz`, computed client-side and sent at register so
 * the server can skip the rebuild of an already-passed commit (a same-commit re-upload whose bundle is
 * byte-identical to a prior fully-accepted build renders nothing new). Streams every regular file entry
 * through its own sha256 (never buffered), builds a manifest of `path:sha256hex` lines (POSIX paths with a
 * leading `./` stripped) sorted by path, hashes that, and tags it `v1:`. Stable across tar mtime/ordering
 * noise and excludes the two metadata files that vary run-to-run (`HASH_EXCLUDED_FILES`), so a genuine CI
 * re-upload of the same source matches. The server never recomputes it (on a skip nothing is uploaded); the
 * `v1:` tag makes a future algorithm change a safe miss rather than a wrong skip.
 */
export async function bundleContentHash(tgzPath: string): Promise<string> {
  const entries: { path: string; hash: string }[] = [];
  await list({
    file: tgzPath,
    onentry: (entry) => {
      if (entry.type !== "File") {
        entry.resume();
        return;
      }
      const name = entry.path.replace(/^\.?\//, "");
      const h = createHash("sha256");
      entry.on("data", (c) => h.update(c));
      entry.on("end", () => {
        if (!HASH_EXCLUDED_FILES.has(name)) entries.push({ path: name, hash: h.digest("hex") });
      });
    },
  });
  // Sort by PATH in byte order (paths are unique), then join one `path:sha256hex` per line with a trailing
  // newline — the exact manifest a future server-side recompute would rebuild.
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest = entries.map((e) => `${e.path}:${e.hash}\n`).join("");
  return `${BUNDLE_HASH_VERSION}:${createHash("sha256").update(manifest).digest("hex")}`;
}

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
  if (isStorybookStaticDir(staticDir)) {
    return fs.existsSync(path.join(staticDir, "preview-stats.json")) ? null : "no-graph";
  }
  if (!fs.existsSync(path.join(staticDir, "snapshots"))) return null;
  return fs.existsSync(path.join(staticDir, "preview-stats.json")) ? null : "archive";
}

/**
 * Whether a `--static-dir` is a built Storybook, by its own marker: `iframe.html`, the preview frame every
 * static Storybook build emits. Used to decide whether `check` needs `--target` (see the check command): a
 * Storybook build is monolithic — the whole suite is built regardless of what you name — so a preview must
 * name what to render, whereas an archive `--static-dir` is already scoped to the tests you replayed. This
 * is the same positive Storybook sniff `onlyChangedNoOpReason` relies on, kept as one predicate so both
 * decisions read the same marker. A dir that doesn't exist reads as "not Storybook" (an archive/screenshot)
 * — the real "missing bundle" error then surfaces at upload, not pre-empted with a misleading hint.
 */
export function isStorybookStaticDir(staticDir: string): boolean {
  return fs.existsSync(path.join(staticDir, "iframe.html"));
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
