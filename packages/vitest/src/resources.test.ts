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

/** The real key function, for building the expected keys outside a test's freshly loaded module. */
const { fontFaceKey: fontFaceKeyOf } = await import("./resources");

/** A page `fetch` that can't read anything, the way it fails on a cross-origin response with no CORS headers. */
function rejecting(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("Failed to fetch");
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
    expect(archived.resources[FONT_URL]?.body).toBe(Buffer.from(FONT_BYTES).toString("base64"));
  });

  it("archives fonts and images served as application/octet-stream or with no content type", async () => {
    const png = "https://bucket.s3.amazonaws.com/avatars/42.png?X-Amz-Signature=abc";
    const ttf = "https://cdn.example.com/Brand.ttf";
    const { archiveResources } = await loadWithPageFetch(
      serving({ [png]: ["application/octet-stream", "png"], [ttf]: [null, "ttf"] }),
    );
    expect(Object.keys((await archiveResources([png, ttf])).resources).sort()).toEqual([ttf, png].sort());
  });

  it("does not archive an HTML fallback page served for an asset url", async () => {
    const missing = "https://app.example.com/missing.png";
    const { archiveResources } = await loadWithPageFetch(serving({ [missing]: ["text/html", "<html></html>"] }));
    expect((await archiveResources([missing])).resources).toEqual({});
  });

  it("does not archive an octet-stream response whose url is not a known asset", async () => {
    const blob = "https://api.example.com/download";
    const { archiveResources } = await loadWithPageFetch(serving({ [blob]: ["application/octet-stream", "x"] }));
    expect((await archiveResources([blob])).resources).toEqual({});
  });

  it("fetches through the page's own fetch even after a test stubs fetch for its API mocks (would catch: assets archived as the mock's JSON, or dropped)", async () => {
    const { archiveResources } = await loadWithPageFetch(serving({ [FONT_URL]: ["font/woff2", FONT_BYTES] }));
    vi.stubGlobal("fetch", serving({ [FONT_URL]: ["application/json", "{}"] }));
    const archived = await archiveResources([FONT_URL]);
    expect(archived.resources[FONT_URL]?.contentType).toBe("font/woff2");
  });

  /** Catches a cross-origin image served without CORS headers (Google's favicon service, avatar.vercel.sh)
   *  being dropped: the page's fetch can't read an opaque response, so it must be fetched outside the page. */
  it("archives what the page can't read by fetching it outside the page", async () => {
    const favicon = "https://www.google.com/s2/favicons?domain=github.com";
    const { archiveResources } = await loadWithPageFetch(rejecting());
    const outside = vi.fn(async () => ({ resource: { contentType: "image/png", status: 200, body: "iVBO" } }));
    const archived = await archiveResources([favicon], outside);
    expect(outside).toHaveBeenCalledWith(favicon);
    expect(archived.resources[favicon]?.body).toBe("iVBO");
    expect(archived.missing).toEqual([]);
  });

  /** Catches a font the page loaded but the capture's re-fetch got a server error for being silently left
   *  out (the replay then falls back to a system font with no warning). */
  it("hands a 5xx to the outside fetch and reports what still fails", async () => {
    const { archiveResources } = await loadWithPageFetch(
      vi.fn(async () => new Response("busy", { status: 503, headers: { "content-type": "text/html" } })),
    );
    const archived = await archiveResources([FONT_URL], async () => ({ error: "HTTP 503" }));
    expect(archived.resources).toEqual({});
    expect(archived.missing).toEqual([{ url: FONT_URL, reason: "HTTP 503" }]);
  });

  /** Catches a rate-limited re-fetch in the page being given up on instead of retried outside it. */
  it("hands a 429 to the outside fetch, even with an image body", async () => {
    const { archiveResources } = await loadWithPageFetch(
      vi.fn(async () => new Response("png", { status: 429, headers: { "content-type": "image/png" } })),
    );
    const outside = vi.fn(async () => ({ resource: { contentType: "image/png", status: 200, body: "cG5n" } }));
    const archived = await archiveResources([FONT_URL], outside);
    expect(outside).toHaveBeenCalledWith(FONT_URL);
    expect(archived.resources[FONT_URL]?.status).toBe(200);
  });

  /** Catches an avatar service rate-limiting the capture's re-fetch: the image vanishes from the replay
   *  with no warning, because the error body isn't an image. */
  it("reports an error response that isn't a visual asset", async () => {
    const avatar = "https://avatar.example.com/42";
    const { archiveResources } = await loadWithPageFetch(rejecting());
    const archived = await archiveResources([avatar], async () => ({
      resource: { contentType: "application/json", status: 429, body: "e30=" },
    }));
    expect(archived.missing).toEqual([{ url: avatar, reason: "HTTP 429" }]);
  });

  it("skips a resource over the size cap and reports it", async () => {
    const { archiveResources, MAX_RESOURCE_BYTES } = await loadWithPageFetch(rejecting());
    const body = Buffer.alloc(MAX_RESOURCE_BYTES + 3).toString("base64");
    const archived = await archiveResources([FONT_URL], async () => ({
      resource: { contentType: "font/woff2", status: 200, body },
    }));
    expect(archived.resources).toEqual({});
    expect(archived.missing).toEqual([{ url: FONT_URL, reason: "larger than the 10 MB per-resource limit" }]);
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
    expect(Object.keys(archived.resources).sort()).toEqual(
      [SHEET, FONT_URL, "https://fonts.example.com/img/bg.png", PAGE_IMG].sort(),
    );
  });
});

