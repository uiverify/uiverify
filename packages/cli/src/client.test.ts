import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Credential, keyCredential } from "./auth";
import { httpIngestClient } from "./client";
import { NOT_SIGNED_IN } from "./login";
import { HttpStatusError } from "./retry";

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
    const client = httpIngestClient("http://cp", keyCredential("key"));
    const p = client.register(body);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({
      outcome: "upload",
      buildId: "b1",
      uploadUrl: "http://s3/b1",
      baselineCommits: [],
      deltaBases: [],
      warnings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a skipped outcome when the server skips the rebuild of an already-passed commit", async () => {
    const fetchMock = stubFetch([ok({ outcome: "skipped", buildId: "prior1", buildNumber: 42 })]);
    const client = httpIngestClient("http://cp", keyCredential("key"));
    expect(await client.register(body)).toEqual({ outcome: "skipped", buildId: "prior1", buildNumber: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on a transport error (network / attempt timeout)", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch([new Error("network down"), ok({ buildId: "b2", uploadUrl: "u" })]);
    const client = httpIngestClient("http://cp", keyCredential("key"));
    const p = client.register(body);
    await vi.runAllTimersAsync();
    expect((await p).buildId).toBe("b2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx — surfaces it immediately", async () => {
    const fetchMock = stubFetch([fail(422)]);
    const client = httpIngestClient("http://cp", keyCredential("key"));
    await expect(client.register(body)).rejects.toThrow("422");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("httpIngestClient open review comments", () => {
  afterEach(() => vi.unstubAllGlobals());

  const open = {
    branch: "feat/card",
    projectId: "p1",
    total: 1,
    textShown: true,
    notes: [
      {
        storyId: "card--default",
        title: "Card",
        name: "Default",
        viewport: "desktop",
        browser: "chromium",
        buildNumber: 2,
        reviewUrl: "https://uiverify.ai/builds/b2?diff=d1",
        author: "Igor",
        body: "remove drop shadow",
        replies: 1,
      },
    ],
  };

  it("parses them from an upload response", async () => {
    stubFetch([ok({ buildId: "b1", uploadUrl: "u", openComments: open })]);
    const res = await httpIngestClient("http://cp", keyCredential("key")).register(body);
    expect(res.outcome === "upload" && res.openComments).toEqual(open);
  });

  it("parses them from a skipped response", async () => {
    stubFetch([ok({ outcome: "skipped", buildId: "prior1", buildNumber: 42, openComments: open })]);
    const res = await httpIngestClient("http://cp", keyCredential("key")).register(body);
    expect(res.outcome === "skipped" && res.openComments).toEqual(open);
  });

  it("accepts a withheld body", async () => {
    const withheld = { ...open, textShown: false, notes: [{ ...open.notes[0], body: null }] };
    stubFetch([ok({ buildId: "b1", uploadUrl: "u", openComments: withheld })]);
    const res = await httpIngestClient("http://cp", keyCredential("key")).register(body);
    expect(res.outcome === "upload" && res.openComments?.notes[0]?.body).toBeNull();
  });

  /** Would catch a register that fails, or a null that survives into the result, when a server omits the hint,
   *  sends null, or sends a shape this client doesn't know. */
  it.each([
    ["absent", undefined],
    ["null", null],
    ["a shape it can't read", { branch: 7 }],
  ])("treats %s as no notes and still registers", async (_label, value) => {
    stubFetch([ok({ buildId: "b1", uploadUrl: "u", openComments: value })]);
    const res = await httpIngestClient("http://cp", keyCredential("key")).register(body);
    expect(res.outcome).toBe("upload");
    expect(res.outcome === "upload" && res.openComments).toBeUndefined();
  });

  it("sends ci in the register body", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" })]);
    await httpIngestClient("http://cp", keyCredential("key")).register({ ...body, ci: true });
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ ci: true });
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
    await expect(httpIngestClient("http://cp", keyCredential("key")).register(body)).rejects.toThrow(new RegExp(`^${escapeRe(msg)}$`));
  });

  it("falls back to the raw status line for a non-JSON error body", async () => {
    stubFetch([fail(400)]); // body is "boom", not JSON
    await expect(httpIngestClient("http://cp", keyCredential("key")).register(body)).rejects.toThrow("400: boom");
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
    await httpIngestClient("http://cp", keyCredential("key")).register(body);
    expect(headersOf(fetchMock.mock.calls[0])["x-uiverify-cli-version"]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("sends the SDK identity as headers (not in the JSON body) when the bundle reported one", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" })]);
    await httpIngestClient("http://cp", keyCredential("key")).register({
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
    await httpIngestClient("http://cp", keyCredential("key")).register(body);
    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers["x-uiverify-sdk-name"]).toBeUndefined();
    expect(headers["x-uiverify-sdk-version"]).toBeUndefined();
  });
});

describe("httpIngestClient getStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A null review-comment tally must not fail the parse: that error is operational, so under the default
   *  strict mode it would fail the consumer's CI on a build that finished fine. */
  it("accepts a null or missing comments tally in the terminal summary", async () => {
    const summary = (comments: unknown) => ({
      aiReview: null,
      comments,
      changedStories: [
        {
          storyId: "a",
          title: "A",
          name: "X",
          decision: null,
          aiVerdict: null,
          aiConfidence: null,
          aiSummary: null,
          comments,
        },
      ],
      changedStoriesTruncated: null,
      failedStories: [],
    });
    stubFetch([
      ok({ status: "changed", summary: summary(null) }),
      ok({ status: "changed", summary: summary(undefined) }),
    ]);
    const client = httpIngestClient("http://cp", keyCredential("key"));
    await expect(client.getStatus("b1")).resolves.toMatchObject({ status: "changed" });
    await expect(client.getStatus("b1")).resolves.toMatchObject({ status: "changed" });
  });

  /** A `blocked` field this client can't read must not fail the parse (an operational error, so strict mode
   *  would fail the consumer's CI); it degrades to null and the CLI prints its generic blocked line. */
  it("reads a blocked build's message, and reads an unexpected blocked shape as null", async () => {
    stubFetch([
      ok({ status: "blocked", blocked: { reason: "allowance", message: "Paused.\nPlease tell the user." } }),
      ok({ status: "blocked", blocked: { reason: "allowance" } }),
      ok({ status: "blocked" }),
    ]);
    const client = httpIngestClient("http://cp", keyCredential("key"));
    await expect(client.getStatus("b1")).resolves.toMatchObject({ blocked: { message: "Paused.\nPlease tell the user." } });
    await expect(client.getStatus("b1")).resolves.toMatchObject({ status: "blocked", blocked: null });
    await expect(client.getStatus("b1")).resolves.toMatchObject({ status: "blocked" });
  });
});

/** What a failure report may repeat from an HTTP error: only UI Verify's own `{ "error" }` text. */
describe("httpIngestClient error text for failure reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const respond = (status: number, text: string): Response => new Response(text, { status });

  it("keeps our own error envelope from the control plane", async () => {
    stubFetch([respond(409, JSON.stringify({ error: "This is a screenshot project" }))]);
    const err: unknown = await httpIngestClient("http://cp", keyCredential("k")).register(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err).toMatchObject({ status: 409, label: "POST /api/ingest/build", serverError: "This is a screenshot project" });
  });

  it("drops any other body, such as a proxy's block page", async () => {
    stubFetch([respond(400, "<html>Blocked for jane@acme.com</html>")]);
    const err: unknown = await httpIngestClient("http://cp", keyCredential("k")).register(body).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, serverError: null });
  });

  /** Catches a JSON body from the storage host, or a proxy in front of it, passing as UI Verify's own text. */
  it("never takes the storage host's JSON as our error text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-put-"));
    const tgz = path.join(dir, "b.tgz");
    fs.writeFileSync(tgz, "x");
    stubFetch([respond(403, JSON.stringify({ error: "Blocked by proxy for jane@acme.com" }))]);
    const err: unknown = await httpIngestClient("http://cp", keyCredential("k")).upload("http://s3/b", tgz).catch((e: unknown) => e);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(err).toMatchObject({ status: 403, label: "bundle upload", serverError: null });
  });
});

