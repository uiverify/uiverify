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
   *  waits for the stylesheets still arriving, then for the faces the page requests: loading every declared
   *  face would request subsets a real page never draws. */
  fonts?: "all" | "used";
  /** Switch `loading="lazy"` images to eager (the default), so one below the viewport loads and is archived.
   *  Off when the browser already loads lazy images up front, where the rewrite would gain nothing. */
  lazyToEager?: boolean;
  /** Collects the images switched to eager, for a caller that puts their attribute back after the capture. */
  switched?: HTMLImageElement[];
}

/** Stylesheets given up on after the time box, with the `href` they had then, so one that never answers
 *  costs a single time box per document, not one per snapshot, while a link whose `href` is rewritten later
 *  is waited on again. */
const givenUp = new WeakMap<Element, string>();

type StylesheetOwner = HTMLLinkElement | HTMLStyleElement;

/** A link Chrome actually fetches: a disabled one, or one with a non-CSS `type`, never loads. */
function fetchesStylesheet(link: HTMLLinkElement): boolean {
  const type = link.type.toLowerCase();
  const cssType = type === "" || type === "text/css";
  return link.relList.contains("stylesheet") && !!link.getAttribute("href") && !link.disabled && cssType;
}

/** `CSSImportRule.href` is the text as written (`"self.css"`), while a sheet's own `href` is absolute. */
function resolved(href: string, parent: CSSStyleSheet): string {
  try {
    return new URL(href, parent.href ?? document.baseURI).href;
  } catch {
    return href;
  }
}

/** Whether a leading `@import` of `sheet`, at any depth, is still loading. `styleSheet` is `null` only while
 *  one is, except for an empty, self or cyclic import, which stays `null` for good (`path` holds the sheets
 *  being walked), and a cross-origin sheet's rules can't be read. */
function importPending(sheet: CSSStyleSheet, path: ReadonlySet<string>): boolean {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return false;
  }
  const here = sheet.href ? new Set([...path, sheet.href]) : path;
  for (const rule of rules) {
    if (typeof CSSLayerStatementRule !== "undefined" && rule instanceof CSSLayerStatementRule) continue;
    if (!(rule instanceof CSSImportRule)) break;
    if (rule.styleSheet) {
      if (importPending(rule.styleSheet, here)) return true;
    } else if (rule.href !== "" && !here.has(resolved(rule.href, sheet))) {
      return true;
    }
  }
  return false;
}

function ownerHref(owner: StylesheetOwner): string {
  return owner instanceof HTMLLinkElement ? owner.href : "";
}

function isPending(owner: StylesheetOwner): boolean {
  if (givenUp.get(owner) === ownerHref(owner)) return false;
  const sheet = owner.sheet;
  if (owner instanceof HTMLLinkElement) {
    // Chrome gives a finished link, a failed one included, a sheet. A browser that leaves a failed one
    // `null` costs one time box per document: no signal tells a finished link from one still loading.
    if (sheet === null) return true;
    // A link whose href was changed keeps its old sheet until the new one arrives.
    if (sheet.href !== owner.href) return true;
  }
  return sheet !== null && importPending(sheet, new Set());
}

function stylesheetOwners(): StylesheetOwner[] {
  return allElements(document).filter(
    (el): el is StylesheetOwner =>
      (el instanceof HTMLLinkElement && fetchesStylesheet(el)) || el instanceof HTMLStyleElement,
  );
}

function whenLoaded(owner: StylesheetOwner): Promise<void> {
  return new Promise<void>((resolve) => {
    owner.addEventListener("load", () => resolve(), { once: true });
    owner.addEventListener("error", () => resolve(), { once: true });
  });
}

/** Wait until no stylesheet is still arriving. A finished sheet can start another (one inserted from a load
 *  handler), so it looks again until a pass finds nothing. */
async function waitForStylesheets(): Promise<void> {
  const pendingOwners = () => stylesheetOwners().filter(isPending);
  const settled = (async () => {
    for (let pending = pendingOwners(); pending.length; pending = pendingOwners()) {
      await Promise.all(pending.map(whenLoaded));
    }
  })();
  await cap(settled);
  for (const owner of stylesheetOwners()) if (isPending(owner)) givenUp.set(owner, ownerHref(owner));
}

async function waitForUsedFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await waitForStylesheets();
  // A face is only requested once layout uses it, and the stylesheet that declares it may just have applied.
  document.documentElement.getBoundingClientRect();
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
