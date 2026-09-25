import type { ArchivedResource } from "@uiverify/archive-core";

/** Per-resource size cap: a single asset larger than this is skipped (a missed asset replays as a blank,
 *  a visible gap, rather than bloating every archive). Mirrors the Playwright SDK. */
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

/** The page's own `fetch`, captured at module load (this module loads with the setup file, before any
 *  test body runs), so a test that stubs `fetch` for its API mocks (`vi.stubGlobal("fetch", ...)`) does not
 *  also answer the archiver's asset requests with its mock payloads. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** A binary asset's path by extension. Consulted only for a generic content type: a CDN or S3 bucket that
 *  serves a font as `binary/octet-stream` is common, and Chromium loads fonts and raster images by
 *  sniffing the bytes, so the live page renders it and replay can serve it under that same type. */
const ASSET_EXTENSION = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|ogg|wav)$/i;

function isGenericContentType(ct: string): boolean {
  return ct === "" || ct.startsWith("application/octet-stream") || ct.startsWith("binary/octet-stream");
}

/** Only visual assets are archived for a static re-render. We fetch a candidate, then keep it only if its
 *  content-type is one of these families - so a JS/JSON/HTML response the DOM does not reference is never
 *  stored (it would only bloat the bundle; the app's JS never re-runs on replay). */
export function isArchivableResource(url: string, contentType: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (isGenericContentType(ct)) return ASSET_EXTENSION.test(new URL(url).pathname);
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
export function isModuleOrData(url: string): boolean {
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

/** Fetch and base64 each visual resource. Same-origin assets (the common case for a component test served
 *  by Vite) read cleanly; a cross-origin asset with no CORS headers throws on `.arrayBuffer()` and is
 *  skipped, so it replays as a gap rather than a crash. */
export async function archiveResources(urls: Iterable<string>): Promise<Record<string, ArchivedResource>> {
  const out: Record<string, ArchivedResource> = {};
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const resp = await nativeFetch(url);
        const contentType = resp.headers.get("content-type");
        if (!isArchivableResource(url, contentType)) return;
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
