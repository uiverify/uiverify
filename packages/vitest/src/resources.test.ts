import { afterEach, describe, expect, it, vi } from "vitest";

const FONT_URL = "https://cdn.example.com/fonts/Brand-Regular.woff2";
const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]);

/** A `fetch` that serves each url's `[contentType, body]`, standing in for the network. */
function serving(routes: Record<string, [contentType: string | null, body: BodyInit]>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const [contentType, body] = route;
    const response = new Response(body, { status: 200 });
    if (contentType) response.headers.set("content-type", contentType);
    else response.headers.delete("content-type");
    return response;
  });
}

/** Loads the module under a given page `fetch`, the way the setup file loads it before any test body. */
async function loadWithPageFetch(pageFetch: typeof fetch) {
  vi.resetModules();
  vi.stubGlobal("fetch", pageFetch);
  return import("./resources");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("archiveResources", () => {
  it("archives a web font a CDN serves as binary/octet-stream (would catch: the font dropped, replay falls back to a system font)", async () => {
    const { archiveResources } = await loadWithPageFetch(
      serving({ [FONT_URL]: ["binary/octet-stream", FONT_BYTES] }),
    );
    const archived = await archiveResources([FONT_URL]);
    expect(archived[FONT_URL]?.body).toBe(Buffer.from(FONT_BYTES).toString("base64"));
  });

  it("archives fonts and images served as application/octet-stream or with no content type", async () => {
    const png = "https://bucket.s3.amazonaws.com/avatars/42.png?X-Amz-Signature=abc";
    const ttf = "https://cdn.example.com/Brand.ttf";
    const { archiveResources } = await loadWithPageFetch(
      serving({ [png]: ["application/octet-stream", "png"], [ttf]: [null, "ttf"] }),
    );
    expect(Object.keys(await archiveResources([png, ttf])).sort()).toEqual([ttf, png].sort());
  });

  it("does not archive an HTML fallback page served for an asset url", async () => {
    const missing = "https://app.example.com/missing.png";
    const { archiveResources } = await loadWithPageFetch(serving({ [missing]: ["text/html", "<html></html>"] }));
    expect(await archiveResources([missing])).toEqual({});
  });

  it("does not archive an octet-stream response whose url is not a known asset", async () => {
    const blob = "https://api.example.com/download";
    const { archiveResources } = await loadWithPageFetch(serving({ [blob]: ["application/octet-stream", "x"] }));
    expect(await archiveResources([blob])).toEqual({});
  });

  it("fetches through the page's own fetch even after a test stubs fetch for its API mocks (would catch: assets archived as the mock's JSON, or dropped)", async () => {
    const { archiveResources } = await loadWithPageFetch(serving({ [FONT_URL]: ["font/woff2", FONT_BYTES] }));
    vi.stubGlobal("fetch", serving({ [FONT_URL]: ["application/json", "{}"] }));
    const archived = await archiveResources([FONT_URL]);
    expect(archived[FONT_URL]?.contentType).toBe("font/woff2");
  });
});
