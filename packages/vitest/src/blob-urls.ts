import type { serializedNodeWithId } from "@rrweb/types";

/** Replace each `blob:` image source in a serialized DOM (an `<img>`'s `src`, or a `srcset` candidate) with
 *  the image as a data URI, read by `toDataUri`. An object URL lives only as long as the page that created
 *  it, so the replay could never load it. An image that can't be read (revoked once it loaded, say) keeps
 *  its `blob:` URL and replays broken; those URLs are returned. */
export async function inlineBlobImages(
  root: serializedNodeWithId,
  toDataUri: (blobUrl: string) => Promise<string>,
): Promise<string[]> {
  const dataUris = new Map<string, Promise<string | undefined>>();
  const read = (url: string) => {
    let dataUri = dataUris.get(url);
    if (!dataUri) dataUris.set(url, (dataUri = toDataUri(url).catch(() => undefined)));
    return dataUri;
  };
  const rewrites: Promise<void>[] = [];
  const visit = (node: serializedNodeWithId) => {
    if ("tagName" in node && node.tagName === "img") {
      const { attributes } = node;
      const src = attributes.src;
      if (typeof src === "string" && src.startsWith("blob:")) {
        rewrites.push(read(src).then((dataUri) => void (dataUri && (attributes.src = dataUri))));
      }
      const srcset = attributes.srcset;
      if (typeof srcset === "string" && srcset.includes("blob:")) {
        const blobs = srcset.match(/blob:[^\s,]+/g) ?? [];
        rewrites.push(
          Promise.all(blobs.map(async (blob) => ({ blob, dataUri: await read(blob) }))).then((pairs) => {
            let rewritten = srcset;
            for (const { blob, dataUri } of pairs) if (dataUri) rewritten = rewritten.replaceAll(blob, dataUri);
            attributes.srcset = rewritten;
          }),
        );
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(root);
  await Promise.all(rewrites);
  const unreadable: string[] = [];
  for (const [url, dataUri] of dataUris) if (!(await dataUri)) unreadable.push(url);
  return unreadable;
}
