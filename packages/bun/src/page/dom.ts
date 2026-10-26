/** The DOM side of locators. A query marks each element it finds with a `data-vt-ref` and returns the
 *  marks, so the next step (or an action) can find the same element again; marks are removed before a
 *  capture serializes the DOM. */

import { allElements } from "@uiverify/archive-core/browser";

export const REF_ATTRIBUTE = "data-vt-ref";
/** Every mark's value starts with it, so a mark never takes the value an app's own `data-vt-ref` has. */
const REF_PREFIX = "uiverify-";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Playwright's text match: a substring, case-insensitive and whitespace-normalized, unless exact. */
function textMatches(actual: string, expected: string, exact: boolean): boolean {
  const content = normalize(actual);
  return exact ? content === normalize(expected) : content.toLowerCase().includes(normalize(expected).toLowerCase());
}

let nextRef = 0;

const bodyElements = () => (document.body ? allElements(document.body) : []);

/** The document and every open shadow root in it: the accessibility tree finds elements inside those too. */
function* allRoots(root: Document | ShadowRoot = document): Generator<Document | ShadowRoot> {
  yield root;
  for (const el of root.querySelectorAll("*")) if (el.shadowRoot) yield* allRoots(el.shadowRoot);
}

/** Each mark this document gave, and the element it gave it to. A copy the app makes of a marked element
 *  carries the same value but isn't that element; an app's own `data-vt-ref` isn't in here. */
const owners = new Map<string, Element>();

export function byRef(ref: string): Element | null {
  const owner = owners.get(ref);
  if (owner) return owner.isConnected ? owner : null;
  const selector = `[${REF_ATTRIBUTE}="${ref}"]`;
  const inDocument = document.querySelector(selector);
  if (inDocument) return inDocument;
  for (const root of allRoots()) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

export function mark(el: Element): string {
  const current = el.getAttribute(REF_ATTRIBUTE);
  // An app's own value and this element's own mark are kept; a copy of another element's mark gets its own.
  if (current && (!current.startsWith(REF_PREFIX) || owners.get(current) === el)) return current;
  const ref = `${REF_PREFIX}${++nextRef}`;
  el.setAttribute(REF_ATTRIBUTE, ref);
  owners.set(ref, el);
  return ref;
}

/** Takes `ref`'s mark off the copies the app made of its element: they would take a click aimed at it by selector. */
function stripCopies(ref: string, el: Element): void {
  if (!owners.has(ref)) return;
  for (const root of allRoots()) {
    for (const other of root.querySelectorAll(`[${REF_ATTRIBUTE}="${ref}"]`)) if (other !== el) other.removeAttribute(REF_ATTRIBUTE);
  }
}

function scopes(refs: string[] | null): ParentNode[] {
  return refs === null ? [document] : refs.map(byRef).filter((el): el is Element => el !== null);
}

const unique = (els: Element[]) => [...new Set(els)].map(mark);

function isFormControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

export const dom = {
  mark,

  css: (refs: string[] | null, selector: string, textIs?: string) =>
    unique(
      scopes(refs).flatMap((scope) =>
        [...scope.querySelectorAll(selector)].filter(
          (el) => textIs === undefined || normalize(el.textContent ?? "") === textIs,
        ),
      ),
    ),

  /** An element whose text holds the string and none of whose children does: Playwright's `getByText`. */
  text: (refs: string[] | null, text: string, exact: boolean) => {
    const matches = (el: Element) => textMatches(el.textContent ?? "", text, exact);
    return unique(
      scopes(refs).flatMap((scope) =>
        [...(scope === document ? document.body : scope).querySelectorAll("*")].filter(
          (el) =>
            !["SCRIPT", "STYLE", "HEAD", "TEMPLATE"].includes(el.tagName) &&
            matches(el) &&
            ![...el.children].some(matches),
        ),
      ),
    );
  },

  placeholder: (refs: string[] | null, text: string, exact: boolean) =>
    unique(
      scopes(refs).flatMap((scope) =>
        [...scope.querySelectorAll("[placeholder]")].filter((el) =>
          textMatches(el.getAttribute("placeholder") ?? "", text, exact),
        ),
      ),
    ),

  parent: (refs: string[]) =>
    unique(
      refs.flatMap((ref) => {
        const parent = byRef(ref)?.parentElement;
        return parent ? [parent] : [];
      }),
    ),

  visible: (ref: string) => {
    const el = byRef(ref);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
  },

  state: (ref: string) => {
    const el = byRef(ref);
    if (!el) return null;
    return {
      disabled: ("disabled" in el && el.disabled === true) || el.getAttribute("aria-disabled") === "true",
      value: isFormControl(el) ? el.value : null,
      attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    };
  },

  /** The element's centre, after scrolling it into view only if it isn't the topmost element there, and then
   *  as little as possible: a page scrolled by even a few pixels places every overlay differently. */
  center: (ref: string) => {
    const el = byRef(ref);
    if (!el) return null;
    stripCopies(ref, el);
    const middle = () => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    // Asked of the element's own root: from the document, an element in a shadow root reports its host.
    const root = el.getRootNode();
    const scope = root instanceof ShadowRoot ? root : document;
    const shown = ({ x, y }: { x: number; y: number }) => {
      const top = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && scope.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top));
    };
    if (!shown(middle())) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    return { ...middle(), inShadow: root instanceof ShadowRoot };
  },

  /** Focus the field and select its content, so typing replaces it. */
  select: (ref: string) => {
    const el = byRef(ref);
    if (el instanceof HTMLElement) el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    else if (el instanceof HTMLElement && el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  },

  remove: (ref: string) => byRef(ref)?.remove(),

  addStyle: (css: string) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  },

  /** Changes whenever anything in the body, or in a shadow root within it, is still moving or loading:
   *  element boxes, image completeness (including images a late query adds), SVG `opacity` attributes, and
   *  the opacity/filter/transform JS animations change. `null` while an image is still loading. */
  signature: () => {
    const elements = bodyElements();
    if (!elements.every((el) => !(el instanceof HTMLImageElement) || el.complete)) return null;
    return elements.map((el) => {
      const r = el.getBoundingClientRect();
      const { opacity, filter, transform } = getComputedStyle(el);
      return `${r.x},${r.y},${r.width},${r.height},${el.getAttribute("opacity") ?? ""},${opacity}${filter}${transform}`;
    });
  },

  /** A short description of the `index`th element `signature` read, for naming what never stops moving. */
  describe: (index: number) => {
    const el = bodyElements()[index];
    if (!el) return "an element that was removed";
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
    return `<${el.tagName.toLowerCase()}${id}${classes}>`;
  },

  byRef,

  clearRefs: () => {
    for (const root of allRoots()) {
      for (const el of root.querySelectorAll(`[${REF_ATTRIBUTE}]`)) {
        if (el.getAttribute(REF_ATTRIBUTE)?.startsWith(REF_PREFIX)) el.removeAttribute(REF_ATTRIBUTE);
      }
    }
    owners.clear();
  },
};
