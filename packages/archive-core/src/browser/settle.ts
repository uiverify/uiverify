import { sleep } from "./real-timers";

/**
 * Record-time settling: wait for fonts and images (CSS background images included) to finish loading
 * before we serialize, so every visible resource is actually in the archive. The archive is a static snapshot, so a font still loading at
 * capture is absent (it shows as a fallback glyph) and an image still loading is absent (it shows broken) -
 * both are pure run-to-run flakes an author would otherwise chase with a manual settle helper.
 *
 * Time-boxed with the real `setTimeout` ({@link sleep}), so a hung resource can never stall a capture.
 */
const SETTLE_TIMEOUT_MS = 3000;

function cap(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work, sleep(SETTLE_TIMEOUT_MS)]);
}

/** Load every registered `@font-face` and wait for the font set to be ready. Exported so a test can call
 *  it BEFORE `render()` for a component that measures text width on mount - a mid-load font bakes a wrong
 *  metric (a 1px-shifted layout) that settling AFTER render can no longer undo. */
export async function preloadFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loadAll = Promise.all(Array.from(document.fonts, (f) => f.load().catch(() => undefined)));
  await cap(loadAll.then(() => document.fonts.ready));
}

/** The URLs in a computed `background-image` value (`url("…")`, possibly several, possibly in a gradient
 *  list). */
export function backgroundImageUrls(value: string): string[] {
  return Array.from(value.matchAll(/url\((["']?)(.*?)\1\)/g), (m) => m[2] ?? "").filter(Boolean);
}

/** Resolve once `img` has loaded or failed. */
function loaded(img: HTMLImageElement): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise<void>((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

/** Every element in `root`, descending into open shadow roots, which `querySelectorAll` and
 *  `document.images` never enter. */
export function allElements(root: ParentNode): Element[] {
  const out: Element[] = [];
  for (const el of root.querySelectorAll("*")) {
    out.push(el);
    if (el.shadowRoot) out.push(...allElements(el.shadowRoot));
  }
  return out;
}

/** How {@link settle} treats web fonts and lazy images. The defaults suit an isolated component; a real page
 *  that has already mounted and measured wants `fonts: "used"`. */
export interface SettleOptions {
  /** `"all"` (the default) loads every registered `@font-face` first, as {@link preloadFonts} does. `"used"`
   *  only waits for the faces the page already requested: loading every declared face would request subsets a
   *  real page never draws. */
  fonts?: "all" | "used";
  /** Switch `loading="lazy"` images to eager (the default), so one below the viewport loads and is archived.
   *  Off when the browser already loads lazy images up front, where the rewrite would gain nothing. */
  lazyToEager?: boolean;
  /** Collects the images switched to eager, for a caller that puts their attribute back after the capture. */
  switched?: HTMLImageElement[];
}

async function waitForUsedFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const used = document.fonts.ready.then(() =>
    Promise.all(
      Array.from(document.fonts)
        .filter((face) => face.status === "loading")
        .map((face) => face.loaded.catch(() => undefined)),
    ),
  );
  await cap(used);
}

/** Wait for fonts, every `<img>`, and every CSS background image (`::before`/`::after` included) to finish
 *  loading, then return, inside open shadow roots too. Called right before the DOM is serialized. The archive
 *  is replayed as a full page, so an image anywhere on it counts: `loading="lazy"` ones below the test
 *  viewport would never start loading on their own, so they're switched to eager first unless
 *  `lazyToEager` is off. A background image is only archived once the browser has fetched it, so each is
 *  loaded through an `Image` (a cache hit when it already is). */
export async function settle({ fonts = "all", lazyToEager = true, switched }: SettleOptions = {}): Promise<void> {
  if (typeof document === "undefined") return;
  await (fonts === "used" ? waitForUsedFonts() : preloadFonts());
  const elements = allElements(document);
  const images = elements.filter((el): el is HTMLImageElement => el instanceof HTMLImageElement);
  // Every lazy image, loaded or not, so the archived attribute doesn't depend on which had loaded in time.
  if (lazyToEager) {
    for (const img of images) {
      if (img.loading !== "lazy") continue;
      img.loading = "eager";
      switched?.push(img);
    }
  }
  const backgrounds = new Set<string>();
  for (const el of elements) {
    for (const pseudo of [null, "::before", "::after"]) {
      for (const url of backgroundImageUrls(getComputedStyle(el, pseudo).backgroundImage)) backgrounds.add(url);
    }
  }
  const pending = [
    ...images.filter((img) => !img.complete).map(loaded),
    ...Array.from(backgrounds, (url) => {
      const img = new Image();
      img.src = url;
      return loaded(img);
    }),
  ];
  if (!pending.length) return;
  await cap(Promise.all(pending));
}