describe("archiveReferencedResources from a cross-origin stylesheet", () => {
  const PAGE = "http://localhost:5173";
  const SHEET = "https://fonts.googleapis.com/css2?family=Geist";
  const LATIN = "https://fonts.gstatic.com/geist-latin.woff2";
  const CYRILLIC = "https://fonts.gstatic.com/geist-cyrillic.woff2";
  const css = [
    `@font-face { font-family: 'Geist'; font-weight: 400; src: url(${CYRILLIC}) format('woff2'); unicode-range: U+0400-045F; }`,
    `@font-face { font-family: 'Geist'; font-weight: 400; src: url(${LATIN}) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`,
  ].join("\n");
  /** The FontFace the browser built from the latin rule, as Chromium reports its descriptors. */
  const loadedLatin = fontFaceKeyOf({ family: "Geist", style: "normal", weight: "400", unicodeRange: "U+0-FF, U+131" });

  async function load() {
    return loadWithPageFetch(serving({ [SHEET]: ["text/css", css], [LATIN]: ["font/woff2", FONT_BYTES] }));
  }

  /** Catches Google Fonts loaded by a `<link>` without `crossorigin` archiving the sheet but not its font
   *  files: Chromium leaves what such a sheet loaded out of Resource Timing, so the replay fell back to serif. */
  it("archives the font files of the faces the page loaded, though Resource Timing lists none of them", async () => {
    const { archiveReferencedResources } = await load();
    const archived = await archiveReferencedResources([SHEET], JSON.stringify({ link: { href: SHEET } }), {
      pageOrigin: PAGE,
      loadedFontFaces: new Set([loadedLatin]),
    });
    expect(Object.keys(archived.resources).sort()).toEqual([SHEET, LATIN].sort());
    // The cyrillic subset was never loaded, so it is neither fetched nor reported.
    expect(archived.missing).toEqual([]);
  });

  /** Catches a sheet a cross-origin `<link>` imports being dropped: its request is hidden from Resource
   *  Timing too, and with it every font it names. */
  it("follows the sheet's @imports, which Resource Timing doesn't list either", async () => {
    const outer = "https://cdn.test/outer.css";
    const inner = "https://cdn.test/inner.css";
    const more = "https://cdn.test/more.css";
    const { archiveReferencedResources } = await loadWithPageFetch(
      serving({
        [outer]: ["text/css", '@import "inner.css"; @import url(more.css) layer(base);'],
        [inner]: ["text/css", css],
        [more]: ["text/css", ".x{}"],
        [LATIN]: ["font/woff2", FONT_BYTES],
      }),
    );
    const archived = await archiveReferencedResources([outer], JSON.stringify({ link: { href: outer } }), {
      pageOrigin: PAGE,
      loadedFontFaces: new Set([loadedLatin]),
    });
    expect(Object.keys(archived.resources).sort()).toEqual([outer, inner, more, LATIN].sort());
  });

  it("follows no font file from a same-origin sheet the page didn't list as loaded", async () => {
    const sheet = `${PAGE}/site.css`;
    const { archiveReferencedResources } = await loadWithPageFetch(
      serving({ [sheet]: ["text/css", css], [LATIN]: ["font/woff2", FONT_BYTES] }),
    );
    const archived = await archiveReferencedResources([sheet], JSON.stringify({ link: { href: sheet } }), {
      pageOrigin: PAGE,
      loadedFontFaces: new Set([loadedLatin]),
    });
    expect(Object.keys(archived.resources)).toEqual([sheet]);
  });
});

