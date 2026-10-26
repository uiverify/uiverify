import type { serializedNodeWithId } from "@rrweb/types";
import { snapshot } from "rrweb-snapshot";
import type { CapturedResource } from "../archive-types";
import { inlineBlobImages } from "./blob-urls";
import {
  archiveReferencedResources,
  beforeDeadline,
  type FetchOutsidePage,
  fontFaceKey,
  isModuleOrData,
  MAX_RESOURCE_BYTES,
  nativeFetch,
} from "./resources";

/** Resource Timing, read through the real `performance` captured at module load: a capture can run while a
 *  test's fake timers are installed, and a fake `performance` lists no resources. */
const resourceEntries = performance.getEntriesByType.bind(performance, "resource");

/** Lift the Resource Timing buffer's default 250-entry cap. Capture rediscovers every asset to archive from
 *  `performance.getEntriesByType("resource")`, and once the buffer is full the browser silently drops later
 *  entries, so an image requested after its page's JS graph would render on screen but replay as a blank.
 *  Call it before the app loads anything. */
export function raiseResourceTimingBuffer(): void {
  performance.setResourceTimingBufferSize?.(1_000_000);
}

/** The live document, serialized by rrweb. `slimDOM.script` drops `<script>` nodes: the archive replays as
 *  static, settled pixels, so the app's JS must not re-run. `inlineStylesheet` folds same-origin CSS into the
 *  DOM; images stay URLs, served from the resource archive. `recordCanvas` captures canvas pixels, but a
 *  tainted canvas makes it throw, so it falls back to skipping canvas. `null` when rrweb serializes nothing. */
export function serializeDocument(): serializedNodeWithId | null {
  const serialize = (recordCanvas: boolean) =>
    snapshot(document, { inlineStylesheet: true, recordCanvas, slimDOM: { script: true } });
  try {
    return serialize(true);
  } catch {
    return serialize(false);
  }
}

/** Where a capture's "could not archive" warnings go: the console, unless the page's console isn't the
 *  test run's (a page driven from another process). */
export type Warn = (message: string) => void;

const consoleWarn: Warn = (message) => console.warn(message);

export function warnNotArchived(id: string, url: string, reason: string, warn: Warn = consoleWarn): void {
  warn(`[uiverify] "${id}": could not archive ${url} (${reason}). UI Verify will replay this snapshot without it.`);
}

async function blobToDataUri(blobUrl: string): Promise<string> {
  const blob = await (await nativeFetch(blobUrl)).blob();
  if (blob.size > MAX_RESOURCE_BYTES) throw new Error("larger than the per-resource limit");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(reader.error));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Replace each `blob:` image in `dom` with its data URI, warning about any that can't be read (by `deadline`,
 *  a `performance.now()` time, when given). */
export async function inlineBlobs(
  id: string,
  dom: serializedNodeWithId,
  options: { deadline?: number; warn?: Warn } = {},
): Promise<void> {
  const { deadline } = options;
  const read = deadline === undefined ? blobToDataUri : (url: string) => beforeDeadline(blobToDataUri(url), deadline);
  for (const url of await inlineBlobImages(dom, read)) {
    warnNotArchived(id, url, "the blob: URL can't be read", options.warn);
  }
}

/** Archive the visual resources the page loaded that `dom` uses, warning about each one that could not be
 *  archived: the replay is hermetic, so it renders without it (a fallback font, a broken image) and the
 *  capture comes back "changed" for no visible reason. The loaded set is Resource Timing plus `loaded`, for
 *  what Resource Timing doesn't list; `skipFrames` leaves out the documents frames loaded, for an SDK that
 *  can't read a cross-site frame's document and would otherwise warn about every one. */
export async function collectResources(
  id: string,
  dom: serializedNodeWithId,
  options: {
    loaded?: Iterable<string>;
    fetchOutsidePage?: FetchOutsidePage;
    deadline?: number;
    warn?: Warn;
    skipFrames?: boolean;
  } = {},
): Promise<Record<string, CapturedResource>> {
  const loaded = new Set<string>();
  const entries = resourceEntries().filter(
    (entry) => !(options.skipFrames && entry instanceof PerformanceResourceTiming && entry.initiatorType === "iframe"),
  );
  for (const url of [...entries.map((entry) => entry.name), ...(options.loaded ?? [])]) {
    if (/^https?:/.test(url) && !isModuleOrData(url)) loaded.add(url);
  }
  const loadedFontFaces = new Set(
    Array.from(document.fonts)
      .filter((face) => face.status === "loaded")
      .map(fontFaceKey),
  );
  const { resources, missing } = await archiveReferencedResources(loaded, JSON.stringify(dom), {
    pageOrigin: location.origin,
    loadedFontFaces,
    fetchOutsidePage: options.fetchOutsidePage,
    deadline: options.deadline,
  });
  for (const { url, reason } of missing) warnNotArchived(id, url, reason, options.warn);
  return resources;
}
