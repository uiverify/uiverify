import { readFileSync } from "node:fs";
import type { CapturedResource, CapturedSnapshot } from "@uiverify/archive-core";
import { type FetchedResource, isArchivableResource, MAX_RESOURCE_BYTES } from "@uiverify/archive-core/browser";
import { chromePath } from "./chrome";
import { StaleTestError, testScope } from "./context";
import { OUTSIDE_PAGE_BINDING, PAGE_CONFIG_GLOBAL, PAGE_HELPERS_GLOBAL } from "./page/protocol";
import { type RouteDecision, Router } from "./routes";
import { CALL_TIMEOUT_MS, type Lane, Slot } from "./slot";

export interface Viewport {
  width: number;
  height: number;
}

/** What each test sets up fresh. */
export interface TestSetup {
  viewport: Viewport;
  /** The page clock's start, epoch ms. */
  now: number;
  colorScheme: "light" | "dark";
}

/** What a capture reads off the page. */
export type PageCapture = Pick<CapturedSnapshot, "dom" | "resources" | "deviceScaleFactor" | "colorScheme">;

/** A desktop window, 1280×800: the window's size until a test pins its viewport, and a ready-made viewport. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** The flags UI Verify's capturer uses where they matter to a capture: no scrollbars, sRGB colours, and lazy
 *  images loaded up front (they keep `loading="lazy"` in the DOM); and the browser's language. Chrome is
 *  shared by every view in a process, so these are fixed when the first opens. */
const CHROME_FLAGS = [
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--blink-settings=lazyLoadEnabled=false",
  // `navigator.language` and `Accept-Language`, which the locale override doesn't reach, so a page that picks
  // its language from them renders the same on a German Mac as on CI.
  "--lang=en-US",
  "--accept-lang=en-US",
];

const H = PAGE_HELPERS_GLOBAL;
const STILL_FOR = 3;
const STILL_TIMEOUT_MS = 10_000;
/** The first page also launches Chrome, which on a busy CI runner takes well over a call's 15 s. */
const OPEN_TIMEOUT_MS = 60_000;
const NATIVE_DRAIN_MS = 5_000;
/** How long a navigation an action asked for may take to start before it counts as cancelled. */
const NAVIGATION_START_MS = 3_000;
const NOT_A_VISUAL_ASSET = "not a visual asset";

let pageScript: string | undefined;

/** The built page script, next to this module in `dist/`. */
function readPageScript(): string {
  pageScript ??= readFileSync(new URL("./page-script.js", import.meta.url), "utf8");
  return pageScript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return null;
}

/** Subscribe to a CDP event. The listener takes a plain `Event` (bun-types 1.4.1 typed the MessageEvent
 *  overload wrongly) and reads the params off the MessageEvent Bun dispatches. */
