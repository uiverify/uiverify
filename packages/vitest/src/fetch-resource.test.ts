import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchResource } from "./fetch-resource";

let server: http.Server;
let base: string;
let flakyHits = 0;
let limitedHits = 0;
let downHits = 0;
let hugeChunksWritten = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/icon.png") return void res.writeHead(200, { "content-type": "image/png" }).end("png");
    if (req.url === "/limited.png") {
      limitedHits++;
      if (limitedHits < 2) return void res.writeHead(429).end();
      return void res.writeHead(200, { "content-type": "image/png" }).end("png");
    }
    if (req.url === "/flaky.woff2") {
      flakyHits++;
      if (flakyHits < 3) return void res.writeHead(503).end();
      return void res.writeHead(200, { "content-type": "font/woff2" }).end("font");
    }
    if (req.url === "/meta") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (req.url === "/huge.png") {
      // No Content-Length: 1 MB chunks, each written once the last one drained, until the client hangs up.
      res.writeHead(200, { "content-type": "image/png" });
      const chunk = Buffer.alloc(1024 * 1024);
      const writeNext = () => {
        if (res.destroyed || hugeChunksWritten >= 100) return void res.end();
        hugeChunksWritten++;
        if (res.write(chunk)) setImmediate(writeNext);
        else res.once("drain", writeNext);
      };
      res.on("close", () => res.removeAllListeners("drain"));
      return void writeNext();
    }
    if (req.url === "/stalled.png") return void res.writeHead(200, { "content-type": "image/png" });
    if (req.url === "/down.png") downHits++;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("fetchResource", () => {
  it("returns the bytes, type and status", async () => {
    expect(await fetchResource(`${base}/icon.png`, 1)).toEqual({
      resource: { contentType: "image/png", status: 200, body: Buffer.from("png").toString("base64") },
    });
  });

  /** Catches a font server's transient error dropping the font from the archive on the first failure. */
  it("retries a 5xx until it succeeds", async () => {
    const fetched = await fetchResource(`${base}/flaky.woff2`, 1);
    expect(flakyHits).toBe(3);
    expect(fetched).toEqual({
      resource: { contentType: "font/woff2", status: 200, body: Buffer.from("font").toString("base64") },
    });
  });

  it("retries a 429", async () => {
    expect(await fetchResource(`${base}/limited.png`, 1)).toEqual({
      resource: { contentType: "image/png", status: 200, body: Buffer.from("png").toString("base64") },
    });
    expect(limitedHits).toBe(2);
  });

  it("gives up after three attempts with the last error", async () => {
    expect(await fetchResource(`${base}/down.png`, 1)).toEqual({ error: "HTTP 500" });
    expect(downHits).toBe(3);
  });

  /** Catches the command reading any response for page scripts (a JSON API, cloud metadata) from Node's
   *  side of the network. */
  it("returns only images, fonts and stylesheets", async () => {
    expect(await fetchResource(`${base}/meta`, 1)).toEqual({ error: "not an image, font or stylesheet" });
  });

  /** Catches the whole body being buffered before the size check, which a server streaming without a
   *  Content-Length could use to exhaust memory. */
  it("stops reading a body without Content-Length once it passes the size cap", async () => {
    expect(await fetchResource(`${base}/huge.png`, 1)).toEqual({ error: "larger than the 10 MB per-resource limit" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hugeChunksWritten).toBeLessThan(40);
  });

  /** Catches a server that never finishes its response holding the capture, and the test, indefinitely. */
  it("gives up on a response that stalls", async () => {
    const fetched = await fetchResource(`${base}/stalled.png`, 1, 50);
    expect("error" in fetched && fetched.error).toMatch(/abort|timeout/i);
  });

  it("only fetches http(s)", async () => {
    expect(await fetchResource("file:///etc/passwd")).toEqual({ error: "not an http(s) URL" });
  });
});
