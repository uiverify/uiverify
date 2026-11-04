import type { CapturedResource } from "@uiverify/archive-core";
import { FETCH_TIMEOUT_MS, isArchivableResource, isModuleOrData, MAX_RESOURCE_BYTES } from "@uiverify/archive-core/browser";

/**
 * The Node side of capture's network recording. Vitest hands every browser command the session's Playwright
 * page, whose child iframes run the test files; listening to it records the bytes each test document
 * actually received and tracks what it still has in flight, so a capture can wait for the network to go
 * quiet and archive what the page drew instead of downloading it again. Playwright is reached only through
 * the structural guards below, so the package depends on neither it nor its types, and a page that isn't
 * Playwright's simply isn't recorded.
 */

/** The parts of Playwright's `Frame` the recorder uses. */
export interface FrameLike {
  url(): string;
  parentFrame(): FrameLike | null;
  isDetached(): boolean;
}

/** The parts of Playwright's `Request` the recorder uses. */
export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  frame(): FrameLike;
  redirectedFrom(): RequestLike | null;
}

/** The parts of Playwright's `Response` the recorder uses. */
export interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  request(): RequestLike;
}

/** The parts of Playwright's `Page` the recorder uses. Events arrive as `unknown` and are checked by the
 *  guards, so nothing here trusts that the page is Playwright's. */
export interface PageLike {
  on(event: string, listener: (value: unknown) => void): unknown;
  mainFrame(): FrameLike;
  frames(): FrameLike[];
}

function hasMethods(value: unknown, names: string[]): boolean {
  return typeof value === "object" && value !== null && names.every((name) => typeof Reflect.get(value, name) === "function");
}

export function isPage(value: unknown): value is PageLike {
  return hasMethods(value, ["on", "mainFrame", "frames"]);
}

function isFrame(value: unknown): value is FrameLike {
  return hasMethods(value, ["url", "parentFrame", "isDetached"]);
}

function isRequest(value: unknown): value is RequestLike {
  return hasMethods(value, ["url", "method", "resourceType", "headers", "frame", "redirectedFrom"]);
}

function isResponse(value: unknown): value is ResponseLike {
  return hasMethods(value, ["url", "status", "headers", "body", "request"]);
}

/** How long the test document must have nothing in flight before a capture counts it as quiet. */
export const IDLE_INTERVAL_MS = 100;

/** How often a wait re-checks the document. */
const POLL_MS = 20;

/** How long registering a document waits for its frame's URL to reach Node. */
const REGISTER_WAIT_MS = 2_000;

/** Recorded bodies one process may hold at once, across every session and document. */
export const MAX_RECORDED_BYTES = 512 * 1024 * 1024;

/** Requests that never count as the page still loading: streams that stay open by nature, and module JS
 *  (Vitest resolves a lazy `import()` over its own RPC before the request starts, so the wait couldn't
 *  promise it anyway). */
const UNCOUNTED_TYPES = new Set(["eventsource", "websocket", "media", "script"]);

/** How long a request's start or end stays in a document's activity log: comfortably past any quiet window. */
const ACTIVITY_KEPT_MS = 2_000;

interface RecordedBody {
  contentType: string | null;
  bytes: Buffer;
}

interface Recording {
  request: RequestLike;
  body: Promise<RecordedBody | null>;
  /** The document's test count when it was recorded. */
  test: number;
  /** Set once the body has been read and kept. */
  ready: boolean;
  /** Set once the body read has ended, kept or not. */
  settled: boolean;
  /** The bytes it holds against the budget, once ready. */
  size: number;
}

/** One test file's document (a tester iframe) and what the recorder knows about it. */
interface Doc {
  frame: FrameLike;
  recordings: Map<string, Recording>;
  /** Requests whose bodies have fully arrived (or failed), so a lookup can tell a finished one from one that
   *  may never finish. */
  finished: WeakSet<RequestLike>;
  inFlight: Set<RequestLike>;
  /** When counted requests started or ended, newest last. */
  activity: { request: RequestLike; at: number; started: boolean }[];
  /** Requests still loading when a wait gave up: they never hold a wait in this document again. */
  exempt: WeakSet<RequestLike>;
  /** The method and URL of those, with the test each gave up in: a long poll re-issued within that test
   *  doesn't hold its later waits either, while another test's request to the same URL still does. */
  exemptUrls: Map<string, string>;
  /** Tests begun in this document, so a recording knows whether it came from the current one. */
  tests: number;
  /** The test each request was made in, read when it started: its response can land after the next test began. */
  requestedIn: WeakMap<RequestLike, number>;
  /** The last test that asked for each URL: a response made for an earlier one never stands in for it. */
  lastAskedIn: Map<string, number>;
  bytes: number;
}

