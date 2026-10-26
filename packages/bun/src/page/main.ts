/**
 * The page script: runs in every document of the tab before the app's own scripts (CDP
 * `Page.addScriptToEvaluateOnNewDocument`), built as one browser IIFE. It pins what a capture must not vary
 * on and gives the Bun side the DOM helpers and the capture it calls through `evaluate`.
 *
 * The shared modules imported below evaluate before this module's body, so `settle()` and the archiver
 * keep the real `setTimeout`, taken before the fake clock replaces it.
 */
import {
  collectResources,
  type FetchedResource,
  inlineBlobs,
  installSeededRandom,
  raiseResourceTimingBuffer,
  serializeDocument,
  settle,
} from "@uiverify/archive-core/browser";
import { installClock } from "./clock";
import { dom } from "./dom";
import { OUTSIDE_PAGE_BINDING, PAGE_CONFIG_GLOBAL, PAGE_HELPERS_GLOBAL } from "./protocol";

/** How long a capture's own work may run: under the Bun side's 15 s evaluate timeout, with room to return. */
const CAPTURE_BUDGET_MS = 13_000;

// Transitions and keyframes finish instantly, so a capture never lands mid-animation (`animation: none`
// would leave fade-ins at opacity 0), and the caret never blinks into a capture.
const FINISH_ANIMATIONS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}`;

function configuredNow(): number {
  const config: unknown = Reflect.get(globalThis, PAGE_CONFIG_GLOBAL);
  const now = typeof config === "object" && config !== null ? Reflect.get(config, "now") : undefined;
  return typeof now === "number" ? now : Date.now();
}

Reflect.set(globalThis, "__UI_VERIFY__", true);
raiseResourceTimingBuffer();
installSeededRandom();
const clock = installClock(configuredNow());

// Dialogs would block the page (and every call to it) until answered; answer them the way a dismissing
// user would. No `beforeunload` handler runs, however it was registered (a listener, `onbeforeunload`, the
// `<body>` attribute): this one is the first, and stops the event, so no navigation stops to ask.
Reflect.set(globalThis, "alert", () => undefined);
Reflect.set(globalThis, "confirm", () => false);
Reflect.set(globalThis, "prompt", () => null);
window.addEventListener("beforeunload", (event) => event.stopImmediatePropagation(), { capture: true });

const finishAnimations = () => {
  // An SVG or XML document (an `<object>`'s, a frame's) has no head and no CSS animations of this kind.
  if (!document.head) return;
  const style = document.createElement("style");
  style.textContent = FINISH_ANIMATIONS;
  document.head.append(style);
};
// Run into a page that has already loaded (the blank page a test starts on), the event is long gone.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", finishAnimations);
else finishAnimations();

/** Resources the page can't read itself, answered by the Bun side from the bytes Chrome received. */
const outsideAnswers = new Map<number, (result: FetchedResource) => void>();
let nextOutside = 0;
function fetchOutsidePage(url: string): Promise<FetchedResource> {
  const binding: unknown = Reflect.get(globalThis, OUTSIDE_PAGE_BINDING);
  if (typeof binding !== "function") return Promise.resolve({ error: "no outside-page channel in this document" });
  const id = ++nextOutside;
  return new Promise((resolve) => {
    outsideAnswers.set(id, resolve);
    binding(JSON.stringify({ id, url }));
  });
}

Reflect.set(globalThis, PAGE_HELPERS_GLOBAL, {
  ...dom,
  pause: () => clock.pause(),
  resume: () => clock.resume(),
  settle: () => settle({ fonts: "used", lazyToEager: false }),
  answerOutside: (id: number, result: FetchedResource) => {
    outsideAnswers.get(id)?.(result);
    outsideAnswers.delete(id);
  },
  /** Serialize the page and archive what it uses. `loaded` adds the URLs Chrome loaded that Resource Timing
   *  doesn't list. Returns JSON, with the warnings for the Bun side to print. */
  capture: async (id: string, loaded: string[]) => {
    const deadline = performance.now() + CAPTURE_BUDGET_MS;
    const warnings: string[] = [];
    const warn = (message: string) => void warnings.push(message);
    dom.clearRefs();
    const serialized = serializeDocument();
    if (!serialized) throw new Error(`rrweb failed to serialize the DOM for "${id}"`);
    await inlineBlobs(id, serialized, { deadline, warn });
    const resources = await collectResources(id, serialized, { loaded, fetchOutsidePage, deadline, warn, skipFrames: true });
    return JSON.stringify({
      dom: serialized,
      resources,
      deviceScaleFactor: devicePixelRatio,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      warnings,
    });
  },
});
