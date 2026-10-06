import { FETCH_TIMEOUT_MS, type FetchedResource, isArchivableResource, MAX_RESOURCE_BYTES } from "./resources";

const ATTEMPTS = 3;
const TOO_LARGE = "larger than the 10 MB per-resource limit";

/** The response body, or null once it passes the size cap: a server that sends no `Content-Length` could
 *  otherwise stream an unbounded body into memory. */
async function readCapped(resp: Response): Promise<Buffer | null> {
  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > MAX_RESOURCE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}

/** Fetch a resource from Node, for the capture in the page: Node isn't subject to CORS, so it can read a
 *  cross-origin asset the page's `fetch` only sees as opaque. A network error, a 5xx or a 429 is retried
 *  with backoff, since the page did load the resource once and the failure is most likely transient. Only
 *  an image, font, stylesheet or media file is ever returned: any script in the test page can call this
 *  command, and it must not become a way to read other responses from Node's side of the network. */
export async function fetchResource(
  url: string,
  backoffMs = 250,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedResource> {
  if (!/^https?:/.test(url)) return { error: "not an http(s) URL" };
  let error = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const contentType = resp.headers.get("content-type");
      if (resp.status >= 500 || resp.status === 429) {
        error = `HTTP ${resp.status}`;
        await resp.body?.cancel();
        continue;
      }
      if (!isArchivableResource(url, contentType)) {
        await resp.body?.cancel();
        return { error: resp.ok ? "not an image, font or stylesheet" : `HTTP ${resp.status}` };
      }
      const bytes = await readCapped(resp);
      if (!bytes) return { error: TOO_LARGE };
      return { resource: { contentType, status: resp.status, body: bytes.toString("base64") } };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { error };
}
