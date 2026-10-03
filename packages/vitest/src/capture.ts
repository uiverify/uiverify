import { commands } from "vitest/browser";
import { snapshot } from "rrweb-snapshot";
import type { CapturedResource, CapturedSnapshot } from "@uiverify/archive-core";
import { snapshotIds, type TaskLike } from "./snapshot-id";
import { type DesignImage, designDataUri } from "./design";
import { archiveReferencedResources, isModuleOrData } from "./resources";
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

/** The Node-side command the plugin registers, added to the interface `vitest/browser` reads its
 *  `commands` from, so `commands.__uiverifyWriteSnapshot` is typed. */
declare module "vitest/internal/browser" {
  interface BrowserCommands {
    __uiverifyWriteSnapshot: (snapshot: CapturedSnapshot) => Promise<void>;
  }
}

/** Archive the visual resources the page loaded (rediscovered via the Resource Timing API) that this
 *  snapshot uses. */
async function collectResources(dom: CapturedSnapshot["dom"]): Promise<Record<string, CapturedResource>> {
  const loaded = new Set<string>();
  for (const entry of performance.getEntriesByType("resource")) {
    if (/^https?:/.test(entry.name) && !isModuleOrData(entry.name)) loaded.add(entry.name);
  }
  return archiveReferencedResources(loaded, JSON.stringify(dom));
}

/** Serialize the page's current DOM into a {@link CapturedSnapshot} and write it via the Node command.
 *  `name` distinguishes multiple captures within one test; omit it for a test's single auto-snapshot. */
export async function capture(
  task: TaskLike,
  name: string,
  options: { baselineImage?: DesignImage } = {},
): Promise<string> {
  const { id, title } = snapshotIds(task, name);
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

  const resources = await collectResources(dom);
  const deviceScaleFactor = window.devicePixelRatio || undefined;
  const colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const);
  const archived: CapturedSnapshot = {
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

  await commands.__uiverifyWriteSnapshot(archived);
  return id;
}
