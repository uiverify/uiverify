import { commands } from "vitest/browser";
import type { CapturedSnapshot } from "@uiverify/archive-core";
import { collectResources, type FetchedResource, inlineBlobs, serializeDocument, settle } from "@uiverify/archive-core/browser";
import type { TaskLike } from "./snapshot-id";
import { type DesignImage, designDataUri } from "./design";
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

  const dom = serializeDocument();
  if (!dom) throw new Error(`@uiverify/vitest: rrweb failed to serialize the DOM for "${id}"`);

  await inlineBlobs(id, dom);
  const resources = await collectResources(id, dom, {
    fetchOutsidePage: (url) => commands.__uiverifyFetchResource(url),
  });
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