describe("httpIngestClient credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  const authOf = (call: unknown[]): string | null => new Headers((call[1] as RequestInit).headers).get("authorization");
  const failJson = (status: number, body: Record<string, unknown>): Response => new Response(JSON.stringify(body), { status });

  /** A login stand-in: hands out `tokens` in turn from `token()`, and `renewed` from `renew()`. */
  function fakeLogin(tokens: string[], renewed = "renewed-token") {
    const calls = { token: 0, renew: [] as string[] };
    const credential: Credential = {
      signedIn: true,
      token: async () => tokens[Math.min(calls.token++, tokens.length - 1)] ?? "",
      renew: async (rejected) => {
        calls.renew.push(rejected);
        return renewed;
      },
    };
    return { credential, calls };
  }

  /** Would catch: a token read once at start and sent on every poll after another process renewed it. */
  it("asks the credential for a token on every request", async () => {
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u" }), ok({}), ok({ status: "running" }), ok({ status: "passed" })]);
    const { credential, calls } = fakeLogin(["t1", "t2", "t3", "t4"]);
    const client = httpIngestClient("http://cp", credential);
    await client.register(body);
    await client.markUploaded("b1", []);
    await client.getStatus("b1");
    await client.getStatus("b1");
    expect(calls.token).toBe(4);
    expect(fetchMock.mock.calls.map(authOf)).toEqual(["Bearer t1", "Bearer t2", "Bearer t3", "Bearer t4"]);
  });

  /** Would catch: a login 401 (clock behind the server) failing the upload instead of renewing once. */
  it("renews a login once on a 401 and retries with the new token", async () => {
    const fetchMock = stubFetch([failJson(401, { error: "invalid token" }), ok({ status: "passed" })]);
    const { credential, calls } = fakeLogin(["stale-token"]);
    expect((await httpIngestClient("http://cp", credential).getStatus("b1")).status).toBe("passed");
    expect(calls.renew).toEqual(["stale-token"]);
    expect(fetchMock.mock.calls.map(authOf)).toEqual(["Bearer stale-token", "Bearer renewed-token"]);
  });

  it("says to sign in again when the renewed login is refused too", async () => {
    const fetchMock = stubFetch([failJson(401, { error: "invalid token" }), failJson(401, { error: "invalid token" })]);
    const { credential, calls } = fakeLogin(["stale-token"]);
    await expect(httpIngestClient("http://cp", credential).register(body)).rejects.toThrow(NOT_SIGNED_IN);
    expect(calls.renew).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never renews on a 403, and never for a key", async () => {
    stubFetch([failJson(403, { error: "forbidden" })]);
    const { credential, calls } = fakeLogin(["t"]);
    await expect(httpIngestClient("http://cp", credential).register(body)).rejects.toThrow("forbidden");
    expect(calls.renew).toEqual([]);

    const keyFetch = stubFetch([failJson(401, { error: "invalid or missing api key" })]);
    await expect(httpIngestClient("http://cp", keyCredential("uv_proj_key123456")).register(body)).rejects.toThrow("invalid or missing api key");
    expect(keyFetch).toHaveBeenCalledTimes(1);
  });

  /** Would catch: a register refusal's candidates and its `--project` hint lost behind a status line. */
  it("surfaces a project refusal's message verbatim, candidates and hint included", async () => {
    const error =
      "Several UI Verify projects match acme/web (Storybook): acme/web, acme/web-docs. Pass --project <team>/<slug> to choose one.";
    stubFetch([failJson(409, { error, code: "project_ambiguous", projects: [{ team: "acme", slug: "web", type: "storybook" }] })]);
    const { credential } = fakeLogin(["t"]);
    await expect(httpIngestClient("http://cp", credential).register(body)).rejects.toThrow(new RegExp(`^${escapeRe(error)}$`));
  });

  it("sends --project, the capture shape and the upstream repo, and reads back the project", async () => {
    const project = { id: "proj_1", team: "acme", slug: "web", created: false };
    const fetchMock = stubFetch([ok({ buildId: "b1", uploadUrl: "u", project })]);
    const reg = await httpIngestClient("http://cp", keyCredential("key")).register({
      ...body,
      project: "acme/web",
      captureShape: "storybook",
      upstreamRepoFullName: "acme/web",
    });
    expect(reg.outcome === "upload" && reg.project).toEqual(project);
    const sent: unknown = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent).toMatchObject({ project: "acme/web", captureShape: "storybook", upstreamRepoFullName: "acme/web" });
  });
});
