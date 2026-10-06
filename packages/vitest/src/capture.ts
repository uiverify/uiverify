import { commands } from "vitest/browser";
import { snapshot } from "rrweb-snapshot";
import type { CapturedSnapshot } from "@uiverify/archive-core";
import type { TaskLike } from "./snapshot-id";
import { inlineBlobImages } from "./blob-urls";
import { type DesignImage, designDataUri } from "./design";
import {
  archiveReferencedResources,
  type FetchedResource,
  fontFaceKey,
  isModuleOrData,
  MAX_RESOURCE_BYTES,
  nativeFetch,
} from "./resources";
import { settle } from "./settle";
import pkg from "../package.json";

/** Stamped into every snapshot so the CLI can report the capture SDK's version at upload. Inlined at
 *  build time (tsup bundles the JSON import), so it tracks the published version automatically. */
const PRODUCER = { name: pkg.name, version: pkg.version };

/**
 * The browser half of @uiverify/vitest. In Vitest browser mode the test body runs INSIDE the page, so
 * unlike the Playwright SDK there is no cross-process `page.evaluate`: we serialize the live document
 * with rrweb-snapshot in the same realm, collect the bytes of every loaded resource the snapshot references,
 * and hand the assembled {@link CapturedSnapshot} to the Node side over a Vitest browser command, which
 * writes it to disk. Nothing here touches the filesystem (there is none in the browser).
 */

/** The Node-side commands the plugin registers, added to the interface `vitest/browser` reads its
 *  `commands` from, so they are typed. */
declare module "vitest/internal/browser" {
  interface BrowserCommands {
    __uiverifyWriteSnapshot: (snapshot: CapturedSnapshot) => Promise<void>;
    __uiverifyFetchResource: (url: string) => Promise<FetchedResource>;
  }
}

/** Resource Timing, read through the real `performance` captured at module load: the automatic snapshot
 *  runs before the test's `afterEach` hooks, so while `vi.useFakeTimers()` is still installed, and its fake
 *  `performance` lists no resources. */
const resourceEntries = performance.getEntriesByType.bind(performance, "resource");

/** Archive the visual resources the page loaded (rediscovered via the Resource Timing API) that this
 *  snapshot uses, warning about each one that could not be archived: the replay is hermetic, so it renders
 *  without it (a fallback font, a broken image) and the capture comes back "changed" for no visible reason. */
async function collectResources(id: string, dom: CapturedSnapshot["dom"]): Promise<CapturedSnapshot["resources"]> {
  const loaded = new Set<string>();
  for (const entry of resourceEntries()) {
    if (/^https?:/.test(entry.name) && !isModuleOrData(entry.name)) loaded.add(entry.name);
  }
  const loadedFontFaces = new Set(
    Array.from(document.fonts)
      .filter((face) => face.status === "loaded")
      .map(fontFaceKey),
  );
  const { resources, missing } = await archiveReferencedResources(loaded, JSON.stringify(dom), {
    pageOrigin: location.origin,
    loadedFontFaces,
    fetchOutsidePage: (url) => commands.__uiverifyFetchResource(url),
  });
  for (const { url, reason } of missing) warnNotArchived(id, url, reason);
  return resources;
}

function warnNotArchived(id: string, url: string, reason: string): void {
  console.warn(`[uiverify] "${id}": could not archive ${url} (${reason}). UI Verify will replay this snapshot without it.`);
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

/** Serialize the page's current DOM into a {@link CapturedSnapshot}, ready for {@link writeCaptured}.
 *  `name` distinguishes multiple captures within one test; it is empty for a test's single auto-snapshot. */
export async function capture(
  task: TaskLike,
  { id, title }: { id: string; title: string },
  name: string,
  options: { baselineImage?: DesignImage } = {},
): Promise<CapturedSnapshot> {
  // Checked by key, not value: `baselineImage: design.src` is undefined when the import is already a string,
  // and that must fail loudly rather than silently capture with no design.
  const design =
    "baselineImage" in options ? await designDataUri(id, options.baselineImage, location.href) : undefined;

  // Settle fonts and images before serializing, so every resource the page shows is loaded and captured:
  // the archive is a static snapshot, so a font or image still loading at capture would be absent from it
  // (a fallback glyph / a broken image). Time-boxed inside settle().
  await settle();

  // `slimDOM.script` drops <script> nodes: the archive replays as static, settled pixels, so the app's
  // JS must not re-run on replay. `inlineStylesheet` folds same-origin CSS into the DOM (no CSS fetch on
  // replay); images stay URLs, served from the resource archive. `recordCanvas` captures canvas pixels,
  // but a tainted/cross-origin canvas makes it throw - fall back to skipping canvas rather than failing.
  const serialize = (recordCanvas: boolean) =>
    snapshot(document, { inlineStylesheet: true, recordCanvas, slimDOM: { script: true } });
  let dom: ReturnType<typeof serialize>;
  try {
    dom = serialize(true);
  } catch {
    dom = serialize(false);
  }
  if (!dom) throw new Error(`@uiverify/vitest: rrweb failed to serialize the DOM for "${id}"`);

  for (const url of await inlineBlobImages(dom, blobToDataUri)) warnNotArchived(id, url, "the blob: URL can't be read");
  const resources = await collectResources(id, dom);
  const deviceScaleFactor = window.devicePixelRatio || undefined;
  const colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const);
  return {
    id,
    title,
    name,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    colorScheme,
    dom,
    resources,
    producer: PRODUCER,
    // The test file (project-root-relative), so UI Verify can locate this snapshot in the module graph
    // for skip-unchanged. `task.file.name` is already root-relative — the same value snapshot ids derive
    // their first segment from — so it lines up with the graph names the reporter emits.
    ...(task.file?.name ? { sourcePath: task.file.name } : {}),
    ...(design ? { baselineImage: design } : {}),
  };
}

/** Hand a captured snapshot to the Node command that writes it into the archive. */
export function writeCaptured(snapshot: CapturedSnapshot): Promise<void> {
  return commands.__uiverifyWriteSnapshot(snapshot);
}
