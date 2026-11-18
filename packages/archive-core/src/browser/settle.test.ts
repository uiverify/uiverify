import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundImageUrls, settle } from "./settle";

describe("backgroundImageUrls", () => {
  it("reads every url() in a computed background-image, quoted or not", () => {
    expect(
      backgroundImageUrls('url("https://i.ytimg.com/vi/x/maxresdefault.jpg"), linear-gradient(red, blue), url(/a.png)'),
    ).toEqual(["https://i.ytimg.com/vi/x/maxresdefault.jpg", "/a.png"]);
  });

  it("returns nothing for none or a gradient-only value", () => {
    expect(backgroundImageUrls("none")).toEqual([]);
    expect(backgroundImageUrls("linear-gradient(red, blue)")).toEqual([]);
  });
});

/** A stand-in for an `<img>` / `new Image()`: records its settings and completes a tick after `src` is set,
 *  or when `load()` is called for an element already in the page. */
class FakeImage {
  static created: FakeImage[] = [];
  loading = "auto";
  complete = false;
  private listeners: (() => void)[] = [];
  private _src = "";
  constructor() {
    FakeImage.created.push(this);
  }
  get src() {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
    setTimeout(() => this.load(), 5);
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  load() {
    this.complete = true;
    for (const fn of this.listeners) fn();
  }
}

/** A stylesheet's `load` / `error` listeners, as an element in the page keeps them. */
class FakeOwner {
  readonly href: string | null = null;
  shadowRoot?: FakeRoot;
  sheet: FakeSheet | null = null;
  attached = 0;
  private listeners: (() => void)[] = [];
  addEventListener(_type: string, fn: () => void) {
    this.attached++;
    this.listeners.push(fn);
  }
  /** The stylesheet arrived (or failed): it gets its sheet and its `load` / `error` fires. */
  finish(sheet: FakeSheet = new FakeSheet(this.href, [])) {
    this.sheet = sheet;
    for (const fn of this.listeners.splice(0)) fn();
  }
}

class FakeSheet {
  constructor(
    readonly href: string | null,
    readonly cssRules: unknown[],
  ) {}
}

class FakeLink extends FakeOwner {
  rel = "stylesheet";
  type = "";
  disabled = false;
  constructor(readonly href: string) {
    super();
  }
  get relList() {
    return { contains: (token: string) => this.rel.split(" ").includes(token) };
  }
  getAttribute(name: string) {
    return name === "href" ? this.href : null;
  }
}

class FakeStyle extends FakeOwner {}

class FakeImportRule {
  constructor(
    readonly href: string,
    public styleSheet: FakeSheet | null,
  ) {}
}

class FakeLayerStatementRule {}

type PageNode = FakeElement | FakeImage | FakeLink | FakeStyle;

interface FakeElement {
  background: Record<string, string>;
  shadowRoot?: FakeRoot;
}
interface FakeRoot {
  querySelectorAll: () => PageNode[];
}

function root(children: PageNode[]): FakeRoot {
  return { querySelectorAll: () => children };
}

/** Install a minimal page from its elements: `<img>`s, stylesheet links, and elements with
 *  per-pseudo-element computed `background-image`s (`self` for the element itself), optionally hosting a
 *  shadow root. `layout` is what forcing a layout calls; `fonts` is the page's `document.fonts`. */
function stubPage(children: PageNode[], { layout = vi.fn(), fonts }: { layout?: () => void; fonts?: object } = {}) {
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("HTMLImageElement", FakeImage);
  vi.stubGlobal("HTMLLinkElement", FakeLink);
  vi.stubGlobal("HTMLStyleElement", FakeStyle);
  vi.stubGlobal("CSSImportRule", FakeImportRule);
  vi.stubGlobal("CSSLayerStatementRule", FakeLayerStatementRule);
  vi.stubGlobal("document", { ...root(children), fonts, documentElement: { getBoundingClientRect: layout } });
  vi.stubGlobal("getComputedStyle", (el: FakeElement | FakeImage, pseudo: string | null) => ({
    backgroundImage: ("background" in el ? el.background[pseudo ?? "self"] : undefined) ?? "none",
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeImage.created = [];
});

describe("settle", () => {
  /** Catches settle not forcing lazy images: a lazy image below the test viewport never starts loading on
   *  its own, so it would be missing from the archive (and settle would sit out its whole time box). */
  it("switches a pending lazy image to eager and waits for it", async () => {
    const lazy = new FakeImage();
    lazy.loading = "lazy";
    stubPage([lazy]);
    setTimeout(() => lazy.load(), 5);
    await settle();
    expect(lazy.loading).toBe("eager");
    expect(lazy.complete).toBe(true);
  });

  /** Catches the rewrite depending on load timing: a lazy image that happened to load before the capture
   *  would keep `loading="lazy"` in the archived DOM while a slower run archives `eager`, so the same page
   *  archives differently run to run. */
  it("switches a lazy image that has already loaded to eager too", async () => {
    const loaded = new FakeImage();
    loaded.loading = "lazy";
    loaded.complete = true;
    stubPage([loaded]);
    await settle();
    expect(loaded.loading).toBe("eager");
  });

  /** Catches settle ignoring CSS backgrounds (incl. ::before/::after): a background still loading at
   *  capture has no resource-timing entry yet, so it would be left out of the archive. */
  it("loads every element and pseudo-element background image before returning", async () => {
    stubPage([
      { background: { self: 'url("/poster.jpg")' } },
      { background: { "::before": "url(/icon.svg)", "::after": "none" } },
    ]);
    FakeImage.created = [];
    await settle();
    const loaded = FakeImage.created.map((img) => ({ src: img.src, complete: img.complete }));
    expect(loaded).toEqual([
      { src: "/poster.jpg", complete: true },
      { src: "/icon.svg", complete: true },
    ]);
  });

  /** Catches settle stopping at shadow boundaries: `querySelectorAll` and `document.images` never enter a
   *  shadow root, so a web component's lazy image or background would be captured before it loaded. */
  it("waits for images and backgrounds inside open shadow roots", async () => {
    const lazy = new FakeImage();
    lazy.loading = "lazy";
    stubPage([{ background: {}, shadowRoot: root([lazy, { background: { self: "url(/inner.png)" } }]) }]);
    FakeImage.created = [];
    setTimeout(() => lazy.load(), 5);
    await settle();
    expect(lazy.loading).toBe("eager");
    expect(lazy.complete).toBe(true);
    expect(FakeImage.created.map((img) => img.src)).toEqual(["/inner.png"]);
  });

  /** Catches `lazyToEager: false` still rewriting `loading`: where the browser already loads lazy images up
   *  front, the rewrite only makes the serialized DOM differ between runs. */
  it("leaves a lazy image's loading attribute alone with lazyToEager off, and still waits for it", async () => {
    const lazy = new FakeImage();
    lazy.loading = "lazy";
    stubPage([lazy]);
    setTimeout(() => lazy.load(), 5);
    await settle({ lazyToEager: false });
    expect(lazy.loading).toBe("lazy");
    expect(lazy.complete).toBe(true);
  });
});

/** A `FontFace` stand-in: `load()` is what preloading calls, `loaded` what waiting for a used face awaits. */
function fakeFace(status: "unloaded" | "loading" | "loaded") {
  const face = {
    status,
    load: vi.fn(async () => undefined),
    loaded: new Promise<void>((resolve) => setTimeout(() => ((face.status = "loaded"), resolve()), 5)),
  };
  return face;
}

describe("settle fonts", () => {
  function stubFonts(faces: ReturnType<typeof fakeFace>[]) {
    stubPage([], { fonts: Object.assign(faces, { ready: Promise.resolve() }) });
  }

  /** Catches `fonts: "used"` loading every declared face: on a real page that requests subsets the page
   *  never draws, which a recorded-font route can't answer. */
  it("loads no unused face with fonts: \"used\", and waits out one still loading", async () => {
    const unused = fakeFace("unloaded");
    const loading = fakeFace("loading");
    stubFonts([unused, loading]);
    await settle({ fonts: "used" });
    expect(unused.load).not.toHaveBeenCalled();
    expect(loading.status).toBe("loaded");
  });

  /** Catches the default changing for Vitest: an isolated component needs every face loaded before capture. */
  it("loads every declared face by default", async () => {
    const unused = fakeFace("unloaded");
    stubFonts([unused]);
    await settle();
    expect(unused.load).toHaveBeenCalled();
  });
});

/** The page's `document.fonts` with one face that only starts loading once a layout has used it, as a face
 *  declared by a stylesheet that just applied does. */
function lateFace() {
  const face = { status: "unloaded", load: vi.fn(async () => undefined), loaded: Promise.resolve() };
  const request = () => {
    face.status = "loading";
    face.loaded = new Promise<void>((resolve) =>
      setTimeout(() => {
        face.status = "loaded";
        resolve();
      }, 5),
    );
  };
  return { face, request, fonts: Object.assign([face], { ready: Promise.resolve() }) };
}

/** Run `settle` with `fonts: "used"` and say whether it was still waiting at `ms`: a wait on a stylesheet
 *  that never arrives is cut by the time box, far past it. */
async function waitsPast(ms: number, run: Promise<void>): Promise<boolean> {
  const sentinel = Symbol();
  const first = await Promise.race([run, new Promise<symbol>((resolve) => setTimeout(() => resolve(sentinel), ms))]);
  return first === sentinel;
}

describe("settle stylesheets (fonts: \"used\")", () => {
  /** Catches settle running the used-font wait before a late stylesheet arrives: its `@font-face` isn't
   *  registered yet and nothing has requested the face, so the font never reaches the archive. Also pins
   *  the order the fix depends on: the layout that requests the face runs after the sheet applied. */
  it("waits for a stylesheet still loading, then forces a layout, then waits for the face it requests", async () => {
    const link = new FakeLink("https://fonts.test/late.css");
    const { face, request, fonts } = lateFace();
    const events: string[] = [];
    stubPage([link], {
      fonts,
      layout: () => {
        events.push(link.sheet ? "layout after sheet" : "layout before sheet");
        request();
      },
    });
    setTimeout(() => link.finish(), 20);
    await settle({ fonts: "used" });
    expect(events).toEqual(["layout after sheet"]);
    expect(face.status).toBe("loaded");
  });

  /** Catches a failed stylesheet being waited on: it has a (empty) sheet and has already fired, so the wait
   *  must not cost the time box. */
  it("doesn't wait for a stylesheet that has finished or failed", async () => {
    const link = new FakeLink("/done.css");
    link.finish();
    stubPage([link], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    expect(await waitsPast(500, settle({ fonts: "used" }))).toBe(false);
  });

  /** Catches waiting on links Chrome never fetches: a disabled one or a non-CSS `type` has no sheet and
   *  never fires, so settle would sit out the whole time box on every page that has one. */
  it("ignores a disabled link, a non-CSS type, a non-stylesheet rel and an empty href", async () => {
    const disabled = new FakeLink("/a.css");
    disabled.disabled = true;
    const plain = new FakeLink("/b.css");
    plain.type = "text/plain";
    const less = new FakeLink("/c.less");
    less.rel = "stylesheet/less";
    const preload = new FakeLink("/d.css");
    preload.rel = "preload";
    const empty = new FakeLink("");
    stubPage([disabled, plain, less, preload, empty], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    expect(await waitsPast(500, settle({ fonts: "used" }))).toBe(false);
  });

  /** Catches a theme switch that rewrites an existing link's href: the link keeps its old, loaded sheet
   *  until the new one arrives, so `sheet === null` alone would call it done. */
  it("waits for a link whose href was changed until the new sheet arrives", async () => {
    const link = new FakeLink("https://fonts.test/dark.css");
    link.sheet = new FakeSheet("https://fonts.test/light.css", []);
    const { face, request, fonts } = lateFace();
    stubPage([link], { fonts, layout: request });
    setTimeout(() => link.finish(new FakeSheet("https://fonts.test/dark.css", [])), 20);
    await settle({ fonts: "used" });
    expect(link.attached).toBeGreaterThan(0);
    expect(face.status).toBe("loaded");
  });

  /** Catches a sheet that has applied but whose `@import` is still arriving: its owner already has a sheet,
   *  so only the import's own `styleSheet === null` says the fonts it declares are still to come. The layout
   *  that requests the face must run after the import, so a settle that ignores it (or stops at the leading
   *  `@layer` statement before reaching it) reads "layout before import". */
  it("waits for a sheet whose @import is still loading, then forces a layout", async () => {
    const link = new FakeLink("/app.css");
    const imported = new FakeImportRule("https://fonts.test/inter.css", null);
    link.sheet = new FakeSheet("/app.css", [new FakeLayerStatementRule(), imported]);
    const { face, request, fonts } = lateFace();
    const events: string[] = [];
    stubPage([link], {
      fonts,
      layout: () => {
        events.push(imported.styleSheet ? "layout after import" : "layout before import");
        request();
      },
    });
    setTimeout(() => {
      imported.styleSheet = new FakeSheet(imported.href, []);
      link.finish(link.sheet ?? undefined);
    }, 20);
    await settle({ fonts: "used" });
    expect(events).toEqual(["layout after import"]);
    expect(face.status).toBe("loaded");
  });

  /** Catches the walk stopping at the first level: an import two levels down is still arriving while its
   *  parents have both loaded, and a style owner (no `href`) is walked the same way. */
  it("waits for an import nested a level down, and not for one that has loaded", async () => {
    const inner = new FakeImportRule("/inner.css", null);
    const style = new FakeStyle();
    style.sheet = new FakeSheet(null, [new FakeImportRule("/mid.css", new FakeSheet("/mid.css", [inner]))]);
    const events: string[] = [];
    stubPage([style], {
      fonts: Object.assign([], { ready: Promise.resolve() }),
      layout: () => events.push(inner.styleSheet ? "layout after inner" : "layout before inner"),
    });
    setTimeout(() => {
      inner.styleSheet = new FakeSheet(inner.href, []);
      style.finish(style.sheet ?? undefined);
    }, 20);
    await settle({ fonts: "used" });
    expect(events).toEqual(["layout after inner"]);

    const settled = new FakeStyle();
    settled.sheet = new FakeSheet(null, [new FakeImportRule("/mid.css", new FakeSheet("/mid.css", [new FakeImportRule("/inner.css", new FakeSheet("/inner.css", []))]))]);
    stubPage([settled], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    expect(await waitsPast(500, settle({ fonts: "used" }))).toBe(false);
  });

  /** Catches the walk stopping at the first import: a sheet whose first `@import` has loaded and whose second
   *  is still arriving must be waited on, and so must one that two parents share, which is only done once
   *  both have their sheet. */
  it("waits for a pending import after a loaded sibling, and for one two sheets share", async () => {
    const shared = new FakeImportRule("/shared.css", null);
    const other = new FakeImportRule("/shared.css", null);
    const link = new FakeLink("https://fonts.test/app.css");
    link.sheet = new FakeSheet("https://fonts.test/app.css", [
      new FakeImportRule("/loaded.css", new FakeSheet("https://fonts.test/loaded.css", [])),
      new FakeImportRule("/left.css", new FakeSheet("https://fonts.test/left.css", [shared])),
      new FakeImportRule("/right.css", new FakeSheet("https://fonts.test/right.css", [other])),
    ]);
    const events: string[] = [];
    stubPage([link], {
      fonts: Object.assign([], { ready: Promise.resolve() }),
      layout: () => events.push(shared.styleSheet && other.styleSheet ? "layout after both" : "layout early"),
    });
    setTimeout(() => {
      shared.styleSheet = new FakeSheet(shared.href, []);
      setTimeout(() => {
        other.styleSheet = new FakeSheet(other.href, []);
        link.finish(link.sheet ?? undefined);
      }, 20);
    }, 20);
    await settle({ fonts: "used" });
    expect(events).toEqual(["layout after both"]);
  });

  /** Catches a link that was removed and added again (a route's CSS remounting) being read as finished
   *  because an earlier request for the same URL exists in the page's Resource Timing: the new element has
   *  no sheet yet, so it is still loading however many entries the page holds for that URL. */
  it("waits for a remounted link even when the page already holds a timing entry for its URL", async () => {
    const link = new FakeLink("https://fonts.test/theme.css");
    const { face, request, fonts } = lateFace();
    stubPage([link], { fonts, layout: request });
    vi.stubGlobal("performance", { getEntriesByName: () => [{ name: link.href }] });
    setTimeout(() => link.finish(), 20);
    await settle({ fonts: "used" });
    expect(link.attached).toBeGreaterThan(0);
    expect(link.sheet).not.toBeNull();
    expect(face.status).toBe("loaded");
  });

  /** Catches waiting on an import Chrome leaves `null` for good: an empty, self or cyclic `@import` never
   *  gets a sheet after its owner has fired, so each would cost the time box on every page with one. Chrome's
   *  `CSSImportRule.href` is the text as written (relative), while a sheet's `href` is absolute: the rules
   *  here are written the way Chrome reports them, so a guard comparing the two raw strings fails. */
  it("doesn't wait for an empty, self or cyclic @import, written relative as in a real page", async () => {
    const self = new FakeLink("https://fonts.test/self.css");
    self.sheet = new FakeSheet("https://fonts.test/self.css", [new FakeImportRule("self.css", null)]);
    const empty = new FakeStyle();
    empty.sheet = new FakeSheet(null, [new FakeImportRule("", null)]);
    const cycleB: FakeSheet = new FakeSheet("https://fonts.test/b.css", [new FakeImportRule("a.css", null)]);
    const cycleA = new FakeLink("https://fonts.test/a.css");
    cycleA.sheet = new FakeSheet("https://fonts.test/a.css", [new FakeImportRule("b.css", cycleB)]);
    stubPage([self, empty, cycleA], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    expect(await waitsPast(500, settle({ fonts: "used" }))).toBe(false);
  });

  it("doesn't wait on an owner whose rules it can't read", async () => {
    const style = new FakeStyle();
    style.sheet = {
      href: null,
      get cssRules(): unknown[] {
        throw new Error("SecurityError");
      },
    };
    stubPage([style], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    expect(await waitsPast(500, settle({ fonts: "used" }))).toBe(false);
  });

  /** Catches settle stopping at shadow boundaries for stylesheets, as it once did for images. */
  it("waits for a stylesheet inside an open shadow root", async () => {
    const link = new FakeLink("/shadow.css");
    stubPage([{ background: {}, shadowRoot: root([link]) }], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    setTimeout(() => link.finish(), 20);
    await settle({ fonts: "used" });
    expect(link.attached).toBeGreaterThan(0);
    expect(link.sheet).not.toBeNull();
  });

  /** Catches a sheet that starts another: an app appending a sheet from a load handler is invisible to a
   *  single look at the page. */
  it("waits for a stylesheet a finished one inserts", async () => {
    const first = new FakeLink("/first.css");
    const second = new FakeLink("/second.css");
    const children: PageNode[] = [first];
    stubPage(children, { fonts: Object.assign([], { ready: Promise.resolve() }) });
    setTimeout(() => {
      children.push(second);
      first.finish();
      setTimeout(() => second.finish(), 20);
    }, 20);
    await settle({ fonts: "used" });
    expect(second.sheet).not.toBeNull();
  });

  /** Catches the default (Vitest) path touching stylesheets: it preloads every face and must not wait on
   *  or look at a sheet. */
  it("doesn't look at stylesheets with fonts: \"all\"", async () => {
    const link = new FakeLink("/never.css");
    stubPage([link], { fonts: Object.assign([], { ready: Promise.resolve() }) });
    await settle();
    expect(link.attached).toBe(0);
  });
});