function on(view: Bun.WebView, type: `${string}.${string}`, listener: (params: Record<string, unknown>) => void): void {
  view.addEventListener(type, (event: Event) => {
    if (event instanceof MessageEvent && isRecord(event.data)) listener(event.data);
  });
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`@uiverify/bun: ${what} took longer than ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

interface Paused {
  generation: number;
  isDocument: boolean;
  frameId: string | undefined;
}

/** One request as Chrome's network log saw it, for the outside-page channel. */
interface Logged {
  /** The URL first requested; a redirect keeps the request id. */
  url: string;
  generation: number;
  /** Made by the capture's own archive step, whose answer may differ from the page's (a 429). */
  duringArchive: boolean;
  status: number;
  contentType: string | null;
  finished: boolean;
}

/**
 * One headless Chrome tab driven through `Bun.WebView` and CDP: request interception for routes, the
 * per-test reset, and the queues that keep each of the view's one-call-at-a-time slots from wedging.
 *
 * Page calls (locator queries, input, evaluate) are held while the main frame navigates or a paused request
 * is a document: a call that waits on the new document would otherwise sit in the CDP slot ahead of the
 * answer that lets that document load. Interception answers never wait.
 *
 * Each test is a generation. A call a test makes is checked against it when it runs, so a test bun:test has
 * given up on can't act on the next test's page; interception answers are stamped with the generation
 * current when their request paused.
 */
export class Tab {
  readonly router = new Router();
  #view: Bun.WebView | undefined;
  #cdpSlot = new Slot("CDP");
  #evalSlot = new Slot("evaluate");
  #nativeSlot = new Slot("input");
  #generation = 0;
  #mainFrameId = "";
  #navigating = false;
  #navigationRequested = false;
  #navigationRequestTimer: ReturnType<typeof setTimeout> | undefined;
  #unheldWaiters: (() => void)[] = [];
  #paused = new Map<string, Paused>();
  #pausedDocuments = new Set<string>();
  #initScripts: string[] = [];
  /** This test's: every URL interception answered, every origin requested, what routes answered, route
   *  errors, and Chrome's network log. */
  #answered = new Set<string>();
  #requestedOrigins = new Set<string>();
  #fulfilled = new Map<string, CapturedResource>();
  #routeErrors: string[] = [];
  /** Uncaught errors and unhandled rejections on any of this test's documents. */
  #pageErrors: string[] = [];
  #network = new Map<string, Logged>();
  #archiving = false;
  #beginning: Promise<unknown> = Promise.resolve();

  constructor(readonly baseUrl: string | undefined) {}

  get generation(): number {
    return this.#generation;
  }

  #requireView(): Bun.WebView {
    if (!this.#view) throw new Error("@uiverify/bun: the page is not open");
    return this.#view;
  }

  #held(): boolean {
    return this.#navigating || this.#navigationRequested || this.#pausedDocuments.size > 0;
  }

  /** The page stopped being held, maybe: let queued page calls go. */
  #release(): void {
    this.#cdpSlot.pump();
    this.#evalSlot.pump();
    this.#nativeSlot.pump();
    if (this.#held()) return;
    for (const resolve of this.#unheldWaiters.splice(0)) resolve();
  }

  /** A check that the calling test is still the current one, taken now and run when the call is sent. */
  #guard(what: string): () => void {
    const scope = testScope.getStore();
    return () => {
      if (scope && scope.generation !== this.#generation) throw new StaleTestError(what);
    };
  }

  /** Throws if the calling test has ended. */
  assertCurrent(what: string): void {
    this.#guard(what)();
  }

  cdp<T>(lane: Lane, method: string, params?: Record<string, unknown>): Promise<T> {
    const view = this.#requireView();
    return this.#cdpSlot.call(lane, method, () => view.cdp<T>(method, params), lane === "page" ? this.#guard(method) : undefined);
  }

  evaluate<T>(script: string): Promise<T> {
    const view = this.#requireView();
    return this.#evalSlot.call("page", "evaluate", () => view.evaluate<T>(script), this.#guard("evaluate"));
  }

  /** A `view.click`/`view.type`, which take the view's third slot. */
  native<T>(what: string, act: (view: Bun.WebView) => Promise<T>): Promise<T> {
    const view = this.#requireView();
    return this.#nativeSlot.call("page", what, () => act(view), this.#guard(what));
  }

  async navigate(url: string): Promise<void> {
    this.assertCurrent("goto");
    // A change of the fragment alone is a same-document navigation, which `view.navigate` waits on forever.
    // Only a URL with a fragment is checked: the check is a page call, which waits out a load still pending
    // that a plain goto replaces, and after which this test may have ended.
    if (url.includes("#")) {
      const current = await this.evaluate<string>("location.href");
      const withoutHash = (href: string) => href.split("#")[0];
      if (withoutHash(url) === withoutHash(current)) {
        await this.evaluate(`void (location.href = ${JSON.stringify(url)})`);
        return;
      }
      this.assertCurrent("goto");
    }
    await this.#requireView().navigate(url);
  }

  async addInitScript(source: string): Promise<void> {
    const { identifier } = await this.cdp<{ identifier: string }>("page", "Page.addScriptToEvaluateOnNewDocument", {
      source,
    });
    this.#initScripts.push(identifier);
  }

  /** After an action: if it started a navigation of the page (a link, a form), wait for its load, as
   *  Playwright's click does. */
  async afterAction(): Promise<void> {
    await Bun.sleep(50);
    if (!this.#held()) return;
    await withTimeout(new Promise<void>((resolve) => this.#unheldWaiters.push(resolve)), CALL_TIMEOUT_MS, "the navigation an action started");
  }

  close(): void {
    this.#view?.close();
    this.#view = undefined;
  }

  async #open(): Promise<void> {
    const view = new Bun.WebView({
      ...DEFAULT_VIEWPORT,
      backend: { type: "chrome", path: chromePath(), argv: CHROME_FLAGS },
    });
    this.#view = view;
    const held = () => this.#held();
    this.#cdpSlot = new Slot("CDP", held);
    this.#evalSlot = new Slot("evaluate", held);
    this.#nativeSlot = new Slot("input", held);
    try {
      await withTimeout(view.navigate("about:blank"), OPEN_TIMEOUT_MS, "opening the page");
      this.#listen(view);
      await this.cdp("reset", "Page.enable");
      const { frameTree } = await this.cdp<{ frameTree: { frame: { id: string } } }>("reset", "Page.getFrameTree");
      this.#mainFrameId = frameTree.frame.id;
      await Promise.all([
        this.cdp("reset", "DOM.enable"),
        this.cdp("reset", "Accessibility.enable"),
        this.cdp("reset", "Runtime.enable"),
        this.cdp("reset", "Runtime.addBinding", { name: OUTSIDE_PAGE_BINDING }),
        this.cdp("reset", "Network.enable", { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 }),
        this.cdp("reset", "Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
        this.cdp("reset", "Target.setDiscoverTargets", { discover: true }),
        this.cdp("reset", "Emulation.setTimezoneOverride", { timezoneId: "UTC" }),
        this.cdp("reset", "Emulation.setLocaleOverride", { locale: "en-US" }),
      ]);
    } catch (error) {
      // Half set up, a view would run later tests without interception or page errors: the next one opens anew.
      this.close();
      throw error;
    }
  }

  /** Close a wedged view and open a fresh one, in the same Chrome. */
  async #replace(): Promise<void> {
    for (const slot of [this.#cdpSlot, this.#evalSlot, this.#nativeSlot]) slot.drop("the view was replaced");
    this.#view?.close();
    this.#view = undefined;
    this.#paused.clear();
    this.#pausedDocuments.clear();
    this.#initScripts = [];
    await this.#open();
  }

  #listen(view: Bun.WebView): void {
    on(view, "Fetch.requestPaused", (params) => void this.#onPaused(params));
    on(view, "Page.frameStartedLoading", (params) => {
      if (params.frameId !== this.#mainFrameId) return;
      this.#navigating = true;
      this.#endNavigationRequest();
    });
    on(view, "Page.frameStoppedLoading", (params) => {
      if (params.frameId !== this.#mainFrameId) return;
      this.#navigating = false;
      this.#endNavigationRequest();
      this.#release();
    });
    on(view, "Page.frameRequestedNavigation", (params) => {
      if (params.frameId !== this.#mainFrameId || params.disposition !== "currentTab") return;
      this.#navigationRequested = true;
      clearTimeout(this.#navigationRequestTimer);
      // A navigation that never starts (cancelled by the page, say) must not hold the page.
      this.#navigationRequestTimer = setTimeout(() => {
        this.#navigationRequested = false;
        this.#release();
      }, NAVIGATION_START_MS);
    });
    on(view, "Page.frameDetached", (params) => {
      let released = false;
      for (const [requestId, paused] of this.#paused) {
        if (paused.isDocument && paused.frameId === params.frameId) released = this.#pausedDocuments.delete(requestId) || released;
      }
      if (released) this.#release();
    });
    on(view, "Runtime.exceptionThrown", (params) => {
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
      const exception = isRecord(details.exception) ? details.exception : {};
      const description = (text(exception, "description") ?? text(exception, "value") ?? "").split("\n")[0];
      this.#pageErrors.push([text(details, "text") ?? "Uncaught", description].filter(Boolean).join(" "));
    });
    // A tab the page opens (a `target=_blank` link, `window.open`) is closed: in front, it leaves this page
    // in the background, where the browser stops answering the accessibility queries locators make.
    on(view, "Target.targetCreated", (params) => {
      const info = isRecord(params.targetInfo) ? params.targetInfo : {};
      const targetId = text(info, "targetId");
      if (targetId && text(info, "type") === "page" && text(info, "openerId")) {
        void this.cdp("answer", "Target.closeTarget", { targetId }).catch(() => {});
      }
    });
    on(view, "Page.downloadWillBegin", () => {
      this.#endNavigationRequest();
      this.#release();
    });
    on(view, "Network.requestWillBeSent", (params) => {
      const requestId = text(params, "requestId");
      const url = isRecord(params.request) ? text(params.request, "url") : undefined;
      if (!requestId || !url) return;
      const logged = this.#network.get(requestId);
      if (logged) Object.assign(logged, { status: 0, contentType: null, finished: false });
      else {
        this.#network.set(requestId, {
          url,
          generation: this.#generation,
          duringArchive: this.#archiving,
          status: 0,
          contentType: null,
          finished: false,
        });
      }
    });
    on(view, "Network.responseReceived", (params) => {
      const logged = this.#network.get(text(params, "requestId") ?? "");
      if (!logged || !isRecord(params.response)) return;
      const { status, mimeType } = params.response;
      logged.status = typeof status === "number" ? status : 0;
      logged.contentType =
        headerValue(stringRecord(params.response.headers), "content-type") ?? (typeof mimeType === "string" ? mimeType : null);
    });
    on(view, "Network.loadingFinished", (params) => {
      const logged = this.#network.get(text(params, "requestId") ?? "");
      if (logged) logged.finished = true;
    });
    on(view, "Runtime.bindingCalled", (params) => {
      if (params.name !== OUTSIDE_PAGE_BINDING || typeof params.executionContextId !== "number") return;
      let request: unknown;
      try {
        request = JSON.parse(text(params, "payload") ?? "");
      } catch {
        return;
      }
      if (!isRecord(request) || typeof request.id !== "number" || typeof request.url !== "string") return;
      void this.#answerOutsidePage(params.executionContextId, request.id, request.url);
    });
  }

  #endNavigationRequest(): void {
    this.#navigationRequested = false;
    clearTimeout(this.#navigationRequestTimer);
  }

  async #onPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = text(params, "requestId");
    const request = params.request;
    if (!requestId || !isRecord(request)) return;
    const url = text(request, "url") ?? "";
    const method = text(request, "method") ?? "GET";
    const headers = stringRecord(request.headers);
    const generation = this.#generation;
    const isDocument = params.resourceType === "Document";
    this.#paused.set(requestId, { generation, isDocument, frameId: text(params, "frameId") });
    if (isDocument) this.#pausedDocuments.add(requestId);
    if (/^https?:/.test(url)) this.#requestedOrigins.add(new URL(url).origin);

    let decision: RouteDecision;
    try {
      decision = await this.router.decide({ url, method, headers });
    } catch (error) {
      decision = { kind: "error", message: `${method} ${url}: ${String(error)}` };
    }
    // The reset already failed a request left over from an earlier test.
    if (this.#paused.get(requestId)?.generation !== generation || generation !== this.#generation) return;
    this.#paused.delete(requestId);
    const answer =
      decision.kind === "fulfill"
        ? this.cdp("answer", "Fetch.fulfillRequest", { requestId, ...decision.response })
        : decision.kind === "continue"
          ? this.cdp("answer", "Fetch.continueRequest", { requestId })
          : this.cdp("answer", "Fetch.failRequest", { requestId, errorReason: "Failed" });
    if (decision.kind === "error") this.#routeErrors.push(decision.message);
    // A document (a frame's) is never an archivable resource.
    else if (!isDocument) this.#answered.add(url);
    if (decision.kind === "fulfill") {
      const { responseCode, responseHeaders, body } = decision.response;
      const contentType = responseHeaders.find((header) => header.name.toLowerCase() === "content-type")?.value ?? null;
      this.#fulfilled.set(url, { contentType, status: responseCode, body });
    } else {
      // Now the network's (or nobody's): an earlier routed answer is no longer what the page shows.
      this.#fulfilled.delete(url);
    }
    if (this.#pausedDocuments.delete(requestId)) this.#release();
    // A request the page has since abandoned can't be answered; nothing waits on it.
    await answer.catch(() => {});
  }

  /** The outside-page channel: a resource the page can't read itself, answered from the bytes Chrome received
   *  for this test's page (a routed URL's own answer). Never a fetch of its own, so it reaches nothing Chrome
   *  didn't already load, and only visual assets: a page can't read an API's text back through it. */
  async #receivedBytes(url: string): Promise<FetchedResource> {
    if (!/^https?:/.test(url)) return { error: "not loaded by the page" };
    const routed = this.#fulfilled.get(url);
    if (routed) return isArchivableResource(url, routed.contentType) ? { resource: routed } : { error: NOT_A_VISUAL_ASSET };
    const candidates = [...this.#network].filter(
      ([, logged]) => logged.url === url && logged.generation === this.#generation && !logged.duringArchive && logged.finished,
    );
    // The latest good answer: what the page shows now if it loaded the URL more than once.
    const chosen = [...candidates].reverse().find(([, logged]) => logged.status >= 200 && logged.status < 300) ?? candidates.at(-1);
    if (!chosen) return { error: "the page loaded no complete response for it" };
    const [requestId, logged] = chosen;
    if (!isArchivableResource(url, logged.contentType)) return { error: NOT_A_VISUAL_ASSET };
    let response: { body: string; base64Encoded: boolean };
    try {
      response = await this.cdp("answer", "Network.getResponseBody", { requestId });
    } catch {
      return { error: "Chrome no longer holds its body" };
    }
    const body = response.base64Encoded ? response.body : Buffer.from(response.body).toString("base64");
    if (Buffer.byteLength(body, "base64") > MAX_RESOURCE_BYTES) return { error: "larger than the 10 MB per-resource limit" };
    return { resource: { contentType: logged.contentType, status: logged.status, body } };
  }

  async #answerOutsidePage(contextId: number, id: number, url: string): Promise<void> {
    const generation = this.#generation;
    const result = await this.#receivedBytes(url);
    if (generation !== this.#generation) return;
    const expression = `${H}.answerOutside(${id}, ${JSON.stringify(result)})`;
    await this.cdp("answer", "Runtime.evaluate", { expression, contextId }).catch(() => {});
  }

  /**
   * A fresh start for a test, as close to a new browser context as `Bun.WebView` allows: a blank page, no
   * init scripts or routes, the storage of every origin the last test requested cleared, no cookies, no
   * history, `window.name` empty, this test's emulation, the mouse parked. Chrome, its HTTP cache and its
   * font caches persist. Returns the test's generation.
   */
  begin(setup: TestSetup): Promise<number> {
    // One at a time: a reset bun:test gave up on must finish before the next test's starts.
    const beginning = this.#beginning.then(async () => {
      if (!this.#view) await this.#open();
      this.#generation++;
      try {
        await this.#reset(setup);
      } catch {
        await this.#replace();
        await this.#reset(setup);
      }
      return this.#generation;
    });
    this.#beginning = beginning.catch(() => {});
    return beginning;
  }

  async #reset(setup: TestSetup): Promise<void> {
    this.router.clear();
    for (const requestId of this.#paused.keys()) {
      void this.cdp("answer", "Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
    }
    this.#paused.clear();
    this.#pausedDocuments.clear();
    this.#navigating = false;
    this.#endNavigationRequest();
    // Unheld, the last test's queued page calls go and fail their generation check. Then the slots must
    // drain: a keystroke a timed-out test started must not land on this page, and a call the browser never
    // answers would hold every call behind it.
    this.#release();
    if (!(await this.#drained(this.#nativeSlot)) || !(await this.#drained(this.#cdpSlot))) await this.#replace();
    // Through CDP, not `view.navigate`: it also releases a `view.navigate` a timed-out test left pending. Its
    // own load must be waited for (not just any stop: a failed request's error page stops too), or the
    // clearing below fails on a detached page.
    await this.cdp("reset", "Page.navigate", { url: "about:blank" });
    await this.#blankLoaded();

    this.#answered.clear();
    this.#fulfilled.clear();
    this.#routeErrors = [];
    this.#pageErrors = [];
    this.#network.clear();
    for (const identifier of this.#initScripts.splice(0)) {
      await this.cdp("reset", "Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    // Kept until every one is cleared, so a reset that fails here and is retried clears them all.
    const origins = new Set(this.#requestedOrigins);
    if (this.baseUrl) origins.add(new URL(this.baseUrl).origin);
    for (const origin of origins) {
      await this.cdp("reset", "Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    }
    this.#requestedOrigins.clear();
    await this.cdp("reset", "Network.clearBrowserCookies");
    await this.cdp("reset", "Page.resetNavigationHistory");
    await this.cdp("reset", "Runtime.evaluate", { expression: 'window.name = ""' });

    const config = `globalThis.${PAGE_CONFIG_GLOBAL} = ${JSON.stringify({ now: setup.now })};\n`;
    // Also into the blank page already open, so a test that never navigates still has the helpers.
    const { identifier } = await this.cdp<{ identifier: string }>("reset", "Page.addScriptToEvaluateOnNewDocument", {
      source: config + readPageScript(),
      runImmediately: true,
    });
    this.#initScripts.push(identifier);
    await this.cdp("reset", "Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: setup.colorScheme },
      ],
    });
    // Bun.WebView sizes the window, and headless Chrome takes part of it for browser UI: pin the viewport
    // itself, as Playwright does.
    await this.cdp("reset", "Emulation.setDeviceMetricsOverride", { ...setup.viewport, deviceScaleFactor: 1, mobile: false });
    await this.cdp("reset", "Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  }

  async #blankLoaded(): Promise<void> {
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    for (;;) {
      const { result } = await this.cdp<{ result: { value?: unknown } }>("reset", "Runtime.evaluate", {
        expression: 'location.href === "about:blank" && document.readyState === "complete"',
        returnByValue: true,
      });
      if (result.value === true) return;
      if (Date.now() > deadline) throw new Error("@uiverify/bun: about:blank didn't load between tests");
      await Bun.sleep(20);
    }
  }

  async #drained(slot: Slot): Promise<boolean> {
    const deadline = Date.now() + NATIVE_DRAIN_MS;
    while (!slot.idle) {
      if (Date.now() > deadline) return false;
      await Bun.sleep(20);
    }
    return true;
  }

  /** What went wrong on the page this test, on any of its documents: uncaught errors and unhandled
   *  rejections, and route handlers that failed. */
  pageErrors(): string | undefined {
    const errors = [...this.#pageErrors, ...this.#routeErrors];
    return errors.length ? `@uiverify/bun: the page reported errors:\n${errors.join("\n")}` : undefined;
  }

  #throwPageErrors(): void {
    const errors = this.pageErrors();
    if (errors) throw new Error(errors);
  }

  /** Wait until nothing on the page moves: three equal signatures in a row. Polled from here, so it also
   *  works while the page's clock is paused. */
  async #waitStill(): Promise<void> {
    const signature = () => this.evaluate<string[] | null>(`${H}.signature()`);
    const deadline = Date.now() + STILL_TIMEOUT_MS;
    let previous = await signature();
    for (let still = 0; still < STILL_FOR; ) {
      await Bun.sleep(50);
      const next = await signature();
      const same = next !== null && previous !== null && next.join("|") === previous.join("|");
      if (!same && Date.now() > deadline) throw new Error(await this.#stillFailure(previous, next));
      still = same ? still + 1 : 0;
      previous = next;
    }
  }

  async #stillFailure(previous: string[] | null, next: string[] | null): Promise<string> {
    let what = "an image that never finished loading";
    if (previous && next) {
      const index = next.findIndex((entry, i) => entry !== previous[i]);
      what = await this.evaluate<string>(`${H}.describe(${index === -1 ? previous.length : index})`);
    }
    return (
      `@uiverify/bun: the page never stopped changing within ${STILL_TIMEOUT_MS / 1000}s (${what} kept changing). ` +
      "If something animates on its own (a requestAnimationFrame loop, a Lottie), stop it while " +
      "UI Verify captures: check isUIVerify()."
    );
  }

  /** Settle the page and read it into a capture: page and route errors fail it, before and after. */
  async capture(id: string): Promise<PageCapture> {
    this.#throwPageErrors();
    await this.evaluate(`${H}.settle()`);
    await this.#waitStill();
    this.#archiving = true;
    let raw: string;
    try {
      raw = await this.evaluate<string>(`${H}.capture(${JSON.stringify(id)}, ${JSON.stringify([...this.#answered])})`);
    } finally {
      this.#archiving = false;
    }
    this.#throwPageErrors();
    const { warnings, ...capture }: PageCapture & { warnings: string[] } = JSON.parse(raw);
    for (const warning of warnings) console.warn(warning);
    return capture;
  }
}
