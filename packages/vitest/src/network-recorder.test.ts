import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ByteBudget, type FrameLike, NetworkRecorder, recorderFor, type RequestLike, type ResponseLike } from "./network-recorder";

/** A stand-in for the Playwright page Vitest hands a browser command: an orchestrator frame with tester iframes. */
class FakeFrame implements FrameLike {
  detached = false;
  constructor(
    private readonly href: string,
    private readonly parent: FakeFrame | null,
  ) {}
  url(): string {
    return this.href;
  }
  parentFrame(): FrameLike | null {
    return this.parent;
  }
  isDetached(): boolean {
    return this.detached;
  }
}

class FakePage extends EventEmitter {
  readonly main = new FakeFrame("http://localhost:63315/", null);
  readonly testers: FakeFrame[] = [];
  mainFrame(): FrameLike {
    return this.main;
  }
  frames(): FrameLike[] {
    return [this.main, ...this.testers];
  }
  tester(file: string): FakeFrame {
    const frame = new FakeFrame(`http://localhost:63315/?sessionId=s&iframeId=${file}`, this.main);
    this.testers.push(frame);
    return frame;
  }
  detach(frame: FakeFrame): void {
    frame.detached = true;
    this.emit("framedetached", frame);
  }
}

function request(
  frame: FrameLike,
  url: string,
  options: { method?: string; type?: string; headers?: Record<string, string>; from?: RequestLike } = {},
): RequestLike {
  return {
    url: () => url,
    method: () => options.method ?? "GET",
    resourceType: () => options.type ?? "image",
    headers: () => options.headers ?? {},
    frame: () => frame,
    redirectedFrom: () => options.from ?? null,
  };
}

function response(req: RequestLike, body: Buffer | Promise<Buffer>, status = 200, contentType = "image/png"): ResponseLike {
  return {
    url: () => req.url(),
    status: () => status,
    headers: () => ({ "content-type": contentType }),
    body: () => Promise.resolve(body),
    request: () => req,
  };
}

/** A request's whole life: started, answered, its body read and finished. */
async function load(page: FakePage, req: RequestLike, body: Buffer, status = 200, contentType = "image/png"): Promise<void> {
  page.emit("request", req);
  page.emit("response", response(req, body, status, contentType));
  page.emit("requestfinished", req);
  await new Promise((resolve) => setImmediate(resolve));
}

async function setup(budget = new ByteBudget(1024 * 1024)) {
  const page = new FakePage();
  const recorder = new NetworkRecorder(page, budget);
  const frame = page.tester("a.test.ts");
  const token = await recorder.register(frame.url());
  if (token === null) throw new Error("the tester iframe wasn't found");
  return { page, recorder, frame, token };
}

const IMG = "http://cdn.test/a.png";
const body = (text: string) => Buffer.from(text);
const decoded = (resources: Record<string, { body: string }>, url: string) =>
  resources[url] ? Buffer.from(resources[url].body, "base64").toString() : undefined;