describe("fontFaceRules", () => {
  /** Catches a CSS rule and the FontFace built from it producing different keys, which would leave a used
   *  font unarchived. */
  it("keys a rule the way the browser reports its FontFace, and picks the first file Chromium reads", async () => {
    const { fontFaceRules, fontFaceKey } = await loadWithPageFetch(serving({}));
    const css = `@font-face {
      font-family: "Brand Sans"; font-style: italic; font-weight: 100 900;
      src: url(brand.eot?#iefix) format("embedded-opentype"), url("brand.woff2") format("woff2"), url(brand.woff);
      unicode-range: U+4??, U+0025-00FF;
    }`;
    expect(fontFaceRules(css, "https://cdn.test/css/site.css")).toEqual([
      {
        key: fontFaceKey({ family: "Brand Sans", style: "italic", weight: "100 900", unicodeRange: "U+400-4FF, U+25-FF" }),
        file: "https://cdn.test/css/brand.woff2",
      },
    ]);
  });

  it("skips a src in a format Chromium doesn't load", async () => {
    const { fontFaceRules } = await loadWithPageFetch(serving({}));
    const css = '@font-face{font-family:A;src:url(a.woff3) format("woff3"), url(a.woff2) format("woff2")}';
    expect(fontFaceRules(css, "https://cdn.test/")[0]?.file).toBe("https://cdn.test/a.woff2");
  });

  it("defaults the descriptors a rule leaves out", async () => {
    const { fontFaceRules, fontFaceKey } = await loadWithPageFetch(serving({}));
    expect(fontFaceRules("@font-face{font-family:Icons;src:url(i.ttf)}", "https://cdn.test/")).toEqual([
      {
        key: fontFaceKey({ family: "Icons", style: "normal", weight: "normal", unicodeRange: "U+0-10FFFF" }),
        file: "https://cdn.test/i.ttf",
      },
    ]);
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
    expect(Object.keys(archived.resources).sort()).toEqual([...loaded].sort());
  });
});

describe("stylesheetUrls", () => {
  const SHEET = "https://cdn.test/css/site.css";

  /** Catches the files a cross-origin sheet names in forms the url() regex missed: an escaped space or
   *  paren, and image-set candidates written as bare strings. Each one missed is a font or image that
   *  replays blank. */
  it("resolves CSS escapes and bare-string image-set candidates", async () => {
    const { stylesheetUrls } = await loadWithPageFetch(serving({}));
    const css = [
      "@font-face{src:url(Brand\\20 Regular.woff2)}",
      '@font-face{src:url("Brand\\"Bold.woff2")}',
      ".a{background:url(../img/a\\).png)}",
      '.b{background-image:image-set("../img/b.png" 1x, url(../img/b@2x.png) 2x)}',
      ".c{background-image:-webkit-image-set('../img/c.avif' type(\"image/avif\") 1x)}",
    ].join("\n");
    const urls = stylesheetUrls(css, SHEET);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.test/css/Brand%20Regular.woff2",
        "https://cdn.test/css/Brand%22Bold.woff2",
        "https://cdn.test/img/a).png",
        "https://cdn.test/img/b.png",
        "https://cdn.test/img/b@2x.png",
        "https://cdn.test/img/c.avif",
      ]),
    );
  });
});

describe("referencedUrls token prefilter", () => {
  /** Catches the file-name prefilter rejecting a URL the full scan would have matched: the spellings a
   *  srcset candidate, a query string, a protocol-relative url() and a space in the file name produce. */
  it("still finds URLs in srcset, with a query, protocol-relative, and with a space or paren in the file name", async () => {
    const { referencedUrls } = await loadWithPageFetch(serving({}));
    const dom = JSON.stringify({
      img: { srcset: "http://app.test/a.png 1x, http://app.test/a@2x.png 2x" },
      link: { href: "http://app.test/font.css?v=3" },
      logo: { src: "http://app.test/logo(1).png" },
      style: '.x{background:url(//cdn.test/b.png)} .y{background:url("http://app.test/hero image.png")}',
    });
    const loaded = [
      "http://app.test/a.png",
      "http://app.test/a@2x.png",
      "http://app.test/font.css?v=3",
      "http://cdn.test/b.png",
      "http://app.test/hero%20image.png",
      "http://app.test/logo(1).png",
      "http://app.test/unused.png",
    ];
    expect([...referencedUrls(loaded, dom)].sort()).toEqual(loaded.slice(0, 6).sort());
  });
});
