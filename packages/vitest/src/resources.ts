import type { CapturedResource } from "@uiverify/archive-core";

/** Per-resource size cap: a single asset larger than this is skipped (a missed asset replays as a blank,
 *  a visible gap, rather than bloating every archive). Mirrors the Playwright SDK. */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

/** How long one fetch of a resource may take. The capture runs outside the test's own timeout, so an
 *  unbounded fetch from a stalled server would hang the run; the page's attempt and the three outside it
 *  stay within Vitest's 30 s hook timeout. */
export const FETCH_TIMEOUT_MS = 5_000;

/** A fetched resource, or why it could not be fetched. */
export type FetchedResource = { resource: CapturedResource } | { error: string };

/** Fetches a resource outside the page, for when the page's own `fetch` can't (see {@link archiveResources}). */
export type FetchOutsidePage = (url: string) => Promise<FetchedResource>;

/** A resource the snapshot uses that could not be archived, so it will be missing from the replay. */
export interface MissingResource {
  url: string;
  reason: string;
}

/** The page's own `fetch`, captured at module load (this module loads with the setup file, before any
 *  test body runs), so a test that stubs `fetch` for its API mocks (`vi.stubGlobal("fetch", ...)`) does not
 *  also answer the archiver's asset requests with its mock payloads. */
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** A binary asset's path by extension. Consulted for a generic content type (a CDN or S3 bucket that serves
 *  a font as `binary/octet-stream` is common, and Chromium loads fonts and raster images by sniffing the
 *  bytes, so the live page renders it and replay can serve it under that same type), and to tell an asset
 *  from a module under Vite's `/@fs/` prefix. */
const ASSET_EXTENSION = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mp3|ogg|wav)$/i;

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
 *  throw it away by content-type. Everything else is fetched and filtered by content-type. A binary asset
 *  is never a module, even under Vite's `/@fs/` prefix: that is how Vite serves a file outside the project
 *  root or `public/`, e.g. a font `next/font/local` loads from beside the component. */
export function isModuleOrData(url: string): boolean {
  if (/^(data|blob):/.test(url)) return true;
  const path = url.split("?")[0] ?? "";
  if (/\.(m?js|cjs|ts|tsx|jsx|json|map|html)$/i.test(path)) return true;
  if (ASSET_EXTENSION.test(path)) return false;
  return /\/(@vite|@id|@fs)\//.test(url) || url.includes("/node_modules/.vite/");
}

/** Characters that can end a URL where rrweb writes one: a closing quote (JSON-escaped or not), a CSS
 *  `url()` paren, the space/comma between `srcset` candidates, or a `#fragment` (an SVG sprite's
 *  `icons.svg#name` loads `icons.svg`). */
const URL_END = new Set(['"', "\\", "'", ")", " ", ",", "#"]);

/** Whether `text` contains `url` as a whole URL, not as the prefix of a longer one (`a.png` inside
 *  `a.png?v=2`). */
function containsWholeUrl(text: string, url: string): boolean {
  for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + 1)) {
    const next = text[at + url.length];
    if (next === undefined || URL_END.has(next)) return true;
  }
  return false;
}

/** Resource Timing reports a URL absolute and percent-encoded (`http://cdn/hero%20image.png`), while rrweb
 *  can keep a stylesheet `url()` as written - unencoded (`hero image.png`) or protocol-relative
 *  (`//cdn/hero.png`) - so each of those spellings counts too. */
function urlSpellings(url: string): Set<string> {
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {
    // Malformed escapes: match the reported spelling only.
  }
  const spellings = new Set([url, decoded]);
  for (const spelling of [url, decoded]) spellings.add(spelling.replace(/^https?:/, ""));
  return spellings;
}

/** Characters that split the serialized DOM into {@link domTokens}: every {@link URL_END} but the space,
 *  plus the path and query separators. */
const TOKEN_BREAK = /[/"'\\(),#?]/;

/** Every run of text between {@link TOKEN_BREAK}s, and each whitespace-separated word of it, so a URL's last
 *  path segment is one of them wherever the DOM spells that URL out. */
function domTokens(serializedDom: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of serializedDom.split(TOKEN_BREAK)) {
    tokens.add(token);
    for (const word of token.split(/\s+/)) tokens.add(word);
  }
  return tokens;
}