describe("NetworkRecorder recording", () => {
  /** Catches a capture's own re-request (settle probing a CSS background) replacing what the page drew. */
  it("keeps the first body a test received for a URL", async () => {
    const { page, recorder, frame, token } = await setup();
    await load(page, request(frame, IMG), body("drawn"));
    await load(page, request(frame, IMG), body("probe"));
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("drawn");
  });

  /** Catches every test in a file archiving the first test's bytes for a URL each test mocks differently. */
  it("lets a later test's response replace what an earlier test recorded", async () => {
    const { page, recorder, frame, token } = await setup();
    recorder.beginTest(token);
    await load(page, request(frame, IMG), body("first test"));
    recorder.beginTest(token);
    await load(page, request(frame, IMG), body("second test"));
    await load(page, request(frame, IMG), body("second test's probe"));
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("second test");
  });

  /** Catches a partial media response or an error page standing in for the whole asset. */
  it("records only full GET responses for visual assets", async () => {
    const { page, recorder, frame, token } = await setup();
    await load(page, request(frame, "http://cdn.test/v.mp4", { headers: { Range: "bytes=0-" } }), body("x"), 200, "video/mp4");
    await load(page, request(frame, "http://cdn.test/part.mp4"), body("x"), 206, "video/mp4");
    await load(page, request(frame, "http://cdn.test/gone.png"), body("x"), 404);
    await load(page, request(frame, "http://cdn.test/post.png", { method: "POST" }), body("x"));
    await load(page, request(frame, "http://cdn.test/data", { type: "fetch" }), body("{}"), 200, "application/json");
    await load(page, request(frame, "http://localhost:63315/src/app.ts"), body("js"), 200, "text/javascript");
    await load(page, request(frame, "http://cdn.test/empty.png"), Buffer.alloc(0));
    const { recorded } = await recorder.waitForIdle(token, 0, "t");
    expect(recorded).toEqual([]);
  });

  it("records an image the page fetched, by content type", async () => {
    const { page, recorder, frame, token } = await setup();
    await load(page, request(frame, IMG, { type: "fetch" }), body("png"));
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("png");
  });

  /** Catches a redirected avatar being downloaded again under the URL the DOM names, landing on another image. */
  it("records a redirected body under every URL of the chain", async () => {
    const { page, recorder, frame, token } = await setup();
    const first = request(frame, "http://avatars.test/42");
    const final = request(frame, "http://cdn.test/random-7.png", { from: first });
    await load(page, final, body("seven"));
    const resources = await recorder.recorded(token, ["http://avatars.test/42", "http://cdn.test/random-7.png"]);
    expect(decoded(resources, "http://avatars.test/42")).toBe("seven");
    expect(decoded(resources, "http://cdn.test/random-7.png")).toBe("seven");
  });

  it("ignores the orchestrator's own requests, and frames inside a tester iframe count as its document", async () => {
    const { page, recorder, frame, token } = await setup();
    await load(page, request(page.main, "http://cdn.test/orchestrator.png"), body("x"));
    await load(page, request(new FakeFrame("http://embed.test/", frame), "http://embed.test/inner.png"), body("inner"));
    expect((await recorder.waitForIdle(token, 0, "t")).recorded).toEqual(["http://embed.test/inner.png"]);
  });

  /** Catches a long run holding every body any test ever loaded. */
  it("stops recording past the byte budget, and frees a document's share when it detaches", async () => {
    const budget = new ByteBudget(10);
    const { page, recorder, frame, token } = await setup(budget);
    await load(page, request(frame, "http://cdn.test/1.png"), body("12345678"));
    await load(page, request(frame, "http://cdn.test/2.png"), body("12345678"));
    expect(Object.keys(await recorder.recorded(token, ["http://cdn.test/1.png", "http://cdn.test/2.png"]))).toEqual([
      "http://cdn.test/1.png",
    ]);
    page.detach(frame);
    expect(budget.take(10)).toBe(true);
  });

  /** Catches a finished request whose body Chromium is still handing over being downloaded again instead. */
  it("awaits the body of a finished request that is still being read", async () => {
    const { page, recorder, frame, token } = await setup();
    const req = request(frame, IMG);
    let deliver: (bytes: Buffer) => void = () => undefined;
    page.emit("request", req);
    page.emit("response", response(req, new Promise<Buffer>((resolve) => (deliver = resolve))));
    page.emit("requestfinished", req);
    setTimeout(() => deliver(body("late body")), 30);
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("late body");
  });

  /** Catches a request an earlier test made, answered after the next test began, taking that test's place. */
  it("files a response under the test that made the request", async () => {
    const { page, recorder, frame, token } = await setup();
    recorder.beginTest(token);
    const early = request(frame, IMG);
    page.emit("request", early);
    recorder.beginTest(token);
    page.emit("response", response(early, body("earlier test")));
    page.emit("requestfinished", early);
    await load(page, request(frame, IMG), body("this test"));
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("this test");
  });

  /** Catches an earlier test's image standing in for a later test's re-request that failed: the page shows
   *  it broken, the archive would show it working. */
  it("drops an earlier test's body when a later test asks again and gets no full response", async () => {
    const { page, recorder, frame, token } = await setup();
    recorder.beginTest(token);
    await load(page, request(frame, IMG), body("first test"));
    recorder.beginTest(token);
    await load(page, request(frame, IMG), body("not found"), 404);
    expect(await recorder.recorded(token, [IMG])).toEqual({});
  });

  /** Catches an earlier test's request, answered only after a later test asked again and failed, standing in
   *  for what the later test's page shows. */
  it("never records an earlier test's late response for a URL a later test asked for", async () => {
    const { page, recorder, frame, token } = await setup();
    recorder.beginTest(token);
    const early = request(frame, IMG);
    page.emit("request", early);
    recorder.beginTest(token);
    const again = request(frame, IMG);
    page.emit("request", again);
    page.emit("response", response(early, body("first test")));
    page.emit("requestfinished", early);
    page.emit("response", response(again, body("gone"), 404));
    page.emit("requestfinished", again);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await recorder.recorded(token, [IMG])).toEqual({});
  });

  /** Catches an earlier test's redirect, whose last hop fires after the next test began, taking the URL. */
  it("files a redirect hop under the test whose request started the chain", async () => {
    const { page, recorder, frame, token } = await setup();
    recorder.beginTest(token);
    const first = request(frame, "http://avatars.test/42");
    page.emit("request", first);
    recorder.beginTest(token);
    page.emit("request", request(frame, "http://avatars.test/42"));
    const hop = request(frame, "http://cdn.test/random-7.png", { from: first });
    page.emit("request", hop);
    page.emit("response", response(hop, body("earlier test")));
    page.emit("requestfinished", hop);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await recorder.recorded(token, ["http://avatars.test/42"])).toEqual({});
  });

  /** Catches replaced bodies never leaving the budget, so a long run stops recording altogether. */
  it("gives a replaced body's bytes back to the budget", async () => {
    const budget = new ByteBudget(10);
    const { page, recorder, frame, token } = await setup(budget);
    for (const test of ["1", "2", "3"]) {
      recorder.beginTest(token);
      await load(page, request(frame, IMG), body(`1234567${test}`));
    }
    expect(decoded(await recorder.recorded(token, [IMG]), IMG)).toBe("12345673");
  });

  /** Catches a body that stalls after its headers being handed to the capture's own fetches, which would
   *  then spend their whole retry budget on it where today's capture never sees it. */
  it("leaves out a URL whose body is still arriving", async () => {
    const { page, recorder, frame, token } = await setup();
    const req = request(frame, IMG);
    page.emit("request", req);
    page.emit("response", response(req, new Promise<Buffer>(() => undefined)));
    expect(await recorder.recorded(token, [IMG])).toEqual({});
    expect((await recorder.waitForIdle(token, 0, "t")).recorded).toEqual([]);
  });
});

