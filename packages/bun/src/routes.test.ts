import { describe, expect, test } from "bun:test";
import { encodeFulfill, globToRegExpSource, type InterceptedRequest, resolvePattern, Router, urlMatcher } from "./routes";

const matches = (glob: string, url: string) => new RegExp(globToRegExpSource(glob)).test(url);

describe("URL globs (Playwright's semantics)", () => {
  /** Catches a glob that differs from Playwright's, which every Playwright-shaped route in a test assumes. */
  test.each([
    ["https://localhost:8080/foo.js", "**/*.js", true],
    ["https://localhost:8080/foo.js", "**/*.css", false],
    ["https://localhost:8080/foo.js", "*.js", false],
    ["https://localhost:8080/a/b/c.js", "https://localhost:8080/**/c.js", true],
    ["https://localhost:8080/c.js", "https://localhost:8080/**/c.js", true],
    ["https://localhost:8080/a/c.js", "https://localhost:8080/*/c.js", true],
    ["https://localhost:8080/a/b/c.js", "https://localhost:8080/*/c.js", false],
    ["https://localhost:8080/foo.js", "**/{foo,bar}.js", true],
    ["https://localhost:8080/bar.js", "**/{foo,bar}.js", true],
    ["https://localhost:8080/baz.js", "**/{foo,bar}.js", false],
    ["https://localhost:8080/foo?x=1", "**/foo?x=1", true],
    ["https://localhost:8080/fooax=1", "**/foo?x=1", false],
    ["https://localhost:8080/api/items?page=2", "**/api/items", false],
    ["https://localhost:8080/api/items?page=2", "**/api/items?*", true],
    ["https://localhost:8080/a.b", "**/a.b", true],
    ["https://localhost:8080/axb", "**/a.b", false],
  ])("%s against %s: %p", (url, glob, expected) => {
    expect(matches(glob, url)).toBe(expected);
  });

  /** Catches a relative pattern matched as written, which would never match the page's absolute URLs. */
  test("resolves a relative pattern against the base URL, and leaves * and scheme patterns alone", () => {
    expect(resolvePattern("/api/*", "http://127.0.0.1:3000/app/")).toBe("http://127.0.0.1:3000/api/*");
    expect(resolvePattern("api/*", "http://127.0.0.1:3000/app/")).toBe("http://127.0.0.1:3000/app/api/*");
    expect(resolvePattern("../api/*", "http://127.0.0.1:3000/app/")).toBe("http://127.0.0.1:3000/api/*");
    expect(resolvePattern("api/{items,users}", "http://127.0.0.1:3000/app/index.html")).toBe(
      "http://127.0.0.1:3000/app/api/{items,users}",
    );
    expect(resolvePattern("**/api", undefined)).toBe("**/api");
    expect(resolvePattern("https://cdn.test/*", undefined)).toBe("https://cdn.test/*");
    expect(() => resolvePattern("/api", undefined)).toThrow("has no base URL");
  });

  /** Catches a `g` RegExp's lastIndex making every other request miss its route. */
  test("a global RegExp matches every time", () => {
    const match = urlMatcher(/\/api\//g, undefined);
    expect([match("http://x/api/1"), match("http://x/api/2"), match("http://x/api/3")]).toEqual([true, true, true]);
  });
});

const request = (url: string, headers: Record<string, string> = {}, method = "GET"): InterceptedRequest => ({
  url,
  method,
  headers,
});

const decode = (body: string) => Buffer.from(body, "base64").toString();

describe("Router", () => {
  /** Catches the precedence flipping: a test's later, more specific route must win over a suite-wide one. */
  test("the latest-registered match answers; fallback passes on to the next, then the network", async () => {
    const router = new Router();
    router.add("**/api/*", (route) => route.fulfill({ json: "suite" }), undefined);
    router.add("**/api/items", (route) => route.fulfill({ json: "test" }), undefined);
    router.add("**/api/other", (route) => route.fallback(), undefined);
    const items = await router.decide(request("http://x/api/items"));
    expect(items.kind === "fulfill" && decode(items.response.body)).toBe('"test"');
    const other = await router.decide(request("http://x/api/other"));
    expect(other.kind === "fulfill" && decode(other.response.body)).toBe('"suite"');
    expect((await router.decide(request("http://x/page"))).kind).toBe("continue");
    router.clear();
    expect((await router.decide(request("http://x/api/items"))).kind).toBe("continue");
  });

  /** Catches a handler that forgot to answer hanging the request silently instead of failing the test. */
  test("a handler that neither fulfills nor falls back, or throws, is a route error naming the URL and pattern", async () => {
    const router = new Router();
    router.add("**/silent", () => {}, undefined);
    router.add("**/throws", () => {
      throw new Error("no recording");
    }, undefined);
    const silent = await router.decide(request("http://x/silent"));
    expect(silent.kind === "error" && silent.message).toContain("GET http://x/silent (route **/silent)");
    const throws = await router.decide(request("http://x/throws"));
    expect(throws.kind === "error" && throws.message).toContain("no recording");
  });

  /** Catches a routed cross-origin request failing CORS in the browser: its preflight must be answered. */
  test("answers a routed URL's CORS preflight", async () => {
    const router = new Router();
    router.add("https://api.test/**", (route) => route.fulfill({ json: {} }), undefined);
    const decision = await router.decide(
      request(
        "https://api.test/items",
        { Origin: "http://app.test", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "x-token" },
        "OPTIONS",
      ),
    );
    expect(decision.kind === "fulfill" && decision.response.responseCode).toBe(204);
    const headers = decision.kind === "fulfill" ? Object.fromEntries(decision.response.responseHeaders.map((h) => [h.name, h.value])) : {};
    expect(headers).toEqual({
      "access-control-allow-origin": "http://app.test",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "PUT",
      "access-control-allow-headers": "x-token",
    });
  });
});

describe("encodeFulfill", () => {
  const headersOf = (response: ReturnType<typeof encodeFulfill>) =>
    Object.fromEntries(response.responseHeaders.map((header) => [header.name, header.value]));

  test("json is sent as application/json, body as text/plain unless told", () => {
    const json = encodeFulfill({ json: { a: 1 }, status: 201 }, request("http://x/a"));
    expect([json.responseCode, headersOf(json)["content-type"], decode(json.body)]).toEqual([201, "application/json", '{"a":1}']);
    const bytes = encodeFulfill({ body: new Uint8Array([104, 105]), contentType: "font/woff2" }, request("http://x/f"));
    expect([headersOf(bytes)["content-type"], decode(bytes.body)]).toEqual(["font/woff2", "hi"]);
    expect(headersOf(encodeFulfill({ body: "x" }, request("http://x/t")))["content-type"]).toBe("text/plain");
  });

  /** Catches a duplicated Access-Control-Allow-Origin, which makes Chrome fail the fetch outright. */
  test("adds CORS headers to a cross-origin answer only when the handler set none", () => {
    const crossOrigin = request("https://fonts.test/a.woff2", { Origin: "http://app.test" });
    expect(headersOf(encodeFulfill({ body: "" }, crossOrigin))).toMatchObject({
      "access-control-allow-origin": "http://app.test",
      "access-control-allow-credentials": "true",
    });
    const own = headersOf(encodeFulfill({ body: "", headers: { "Access-Control-Allow-Origin": "*" } }, crossOrigin));
    expect(own["Access-Control-Allow-Origin"]).toBe("*");
    expect(own["access-control-allow-origin"]).toBeUndefined();
    const sameOrigin = request("http://app.test/a", { Origin: "http://app.test" });
    expect(headersOf(encodeFulfill({ body: "" }, sameOrigin))["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("encodeFulfill header case", () => {
  /** Catches a Playwright-style `Content-Type` sent next to the default: Chrome joins the two, and the archive
   *  step then drops the asset as not visual. */
  test("a handler's Content-Type replaces the default in any case", () => {
    const response = encodeFulfill({ body: "x", headers: { "Content-Type": "image/png" } }, request("http://x/a.png"));
    const contentTypes = response.responseHeaders.filter((header) => header.name.toLowerCase() === "content-type");
    expect(contentTypes).toEqual([{ name: "Content-Type", value: "image/png" }]);
  });
});