/** Whether `spelling` may occur in the DOM, by its last path segment alone. A segment the tokens can't
 *  hold whole (empty, or containing a break or whitespace) always passes, to the full scan. */
function mayOccur(tokens: Set<string>, spelling: string): boolean {
  const path = spelling.split(/[?#]/)[0] ?? "";
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (!segment || /[\s"'\\(),]/.test(segment)) return true;
  return tokens.has(segment);
}

/** The loaded URLs this snapshot's serialized DOM references. Every test in a Vitest file shares one page,
 *  and the Resource Timing buffer only grows, so "everything the page has loaded" is every earlier test's
 *  assets too - a file rendering one page per test archived each page with all the pages before it. rrweb
 *  writes each `src`/`href`/`srcset` and inlined stylesheet `url()` into the DOM, usually as the same
 *  absolute string the browser reports for the request; {@link urlSpellings} lists the ones it keeps as
 *  written. The DOM is tokenized once so the full scan runs only for URLs whose file name it contains,
 *  instead of once per URL the page has ever loaded. A stylesheet rrweb can't inline (cross-origin, no CORS
 *  read) stays a `<link>`, so what it references is added by {@link archiveReferencedResources}. */
export function referencedUrls(loadedUrls: Iterable<string>, serializedDom: string): Set<string> {
  const tokens = domTokens(serializedDom);
  const out = new Set<string>();
  for (const url of loadedUrls) {
    for (const spelling of urlSpellings(url)) {
      if (mayOccur(tokens, spelling) && containsWholeUrl(serializedDom, spelling)) {
        out.add(url);
        break;
      }
    }
  }
  return out;
}

/** A CSS string or unquoted `url()` with its escapes resolved: `\20 ` is a space, `\)` a paren. */
function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\(.)/gis, (_, hex: string | undefined, char: string | undefined) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (char ?? ""),
  );
}

const CSS_STRING = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
const CSS_ESCAPE = String.raw`\\[0-9a-f]{1,6}[ \t\n\r\f]?|\\.`;
const URL_REF = new RegExp(String.raw`url\(\s*(?:${CSS_STRING}|((?:${CSS_ESCAPE}|[^)\\\s])*))\s*\)`, "gi");
const IMPORT_REF = new RegExp(String.raw`@import\s+(?:${CSS_STRING})`, "gi");
const QUOTED = new RegExp(CSS_STRING, "g");

/** The contents of each `image-set(...)` / `-webkit-image-set(...)`, whose candidates may be bare quoted
 *  strings rather than `url()`s. */
function imageSetBodies(css: string): string[] {
  const bodies: string[] = [];
  for (const match of css.matchAll(/image-set\(/gi)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    let i = start;
    for (; i < css.length && depth; i++) {
      const c = css[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    bodies.push(css.slice(start, depth ? i : i - 1));
  }
  return bodies;
}

/** The absolute URLs a stylesheet's `url(...)`, `@import` and `image-set(...)` candidates point at,
 *  resolved against the sheet's own URL the way the browser resolves them. */
export function stylesheetUrls(css: string, sheetUrl: string): string[] {
  const refs = [
    ...Array.from(css.matchAll(URL_REF), (m) => m[1] ?? m[2] ?? m[3] ?? ""),
    ...Array.from(css.matchAll(IMPORT_REF), (m) => m[1] ?? m[2] ?? ""),
    ...imageSetBodies(css).flatMap((body) => Array.from(body.matchAll(QUOTED), (m) => m[1] ?? m[2] ?? "")),
  ];
  const out: string[] = [];
  for (const ref of refs.map(unescapeCss)) {
    if (!ref || ref.startsWith("data:")) continue;
    try {
      const url = new URL(ref, sheetUrl);
      url.hash = "";
      out.push(url.href);
    } catch {
      // An unparsable reference can't have been loaded either.
    }
  }
  return out;
}

function decodeCss(resource: CapturedResource): string {
  return new TextDecoder().decode(Uint8Array.from(atob(resource.body), (c) => c.charCodeAt(0)));
}

/** The descriptors that tell one `@font-face` apart from another of the same family. */
export interface FontFaceDescriptors {
  family: string;
  style: string;
  weight: string;
  unicodeRange: string;
}

/** A unicode-range as lowercase, unpadded hex ranges (`U+0000-00FF, U+4??` → `0-ff,400-4ff`): the
 *  browser rewrites a rule's range when it builds the FontFace, so both sides are compared in this form. */
function normalizeUnicodeRange(range: string): string {
  return range
    .split(",")
    .map((token) => {
      const part = token.trim().replace(/^u\+/i, "");
      const [from = "", to] = part.includes("?")
        ? [part.replaceAll("?", "0"), part.replaceAll("?", "f")]
        : part.split("-");
      const hex = (h: string) => Number.parseInt(h, 16).toString(16);
      return to === undefined || hex(from) === hex(to) ? hex(from) : `${hex(from)}-${hex(to)}`;
    })
    .join(",");
}

/** One key per font face, equal for a CSS `@font-face` rule and the FontFace the browser built from it. */
export function fontFaceKey(face: FontFaceDescriptors): string {
  const clean = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const family = clean(face.family).replace(/^(["'])(.*)\1$/, "$2");
  return [family, clean(face.style), clean(face.weight), normalizeUnicodeRange(face.unicodeRange)].join("|");
}

/** The `format()` hints Chromium loads; a `src` candidate with any other is skipped, as the browser skips it. */
const CHROMIUM_FONT_FORMATS = new Set(
  ["woff2", "woff", "truetype", "opentype", "collection"].flatMap((format) => [format, `${format}-variations`]),
);

/** Each `@font-face` rule in a stylesheet: its key and the font file the browser would load for it (the
 *  first `src` in a format Chromium reads, resolved against the sheet's URL). */
export function fontFaceRules(css: string, sheetUrl: string): { key: string; file: string }[] {
  const rules: { key: string; file: string }[] = [];
  for (const [, body = ""] of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const descriptor = (name: string) =>
      new RegExp(String.raw`(?:^|;)\s*${name}\s*:\s*([^;]*)`, "i").exec(body)?.[1]?.trim();
    const family = descriptor("font-family");
    const src = descriptor("src");
    if (!family || !src) continue;
    const file = src
      .split(/,(?![^(]*\))/)
      .filter((candidate) => {
        const format = /format\(\s*["']?([\w-]+)/i.exec(candidate)?.[1]?.toLowerCase();
        return format === undefined || CHROMIUM_FONT_FORMATS.has(format);
      })
      .flatMap((candidate) => stylesheetUrls(candidate, sheetUrl))[0];
    if (!file) continue;
    const face = {
      family,
      style: descriptor("font-style") ?? "normal",
      weight: descriptor("font-weight") ?? "normal",
      unicodeRange: descriptor("unicode-range") ?? "U+0-10FFFF",
    };
    rules.push({ key: fontFaceKey(face), file });
  }
  return rules;
}

/** The sheets a stylesheet `@import`s (`@import "a.css"` or `@import url(a.css)`), resolved against its URL. */
function importedSheets(css: string, sheetUrl: string): string[] {
  const sheets: string[] = [];
  for (const [, rule = ""] of css.matchAll(/@import\s+([^;]+)/gi)) {
    const quoted = new RegExp(`^(?:${CSS_STRING})`).exec(rule.trim());
    const ref = quoted ? unescapeCss(quoted[1] ?? quoted[2] ?? "") : undefined;
    let url: string | undefined;
    try {
      url = ref === undefined ? stylesheetUrls(rule, sheetUrl)[0] : new URL(ref, sheetUrl).href;
    } catch {
      // An unparsable reference can't have been loaded either.
    }
    if (url) sheets.push(url);
  }
  return sheets;
}

/** Archive the loaded resources this snapshot uses: those its serialized DOM references, plus, transitively,
 *  the loaded ones an archived stylesheet references (fonts and images behind a stylesheet rrweb kept as a
 *  `<link>`, and that sheet's own `@import`s). Chromium leaves what a cross-origin `<link>` without
 *  `crossorigin` fetched out of Resource Timing, so for a cross-origin sheet its `@import`s and the font
 *  files of its faces in `loadedFontFaces` (keys of the page's loaded FontFaces) are archived too. `missing` lists what could not
 *  be archived. */
export async function archiveReferencedResources(
  loadedUrls: Iterable<string>,
  serializedDom: string,
  options: { pageOrigin?: string; loadedFontFaces?: ReadonlySet<string>; fetchOutsidePage?: FetchOutsidePage } = {},
): Promise<{ resources: Record<string, CapturedResource>; missing: MissingResource[] }> {
  const loaded = new Set(loadedUrls);
  const resources: Record<string, CapturedResource> = {};
  const missing: MissingResource[] = [];
  const attempted = new Set<string>();
  let batch = referencedUrls(loaded, serializedDom);
  while (batch.size) {
    for (const url of batch) attempted.add(url);
    const archived = await archiveResources(batch, options.fetchOutsidePage);
    Object.assign(resources, archived.resources);
    missing.push(...archived.missing);
    const next = new Set<string>();
    for (const [url, resource] of Object.entries(archived.resources)) {
      if (!resource.contentType?.toLowerCase().startsWith("text/css")) continue;
      const css = decodeCss(resource);
      const deps = stylesheetUrls(css, url).filter((dep) => loaded.has(dep));
      if (options.pageOrigin !== undefined && new URL(url).origin !== options.pageOrigin) {
        deps.push(...importedSheets(css, url));
        for (const rule of fontFaceRules(css, url)) if (options.loadedFontFaces?.has(rule.key)) deps.push(rule.file);
      }
      for (const dep of deps) if (!attempted.has(dep)) next.add(dep);
    }
    batch = next;
  }
  return { resources, missing };
}

/** base64-encode an ArrayBuffer without blowing the call stack on a large asset (chunked fromCharCode). */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Base64-encoded data's decoded size. */
function decodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

const TOO_LARGE = "larger than the 10 MB per-resource limit";

/** Fetch and base64 each visual resource. Same-origin assets (the common case for a component test served
 *  by Vite) read cleanly in the page. A cross-origin asset with no CORS headers is opaque to the page's
 *  `fetch`, and a server can refuse or fail a request the page's own load survived, so a resource the page
 *  can't read, or gets an error response for, is handed to `fetchOutsidePage`, which can read it and
 *  retries. What still fails is reported in `missing`; a successful response that isn't a visual asset (a
 *  script, JSON) is left out. */
export async function archiveResources(
  urls: Iterable<string>,
  fetchOutsidePage?: FetchOutsidePage,
): Promise<{ resources: Record<string, CapturedResource>; missing: MissingResource[] }> {
  const resources: Record<string, CapturedResource> = {};
  const missing: MissingResource[] = [];
  const fetchInPage = async (url: string): Promise<FetchedResource | "skip"> => {
    const resp = await nativeFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const contentType = resp.headers.get("content-type");
    if (Number(resp.headers.get("content-length")) > MAX_RESOURCE_BYTES) {
      await resp.body?.cancel();
      return { error: TOO_LARGE };
    }
    if (resp.status >= 500 || resp.status === 429 || !isArchivableResource(url, contentType)) {
      await resp.body?.cancel();
      if (resp.ok) return "skip";
      throw new Error(`HTTP ${resp.status}`);
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_RESOURCE_BYTES) return { error: TOO_LARGE };
    return { resource: { contentType, status: resp.status, body: toBase64(buffer) } };
  };
  await Promise.all(
    [...urls].map(async (url) => {
      let fetched: FetchedResource | "skip";
      try {
        fetched = await fetchInPage(url);
      } catch (err) {
        fetched = fetchOutsidePage
          ? await fetchOutsidePage(url)
          : { error: err instanceof Error ? err.message : String(err) };
      }
      if (fetched === "skip") return;
      if ("error" in fetched) return void missing.push({ url, reason: fetched.error });
      const { resource } = fetched;
      if (!isArchivableResource(url, resource.contentType)) {
        if (resource.status >= 400) missing.push({ url, reason: `HTTP ${resource.status}` });
        return;
      }
      if (decodedBytes(resource.body) > MAX_RESOURCE_BYTES) return void missing.push({ url, reason: TOO_LARGE });
      resources[url] = resource;
    }),
  );
  return { resources, missing };
}