describe("NetworkRecorder documents", () => {
  /** Catches a session's first file going unrecorded because its iframe's URL hadn't reached Node yet. */
  it("waits for a tester iframe whose URL hasn't caught up yet", async () => {
    const page = new FakePage();
    const recorder = new NetworkRecorder(page);
    const href = "http://localhost:63315/?sessionId=s&iframeId=late.ts";
    setTimeout(() => page.tester("late.ts"), 60);
    expect(await recorder.register(href)).not.toBeNull();
  });

  it("names a document by the page's own URL, and forgets it once the next file registers", async () => {
    const { page, recorder, frame, token } = await setup();
    expect(await recorder.register(frame.url())).toBe(token);
    expect(await recorder.register("http://localhost:63315/?sessionId=s&iframeId=missing.ts", 50)).toBeNull();
    await load(page, request(frame, IMG), body("a"));
    const next = page.tester("b.test.ts");
    const nextToken = await recorder.register(next.url());
    expect(nextToken).not.toBeNull();
    expect(await recorder.recorded(token, [IMG])).toEqual({});
  });

  it("forgets a document whose iframe detached", async () => {
    const { page, recorder, frame, token } = await setup();
    await load(page, request(frame, IMG), body("a"));
    page.detach(frame);
    expect(await recorder.waitForIdle(token, 1000, "t")).toEqual({ pending: [], recorded: [] });
  });
});

