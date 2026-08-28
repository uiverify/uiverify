import { afterEach, describe, expect, it, vi } from "vitest";
import { httpIngestClient } from "./client";

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number): Response => new Response("boom", { status });

function stubFetch(responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no more responses");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const body = { commitSha: "c1", branch: "main", prNumber: null, parentShas: [] };

describe("httpIngestClient retries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries register on a 5xx and returns once a call succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch([fail(503), ok({ buildId: "b1", uploadUrl: "http://s3/b1" })]);
    const client = httpIngestClient("http://cp", "key");
    const p = client.register(body);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ buildId: "b1", uploadUrl: "http://s3/b1", baselineCommits: [], warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on a transport error (network / attempt timeout)", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch([new Error("network down"), ok({ buildId: "b2", uploadUrl: "u" })]);
    const client = httpIngestClient("http://cp", "key");
    const p = client.register(body);
    await vi.runAllTimersAsync();
    expect((await p).buildId).toBe("b2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx — surfaces it immediately", async () => {
    const fetchMock = stubFetch([fail(422)]);
    const client = httpIngestClient("http://cp", "key");
    await expect(client.register(body)).rejects.toThrow("422");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("httpIngestClient surfaces the server error message", () => {
  afterEach(() => vi.unstubAllGlobals());

  const failJson = (status: number, error: string): Response =>
    new Response(JSON.stringify({ error }), { status });

  // A wrong project type / SDK is a 409 whose body is the actionable message. It must reach the user
  // verbatim (the CLI prints the thrown error), NOT buried under a `POST /api/ingest/build -> 409: {...}`
  // prefix. Reverting the `httpError` helper (back to the raw status-line throw) turns this red.
  it("throws the control plane's { error } body verbatim on a 409, with no status-line prefix", async () => {
    const msg =
      "This is a screenshot project, but you uploaded with the @uiverify/playwright SDK. Create a playwright project, or change this project's type.";
    stubFetch([failJson(409, msg)]);
    // Exactly the server message - no `POST ... -> 409` wrapper.
    await expect(httpIngestClient("http://cp", "key").register(body)).rejects.toThrow(new RegExp(`^${escapeRe(msg)}$`));
  });

  it("falls back to the raw status line for a non-JSON error body", async () => {
    stubFetch([fail(400)]); // body is "boom", not JSON
    await expect(httpIngestClient("http://cp", "key").register(body)).rejects.toThrow("400: boom");
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("httpIngestClient version reporting", () => {
  afterEach(() => vi.unstubAllGlobals());

  function headersOf(call: unknown[]): Record<string, string> {
    const init = call[1] as { headers: Record<string, string> };
    return init.headers;
  }

  it("sends x-uiverify-cli-version on register", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" })]);
    await httpIngestClient("http://cp", "key").register(body);
    expect(headersOf(fetchMock.mock.calls[0])["x-uiverify-cli-version"]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("sends the SDK identity as headers (not in the JSON body) when the bundle reported one", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" })]);
    await httpIngestClient("http://cp", "key").register({
      ...body,
      sdkName: "@uiverify/playwright",
      sdkVersion: "1.2.3",
    });
    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers["x-uiverify-sdk-name"]).toBe("@uiverify/playwright");
    expect(headers["x-uiverify-sdk-version"]).toBe("1.2.3");
    // The SDK identity must NOT leak into the JSON body - the body stays the build-input contract.
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sent.sdkName).toBeUndefined();
    expect(sent.sdkVersion).toBeUndefined();
    expect(sent.commitSha).toBe("c1");
  });

  it("omits the SDK headers for a Storybook upload (no producer)", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" })]);
    await httpIngestClient("http://cp", "key").register(body);
    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers["x-uiverify-sdk-name"]).toBeUndefined();
    expect(headers["x-uiverify-sdk-version"]).toBeUndefined();
  });
});
