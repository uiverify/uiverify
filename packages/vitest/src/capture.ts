import { commands } from "@vitest/browser/context";
import { snapshot } from "rrweb-snapshot";
import type { ArchivedResource, ArchivedSnapshot } from "@uiverify/archive-core";
import { snapshotIds, type TaskLike } from "./snapshot-id";

/**
 * The browser half of @uiverify/vitest. In Vitest browser mode the test body runs INSIDE the page, so
 * unlike the Playwright SDK there is no cross-process `page.evaluate`: we serialize the live document
 * with rrweb-snapshot in the same realm, collect the bytes of every resource the page loaded, and hand
 * the assembled {@link ArchivedSnapshot} to the Node side over a Vitest browser command, which writes it
 * to disk. Nothing here touches the filesystem (there is none in the browser).
 */

/** The Node-side command the plugin registers, added to the interface `@vitest/browser/context` reads
 *  its `commands` from, so `commands.__uiverifyWriteSnapshot` is typed. */
declare module "vitest/internal/browser" {
  interface BrowserCommands {
    __uiverifyWriteSnapshot: (snapshot: ArchivedSnapshot) => Promise<void>;
  }
}

/** Per-resource size cap: a single asset larger than this is skipped (a missed asset replays as a blank,
 *  a visible gap, rather than bloating every archive). Mirrors the Playwright SDK. */
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

/** Only visual assets are archived for a static re-render. We fetch a candidate, then keep it only if its
 *  content-type is one of these families - so a JS/JSON/HTML response the DOM does not reference is never
 *  stored (it would only bloat the bundle; the app's JS never re-runs on replay). */
function isArchivableContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("image/") ||
    ct.startsWith("font/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    ct.startsWith("text/css") ||
    ct.startsWith("application/font") ||
    ct.startsWith("application/x-font") ||
    ct.startsWith("application/vnd.ms-fontobject")
  );
}

/** Skip obvious module/data URLs before fetching, so we do not download the test's JS bundle just to
 *  throw it away by content-type. Everything else is fetched and filtered by content-type. */
function isModuleOrData(url: string): boolean {
  if (/^(data|blob):/.test(url)) return true;
  const path = url.split("?")[0];
  if (/\.(m?js|cjs|ts|tsx|jsx|json|map|html)$/i.test(path)) return true;
  return /\/(@vite|@id|@fs)\//.test(url) || url.includes("/node_modules/.vite/");
}

/** base64-encode an ArrayBuffer without blowing the call stack on a large asset (chunked fromCharCode). */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Fetch and base64 every visual resource the page loaded (via the Resource Timing API). Same-origin
 *  assets (the common case for a component test served by Vite) read cleanly; a cross-origin asset with
 *  no CORS headers throws on `.arrayBuffer()` and is skipped, so it replays as a gap rather than a crash. */
async function collectResources(): Promise<Record<string, ArchivedResource>> {
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType("resource")) {
    if (/^https?:/.test(entry.name) && !isModuleOrData(entry.name)) urls.add(entry.name);
  }
  const out: Record<string, ArchivedResource> = {};
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const resp = await fetch(url);
        const contentType = resp.headers.get("content-type");
        if (!isArchivableContentType(contentType)) return;
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > MAX_RESOURCE_BYTES) return;
        out[url] = { contentType, status: resp.status, body: toBase64(buffer) };
      } catch {
        // Opaque/cross-origin/aborted: not archivable, so leave it out (replay shows a blank, never hangs).
      }
    }),
  );
  return out;
}

/** Serialize the page's current DOM into an {@link ArchivedSnapshot} and write it via the Node command.
 *  `name` distinguishes multiple captures within one test; omit it for a test's single auto-snapshot. */
export async function capture(task: TaskLike, name: string): Promise<string> {
  const { id, title } = snapshotIds(task, name);

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

  const resources = await collectResources();
  const deviceScaleFactor = window.devicePixelRatio || undefined;
  const colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const);
  const archived: ArchivedSnapshot = {
    id,
    title,
    name,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    colorScheme,
    dom,
    resources,
  };

  await commands.__uiverifyWriteSnapshot(archived);
  return id;
}
