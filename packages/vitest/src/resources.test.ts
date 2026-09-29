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

describe("referencedUrls", () => {
  /** Catches the page-accumulation bug: every test in a file shares one page, so the loaded-resource list
   *  holds earlier tests' images; a snapshot must keep only what its own DOM references. */
  it("keeps only the loaded URLs the serialized DOM references", async () => {
    const { referencedUrls } = await loadWithPageFetch(serving({}));
    const dom = JSON.stringify({
      tagName: "img",
      attributes: { src: "http://localhost:5173/blog/post-2/cover.webp" },
      style: "@font-face{src:url(https://fonts.gstatic.com/s/geist/a.woff2)}",
    });
    const loaded = [
      "http://localhost:5173/blog/post-1/cover.webp",
      "http://localhost:5173/blog/post-2/cover.webp",
      "https://fonts.gstatic.com/s/geist/a.woff2",
    ];
    expect([...referencedUrls(loaded, dom)]).toEqual([
      "http://localhost:5173/blog/post-2/cover.webp",
      "https://fonts.gstatic.com/s/geist/a.woff2",
    ]);
  });
});

describe("isModuleOrData", () => {
  /** Catches the /@fs/ blanket skip: a font next/font/local serves through Vite's /@fs/ prefix must be
   *  archived, or the replay falls back to a system font. Modules under the same prefix stay skipped. */
  it("keeps a binary asset served under Vite's /@fs/ prefix, skips a module there", async () => {
    const { isModuleOrData } = await loadWithPageFetch(serving({}));
    expect(isModuleOrData("http://localhost:5173/@fs/Users/me/app/app/fonts/geist-latin.woff2")).toBe(false);
    expect(isModuleOrData("http://localhost:5173/@fs/Users/me/app/src/Button.tsx?v=1")).toBe(true);
    expect(isModuleOrData("http://localhost:5173/@fs/Users/me/app/node_modules/x/index.js")).toBe(true);
    expect(isModuleOrData("http://localhost:5173/@fs/Users/me/app/src/logo.svg")).toBe(false);
  });
});

describe("referencedUrls boundaries", () => {
  it("does not count a URL that only prefixes a longer referenced one", async () => {
    const { referencedUrls } = await loadWithPageFetch(serving({}));
    const dom = JSON.stringify({ attributes: { src: "https://cdn.test/image.png?v=2" } });
    expect([...referencedUrls(["https://cdn.test/image.png", "https://cdn.test/image.png?v=2"], dom)]).toEqual([
      "https://cdn.test/image.png?v=2",
    ]);
  });
});

describe("archiveReferencedResources", () => {
  const SHEET = "https://fonts.example.com/css2?family=Brand";
  const PAGE_IMG = "http://localhost:5173/hero.png";
  const OTHER_TEST_IMG = "http://localhost:5173/earlier-test.png";

  /** Catches the linked-stylesheet regression: a cross-origin sheet rrweb can't inline stays a <link>, so
   *  the fonts it loads appear only inside that sheet, never in the DOM - they must still be archived. */
  it("archives the DOM's own resources plus what an archived stylesheet references, nothing else", async () => {
    const { archiveReferencedResources } = await loadWithPageFetch(
      serving({
        [SHEET]: ["text/css", `@font-face{src:url(${FONT_URL})} .x{background:url("../img/bg.png")}`],
        [FONT_URL]: ["font/woff2", FONT_BYTES],
        ["https://fonts.example.com/img/bg.png"]: ["image/png", new Uint8Array([1])],
        [PAGE_IMG]: ["image/png", new Uint8Array([2])],
        [OTHER_TEST_IMG]: ["image/png", new Uint8Array([3])],
      }),
    );
    const dom = JSON.stringify({ link: { href: SHEET }, img: { src: PAGE_IMG } });
    const loaded = [SHEET, FONT_URL, "https://fonts.example.com/img/bg.png", PAGE_IMG, OTHER_TEST_IMG];
    const archived = await archiveReferencedResources(loaded, dom);
    expect(Object.keys(archived).sort()).toEqual(
      [SHEET, FONT_URL, "https://fonts.example.com/img/bg.png", PAGE_IMG].sort(),
    );
  });
});

describe("archiveReferencedResources URL spellings", () => {
  /** Catches the ways the DOM or a stylesheet spells a loaded URL differently from Resource Timing: an
   *  SVG sprite's #fragment, an unencoded space or protocol-relative URL rrweb keeps in a url(), uppercase
   *  CSS keywords, and an @import chain two sheets deep. Each one missed drops a loaded asset from the
   *  archive. */
  it("matches fragments, encoded spaces, protocol-relative URLs, uppercase CSS keywords, and nested @imports", async () => {
    const base = "http://localhost:5173";
    const png = ["image/png", new Uint8Array([1])] as const;
    const { archiveReferencedResources } = await loadWithPageFetch(
      serving({
        [`${base}/sprite.svg`]: ["image/svg+xml", "<svg/>"],
        [`${base}/hero%20image.png`]: [...png],
        [`${base}/a.css`]: ["text/css", '@IMPORT "b.css";'],
        [`${base}/b.css`]: ["text/css", ".i{background:URL(icons.png#x)}"],
        [`${base}/icons.png`]: [...png],
        ["http://cdn.test/pr.png"]: [...png],
      }),
    );
    const dom = JSON.stringify({
      use: { href: `${base}/sprite.svg#view` },
      style: `.hero{background:url("${base}/hero image.png")} .cdn{background:url(//cdn.test/pr.png)}`,
      link: { href: `${base}/a.css` },
    });
    const loaded = [
      `${base}/sprite.svg`,
      `${base}/hero%20image.png`,
      `${base}/a.css`,
      `${base}/b.css`,
      `${base}/icons.png`,
      "http://cdn.test/pr.png",
    ];
    const archived = await archiveReferencedResources(loaded, dom);
    expect(Object.keys(archived).sort()).toEqual([...loaded].sort());
  });
});