/** What a wait for the network to go quiet found. */
export interface IdleResult {
  /** URLs still loading when the wait gave up (or, with nothing in flight then, requests that kept starting
   *  inside the quiet window); empty when the document went quiet. */
  pending: string[];
  /** Every URL the document holds a body for, read or finished and on its way from Chromium (it can still come
   *  back empty, and then the capture fetches it). One whose request is still loading is left out, so a body
   *  that stalls stays as invisible to the capture as it is to Resource Timing. */
  recorded: string[];
}

/** The byte budget every recorder in the process shares. */
export class ByteBudget {
  private used = 0;
  constructor(private readonly limit: number) {}
  take(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
  give(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
}

const processBudget = new ByteBudget(MAX_RECORDED_BYTES);

function requestKey(request: RequestLike): string {
  return `${request.method()} ${request.url()}`;
}

/** Vite's own module paths. */
function isViteInternal(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return /^\/@(vite|id|fs)\//.test(pathname) || pathname.includes("/node_modules/.vite/");
  } catch {
    return false;
  }
}

/** The request and the URLs before it in its redirect chain: the DOM names the first one. */
function redirectChainUrls(request: RequestLike): string[] {
  const urls: string[] = [];
  for (let at = request.redirectedFrom(); at; at = at.redirectedFrom()) urls.push(at.url());
  return urls;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

export class NetworkRecorder {
  private readonly docs = new Map<FrameLike, Doc>();
  private readonly tokens = new Map<number, Doc>();
  private nextToken = 1;

  constructor(
    private readonly page: PageLike,
    private readonly budget: ByteBudget = processBudget,
    private readonly now: () => number = () => performance.now(),
  ) {
    page.on("request", (value) => {
      if (isRequest(value)) this.onRequest(value);
    });
    page.on("response", (value) => {
      if (isResponse(value)) this.onResponse(value);
    });
    page.on("requestfinished", (value) => {
      if (isRequest(value)) this.onDone(value);
    });
    page.on("requestfailed", (value) => {
      if (isRequest(value)) this.onDone(value);
    });
    page.on("framedetached", (value) => {
      if (isFrame(value)) this.drop(value);
    });
  }

  /** Start recording the tester iframe at `href` (the page's own `location.href`, read before any test can
   *  change it), and return the token later commands name it by; `null` when no such frame turns up. The
   *  frame's URL reaches Node over CDP while this call comes over Vitest's socket, so on a session's first file
   *  it can still be catching up: it gets `wait` ms to. */
  async register(href: string, wait = REGISTER_WAIT_MS): Promise<number | null> {
    const main = this.page.mainFrame();
    const find = () => this.page.frames().find((f) => f.parentFrame() === main && !f.isDetached() && f.url() === href);
    const start = this.now();
    let frame = find();
    while (!frame && this.now() - start < wait) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      frame = find();
    }
    if (!frame) return null;
    for (const [token, doc] of this.tokens) if (doc.frame === frame) return token;
    // A page runs one test file at a time, so a new document means the previous one is done, whenever this
    // Vitest version gets round to removing its iframe.
    for (const doc of [...this.docs.values()]) this.drop(doc.frame);
    const doc: Doc = {
      frame,
      recordings: new Map(),
      finished: new WeakSet(),
      inFlight: new Set(),
      activity: [],
      exempt: new WeakSet(),
      exemptUrls: new Map(),
      tests: 0,
      requestedIn: new WeakMap(),
      lastAskedIn: new Map(),
      bytes: 0,
    };
    const token = this.nextToken++;
    this.docs.set(frame, doc);
    this.tokens.set(token, doc);
    return token;
  }

  /** Resolve once the document has had nothing counted in flight for `interval` ms, measured from the call
   *  (a request the page started just before it can reach Node after it, over another channel), or when
   *  `timeout` ms pass. What was still loading then stops holding later waits: the request itself for the rest
   *  of the document, its method and URL for the rest of `test`. `timeout` 0 only reports. */
  async waitForIdle(token: number, timeout: number, test: string, interval = IDLE_INTERVAL_MS): Promise<IdleResult> {
    const doc = this.tokens.get(token);
    if (!doc) return { pending: [], recorded: [] };
    const counted = (request: RequestLike) => !doc.exempt.has(request) && doc.exemptUrls.get(requestKey(request)) !== test;
    const start = this.now();
    let pending: RequestLike[] = [];
    if (timeout > 0) {
      for (;;) {
        pending = [...doc.inFlight].filter(counted);
        let lastActivity = start;
        for (const entry of doc.activity) if (counted(entry.request)) lastActivity = Math.max(lastActivity, entry.at);
        const now = this.now();
        if (!pending.length && now - lastActivity >= interval) break;
        if (now - start >= timeout || !this.tokens.has(token)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, timeout - (now - start)))));
      }
      // Nothing in flight at the timeout, but a request started within the last interval: short requests kept
      // starting less than `interval` apart. Those are given up on too, or every later wait in the test would
      // run to its timeout without a word. (One that merely finished late isn't.)
      if (!pending.length) {
        const recent = new Set<RequestLike>();
        const now = this.now();
        for (const entry of doc.activity) {
          if (entry.started && now - entry.at < interval && counted(entry.request)) recent.add(entry.request);
        }
        pending = [...recent];
      }
      for (const request of pending) {
        doc.exempt.add(request);
        doc.exemptUrls.set(requestKey(request), test);
      }
    }
    const recorded = [...doc.recordings]
      .filter(([, r]) => r.ready || (!r.settled && doc.finished.has(r.request)))
      .map(([url]) => url);
    return { pending: pending.map((request) => request.url()), recorded };
  }

  /** A test began in the document: from now on, its own responses replace what earlier tests recorded. */
  beginTest(token: number): void {
    const doc = this.tokens.get(token);
    if (doc) doc.tests++;
  }

  /** The recorded resources among `urls`. One whose request is still loading is left out: its body may never
   *  arrive, and the capture's own fetch can still try it. A finished one's body may still be on its way from
   *  Chromium, so that is awaited (bounded). */
  async recorded(token: number, urls: string[]): Promise<Record<string, CapturedResource>> {
    const doc = this.tokens.get(token);
    if (!doc) return {};
    const out: Record<string, CapturedResource> = {};
    await Promise.all(
      urls.map(async (url) => {
        const recording = doc.recordings.get(url);
        if (!recording || !doc.finished.has(recording.request)) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
        });
        const body = await Promise.race([recording.body, timeout]);
        clearTimeout(timer);
        if (body) out[url] = { contentType: body.contentType, status: 200, body: body.bytes.toString("base64") };
      }),
    );
    return out;
  }

  /** The tester iframe a request was made from, or none for the orchestrator, a service worker, or a frame
   *  already gone. */
  private docOf(request: RequestLike): Doc | undefined {
    try {
      const main = this.page.mainFrame();
      let frame: FrameLike | null = request.frame();
      while (frame && frame.parentFrame() !== main) frame = frame.parentFrame();
      return frame ? this.docs.get(frame) : undefined;
    } catch {
      return undefined;
    }
  }

  private onRequest(request: RequestLike): void {
    const doc = this.docOf(request);
    if (!doc) return;
    // A redirect hop belongs to the test whose request started the chain.
    const from = request.redirectedFrom();
    doc.requestedIn.set(request, (from && doc.requestedIn.get(from)) ?? doc.tests);
    // The page asked again in a later test, so an earlier test's body is no longer what it shows: only a
    // response this test asked for may take its place (a 404 or a request that never ends leaves nothing).
    if (request.method() === "GET") {
      doc.lastAskedIn.set(request.url(), Math.max(doc.lastAskedIn.get(request.url()) ?? 0, doc.tests));
      const earlier = doc.recordings.get(request.url());
      if (earlier && earlier.test < doc.tests) this.forget(doc, request.url());
    }
    if (UNCOUNTED_TYPES.has(request.resourceType()) || isViteInternal(request.url())) return;
    doc.inFlight.add(request);
    this.logActivity(doc, request, true);
  }

  private onDone(request: RequestLike): void {
    const doc = this.docOf(request);
    if (!doc) return;
    doc.finished.add(request);
    if (doc.inFlight.delete(request)) this.logActivity(doc, request, false);
  }

  private logActivity(doc: Doc, request: RequestLike, started: boolean): void {
    const at = this.now();
    doc.activity.push({ request, at, started });
    const keepFrom = doc.activity.findIndex((entry) => at - entry.at <= ACTIVITY_KEPT_MS);
    if (keepFrom > 0) doc.activity.splice(0, keepFrom);
  }

  /** Record a full response the test document received for a visual asset. Within a test the first body for
   *  a URL is kept: the capture's own requests (settle's probe of a CSS background) come from the same
   *  document, and must not replace what the page drew. When a later test asks for the URL again, only a
   *  response to that test's own request can take its place, since a test can mock the URL with other bytes. */
  private onResponse(response: ResponseLike): void {
    const request = response.request();
    const doc = this.docOf(request);
    if (!doc) return;
    if (request.method() !== "GET" || response.status() !== 200 || headerValue(request.headers(), "range") !== undefined) {
      return;
    }
    const url = response.url();
    if (!/^https?:/.test(url) || isModuleOrData(url)) return;
    const headers = response.headers();
    const contentType = headerValue(headers, "content-type") ?? null;
    if (!isArchivableResource(url, contentType)) return;
    if (Number(headerValue(headers, "content-length")) > MAX_RESOURCE_BYTES) return;
    // A request already in flight when the document registered predates every test.
    const test = doc.requestedIn.get(request) ?? 0;
    const urls = [url, ...redirectChainUrls(request)].filter(
      (u) => (doc.recordings.get(u)?.test ?? -1) < test && (doc.lastAskedIn.get(u) ?? test) <= test,
    );
    if (!urls.length) return;
    const recording: Recording = {
      request,
      body: Promise.resolve(null),
      ready: false,
      settled: false,
      size: 0,
      test,
    };
    recording.body = response.body().then(
      (bytes): RecordedBody | null => {
        const held = [...doc.recordings.values()].includes(recording);
        // Playwright answers an empty body, without failing, when Chromium kept none (an image it couldn't
        // decode, a response with no content-length it already dropped).
        if (!held || !bytes.length || bytes.length > MAX_RESOURCE_BYTES || !this.docs.has(doc.frame)) return null;
        if (!this.budget.take(bytes.length)) return null;
        doc.bytes += bytes.length;
        recording.size = bytes.length;
        recording.ready = true;
        return { contentType, bytes };
      },
      () => null,
    ).finally(() => {
      recording.settled = true;
    });
    for (const u of urls) {
      this.forget(doc, u);
      doc.recordings.set(u, recording);
    }
  }

  /** Stop holding `url`'s recording; its bytes go back to the budget once no URL holds it. */
  private forget(doc: Doc, url: string): void {
    const old = doc.recordings.get(url);
    if (!old) return;
    doc.recordings.delete(url);
    if ([...doc.recordings.values()].includes(old)) return;
    this.budget.give(old.size);
    doc.bytes -= old.size;
    old.size = 0;
  }

  private drop(frame: FrameLike): void {
    const doc = this.docs.get(frame);
    if (!doc) return;
    this.docs.delete(frame);
    for (const [token, d] of this.tokens) if (d === doc) this.tokens.delete(token);
    this.budget.give(doc.bytes);
  }
}

const recorders = new WeakMap<PageLike, NetworkRecorder>();

/** The recorder for a browser command's page, attaching it the first time: `null` unless the command runs on
 *  Playwright's Chromium, the only browser recording was verified on. */
export function recorderFor(ctx: unknown): NetworkRecorder | null {
  if (typeof ctx !== "object" || ctx === null) return null;
  const page: unknown = Reflect.get(ctx, "page");
  if (!isPage(page) || browserName(ctx) !== "chromium") return null;
  let recorder = recorders.get(page);
  if (!recorder) {
    recorder = new NetworkRecorder(page);
    recorders.set(page, recorder);
  }
  return recorder;
}

/** The browser the command's project runs: `config.browser.name`, which Vitest 3, 4 and 5 resolve per
 *  browser instance. */
function browserName(ctx: object): unknown {
  const project: unknown = Reflect.get(ctx, "project");
  const config: unknown = typeof project === "object" && project ? Reflect.get(project, "config") : undefined;
  const browser: unknown = typeof config === "object" && config ? Reflect.get(config, "browser") : undefined;
  return typeof browser === "object" && browser ? Reflect.get(browser, "name") : undefined;
}
