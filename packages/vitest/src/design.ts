import { nativeFetch, toBase64 } from "./resources";

/** A design image as `takeSnapshot` takes it: a URL or PNG data URI, or an image-import object with a
 *  `src` (what Next.js image handling resolves a PNG import to). */
export type DesignImage = string | { src: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A declared design as a PNG data URI. A data URI is taken as-is; any other string (or an import object's
 *  `src`) is the URL an image import resolves to, fetched from the dev server because the browser has no
 *  filesystem. `baseUrl` resolves a root-relative import URL. */
export async function designDataUri(id: string, image: unknown, baseUrl: string): Promise<string> {
  const fail = (why: string) =>
    new Error(
      `@uiverify/vitest: baselineImage for "${id}" ${why}. Pass a PNG import, e.g. import design from "./home.png".`,
    );
  const src =
    typeof image === "string"
      ? image
      : typeof image === "object" && image !== null && "src" in image && typeof image.src === "string"
        ? image.src
        : undefined;
  if (!src) throw fail(`is ${image === undefined ? "undefined" : "not an image import"}`);
  if (src.startsWith("data:")) {
    if (!isPng(dataUriHead(src))) throw fail("is not a PNG data URI");
    return src;
  }
  const url = new URL(src, baseUrl).href;
  const res = await nativeFetch(url);
  if (!res.ok) throw fail(`could not be loaded from ${url} (HTTP ${res.status})`);
  const buffer = await res.arrayBuffer();
  if (!isPng(new Uint8Array(buffer))) throw fail(`at ${url} is not a PNG`);
  return `data:image/png;base64,${toBase64(buffer)}`;
}

/** The first bytes of a `data:image/png;base64,` URI, or none when it isn't one or doesn't decode. */
function dataUriHead(src: string): Uint8Array {
  const prefix = "data:image/png;base64,";
  if (!src.startsWith(prefix)) return new Uint8Array();
  try {
    return Uint8Array.from(atob(src.slice(prefix.length, prefix.length + 12)), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/** UI Verify compares against PNG only, so a mislabelled image would fail the snapshot on every build. */
function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}
