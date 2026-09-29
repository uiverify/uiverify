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

interface FakeElement {
  background: Record<string, string>;
  shadowRoot?: FakeRoot;
}
interface FakeRoot {
  querySelectorAll: () => (FakeElement | FakeImage)[];
}

function root(children: (FakeElement | FakeImage)[]): FakeRoot {
  return { querySelectorAll: () => children };
}

/** Install a minimal page from its elements: `<img>`s, and elements with per-pseudo-element computed
 *  `background-image`s (`self` for the element itself), optionally hosting a shadow root. */
function stubPage(children: (FakeElement | FakeImage)[]) {
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("HTMLImageElement", FakeImage);
  vi.stubGlobal("document", root(children));
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
});