describe("NetworkRecorder.waitForIdle", () => {
  /** Catches the wait resolving at once when the page's request reaches Node just after the command. */
  it("waits a full quiet interval from the call, and for a request that starts within it", async () => {
    const { page, recorder, frame, token } = await setup();
    const started = performance.now();
    const req = request(frame, "http://api.test/user", { type: "fetch" });
    setTimeout(() => page.emit("request", req), 30);
    setTimeout(() => page.emit("requestfinished", req), 200);
    expect((await recorder.waitForIdle(token, 2000, "t", 100)).pending).toEqual([]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
  });

  it("doesn't count module JS, Vite's own paths or long-lived requests", async () => {
    const { page, recorder, frame, token } = await setup();
    page.emit("request", request(frame, "http://localhost:63315/src/lazy.ts", { type: "script" }));
    page.emit("request", request(frame, "http://localhost:63315/@vite/client", { type: "fetch" }));
    page.emit("request", request(frame, "http://localhost:63315/node_modules/.vite/deps/react.js", { type: "fetch" }));
    page.emit("request", request(frame, "http://api.test/events", { type: "eventsource" }));
    page.emit("request", request(frame, "http://cdn.test/clip.mp4", { type: "media" }));
    expect((await recorder.waitForIdle(token, 1000, "t", 20)).pending).toEqual([]);
  });

  /** Catches a hung request holding every later capture in its file, and also catches it switching off the
   *  wait for a later test's own request to the same URL. */
  it("gives up on a request at the timeout, then waits for it again only when a later test re-requests the URL", async () => {
    const { page, recorder, frame, token } = await setup();
    const hung = request(frame, "http://api.test/stream", { type: "fetch" });
    page.emit("request", hung);
    expect((await recorder.waitForIdle(token, 150, "first", 20)).pending).toEqual(["http://api.test/stream"]);
    expect((await recorder.waitForIdle(token, 150, "first", 20)).pending).toEqual([]);
    page.emit("request", request(frame, "http://api.test/stream", { type: "fetch" }));
    expect((await recorder.waitForIdle(token, 150, "first", 20)).pending).toEqual([]);
    expect((await recorder.waitForIdle(token, 150, "second", 20)).pending).toEqual(["http://api.test/stream"]);
    expect((await recorder.waitForIdle(token, 150, "second", 20)).pending).toEqual([]);
  });

  /** Catches back-to-back short requests holding every wait in a test to its timeout with no warning: nothing
   *  is ever in flight at the moment the wait gives up. */
  it("gives up on short requests that never leave a quiet gap", async () => {
    const { page, recorder, frame, token } = await setup();
    const poll = setInterval(() => {
      const req = request(frame, "http://api.test/poll", { type: "fetch" });
      page.emit("request", req);
      setTimeout(() => page.emit("requestfinished", req), 5);
    }, 30);
    try {
      expect((await recorder.waitForIdle(token, 300, "t", 100)).pending).toContain("http://api.test/poll");
      const started = performance.now();
      expect((await recorder.waitForIdle(token, 300, "t", 100)).pending).toEqual([]);
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      clearInterval(poll);
    }
  });

  /** Catches a request that merely finished just before the timeout being reported as still loading, and
   *  given up on for the rest of the test. */
  it("doesn't give up on a request that finished just before the timeout", async () => {
    const { page, recorder, frame, token } = await setup();
    const req = request(frame, "http://api.test/user", { type: "fetch" });
    page.emit("request", req);
    setTimeout(() => page.emit("requestfinished", req), 250);
    expect((await recorder.waitForIdle(token, 300, "t", 100)).pending).toEqual([]);
    page.emit("request", request(frame, "http://api.test/user", { type: "fetch" }));
    expect((await recorder.waitForIdle(token, 150, "t", 20)).pending).toEqual(["http://api.test/user"]);
  });

  it("only reports when the timeout is 0", async () => {
    const { page, recorder, frame, token } = await setup();
    page.emit("request", request(frame, "http://api.test/slow", { type: "fetch" }));
    expect(await recorder.waitForIdle(token, 0, "t")).toEqual({ pending: [], recorded: [] });
  });
});

describe("recorderFor", () => {
  it("records only Playwright's Chromium", () => {
    const page = new FakePage();
    const ctx = (name: string) => ({ page, project: { config: { browser: { name } } } });
    expect(recorderFor(ctx("firefox"))).toBeNull();
    expect(recorderFor({ project: { config: { browser: { name: "chromium" } } } })).toBeNull();
    const recorder = recorderFor(ctx("chromium"));
    expect(recorder).toBeInstanceOf(NetworkRecorder);
    expect(recorderFor(ctx("chromium"))).toBe(recorder);
  });
});
