/** A URL pattern for {@link Page.route}: a Playwright URL glob, or a RegExp tested against the full URL. */
export type RoutePattern = string | RegExp;

/** The request a route handler is answering. */
export interface RouteRequest {
  url(): string;
  method(): string;
  /** Header names lower-cased. */
  headers(): Record<string, string>;
}

/** What {@link Route.fulfill} answers with: `json` (sent as `application/json`) or `body`. */
export interface FulfillOptions {
  status?: number;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}

/** One intercepted request, handed to a route handler. A handler either answers it with `fulfill()` or
 *  passes it on with `fallback()` (to the next matching handler, then the network). */
export interface Route {
  request(): RouteRequest;
  fulfill(options: FulfillOptions): void;
  fallback(): void;
}

export type RouteHandler = (route: Route) => unknown;

/** A request as Chrome's request interception reports it. */
export interface InterceptedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** An answer in the shape CDP `Fetch.fulfillRequest` takes. */
export interface EncodedResponse {
  responseCode: number;
  responseHeaders: { name: string; value: string }[];
  /** base64 */
  body: string;
}

export type RouteDecision =
  | { kind: "fulfill"; response: EncodedResponse }
  | { kind: "continue" }
  | { kind: "error"; message: string };

const ESCAPED = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);

/** Playwright's URL glob as a RegExp source: `**` crosses `/`, `*` doesn't, `{a,b}` alternates, and every
 *  other character (`?` included) is literal. */
export function globToRegExpSource(glob: string): string {
  const tokens = ["^"];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i] ?? "";
    if (c === "\\" && i + 1 < glob.length) {
      const next = glob[++i] ?? "";
      tokens.push(ESCAPED.has(next) ? `\\${next}` : next);
      continue;
    }
    if (c === "*") {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === "*") {
        stars++;
        i++;
      }
      if (stars > 1) {
        if (glob[i + 1] === "/") {
          tokens.push(before === "/" ? "((.+/)|)" : "(.*/)");
          ++i;
        } else tokens.push("(.*)");
      } else tokens.push("([^/]*)");
      continue;
    }
    if (c === "{") {
      inGroup = true;
      tokens.push("(");
    } else if (c === "}") {
      inGroup = false;
      tokens.push(")");
    } else if (c === ",") tokens.push(inGroup ? "|" : "\\,");
    else tokens.push(ESCAPED.has(c) ? `\\${c}` : c);
  }
  tokens.push("$");
  return tokens.join("");
}

/** A string pattern not starting with `*` or a scheme is relative to the base URL. */
export function resolvePattern(pattern: string, baseUrl: string | undefined): string {
  if (pattern.startsWith("*") || /^[a-z][a-z\d+.-]*:/i.test(pattern)) return pattern;
  if (baseUrl === undefined) {
    throw new Error(`@uiverify/bun: the route pattern "${pattern}" is relative, but this suite has no base URL.`);
  }
  // The glob's `*`, `{`, `}` and `,` stand in as placeholders while the URL resolves `..` and `.`, which would
  // otherwise percent-encode them.
  const glob = ["*", "{", "}", ","];
  let swapped = pattern;
  glob.forEach((char, i) => (swapped = swapped.replaceAll(char, `uiverifyglob${i}x`)));
  let resolved = new URL(swapped, baseUrl).href;
  glob.forEach((char, i) => (resolved = resolved.replaceAll(`uiverifyglob${i}x`, char)));
  return resolved;
}

export function urlMatcher(pattern: RoutePattern, baseUrl: string | undefined): (url: string) => boolean {
  // A copy without `g`/`y`, whose `lastIndex` would make `test()` alternate between matching and not.
  const regexp =
    pattern instanceof RegExp
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
      : new RegExp(globToRegExpSource(resolvePattern(pattern, baseUrl)));
  return (url) => regexp.test(url);
}

function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** The CORS headers a routed answer needs when the page asked cross-origin: Chrome rejects a cross-origin
 *  response without them, and rejects one that carries `access-control-allow-origin` twice, so a handler's
 *  own is kept. */
function corsHeaders(request: InterceptedRequest, handlerHeaders: Record<string, string>): Record<string, string> {
  const origin = lowerCased(request.headers).origin;
  if (!origin || origin === "null" || origin === new URL(request.url).origin) return {};
  if (Object.keys(handlerHeaders).some((name) => name.toLowerCase() === "access-control-allow-origin")) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" };
}

export function encodeFulfill(options: FulfillOptions, request: InterceptedRequest): EncodedResponse {
  const status = options.status ?? 200;
  const isJson = options.json !== undefined;
  const contentType = options.contentType ?? (isJson ? "application/json" : "text/plain");
  const handlerHeaders = options.headers ?? {};
  // A handler's own header wins, in whatever case it's spelled: sent twice, Chrome joins the values.
  const own = new Set(Object.keys(handlerHeaders).map((name) => name.toLowerCase()));
  const defaults = own.has("content-type") ? {} : { "content-type": contentType };
  const headers = { ...defaults, ...handlerHeaders, ...corsHeaders(request, handlerHeaders) };
  const body = isJson ? JSON.stringify(options.json) : (options.body ?? "");
  return {
    responseCode: status,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: Buffer.from(body).toString("base64"),
  };
}

/** The answer to a CORS preflight for a routed URL: the routed answer is what the page will read, so the
 *  preflight must let the real request through. */
function preflightAnswer(request: InterceptedRequest): EncodedResponse {
  const headers = lowerCased(request.headers);
  const allowed: Record<string, string> = {
    "access-control-allow-origin": headers.origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": headers["access-control-request-method"] ?? "GET",
  };
  const requestedHeaders = headers["access-control-request-headers"];
  if (requestedHeaders) allowed["access-control-allow-headers"] = requestedHeaders;
  return {
    responseCode: 204,
    responseHeaders: Object.entries(allowed).map(([name, value]) => ({ name, value })),
    body: "",
  };
}

interface Registered {
  pattern: RoutePattern;
  matches: (url: string) => boolean;
  handler: RouteHandler;
}

/** One test's routes, latest-registered first. */
export class Router {
  #routes: Registered[] = [];

  add(pattern: RoutePattern, handler: RouteHandler, baseUrl: string | undefined): void {
    this.#routes.unshift({ pattern, matches: urlMatcher(pattern, baseUrl), handler });
  }

  clear(): void {
    this.#routes = [];
  }

  async decide(request: InterceptedRequest): Promise<RouteDecision> {
    const matching = this.#routes.filter((route) => route.matches(request.url));
    if (!matching.length) return { kind: "continue" };
    const headers = lowerCased(request.headers);
    if (request.method === "OPTIONS" && headers["access-control-request-method"]) {
      return { kind: "fulfill", response: preflightAnswer(request) };
    }
    for (const { pattern, handler } of matching) {
      let outcome: { fulfill: FulfillOptions } | "fallback" | undefined;
      const route: Route = {
        request: () => ({ url: () => request.url, method: () => request.method, headers: () => ({ ...headers }) }),
        fulfill: (options) => void (outcome ??= { fulfill: options }),
        fallback: () => void (outcome ??= "fallback"),
      };
      const where = `${request.method} ${request.url} (route ${String(pattern)})`;
      try {
        await handler(route);
      } catch (error) {
        return { kind: "error", message: `${where}: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (outcome === "fallback") continue;
      if (outcome === undefined) {
        return { kind: "error", message: `${where}: the handler neither called route.fulfill() nor route.fallback()` };
      }
      return { kind: "fulfill", response: encodeFulfill(outcome.fulfill, request) };
    }
    return { kind: "continue" };
  }
}
