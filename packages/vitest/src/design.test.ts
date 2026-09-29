import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designDataUri } from "./design";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/home.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    if (req.url === "/home.jpg") return void res.writeHead(200).end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("designDataUri", () => {
  it("fetches an import URL, root-relative or inside an import object, as a PNG data URI", async () => {
    expect(await designDataUri("t", "/home.png", base)).toBe(PNG_URI);
    expect(await designDataUri("t", { src: "/home.png" }, base)).toBe(PNG_URI);
    expect(await designDataUri("t", PNG_URI, base)).toBe(PNG_URI);
  });

  // `baselineImage: design.src` where the import is already a string passes undefined; capturing with no
  // design would look like a plain regression diff with no hint why.
  it("rejects undefined, a non-PNG, a non-PNG data URI, and a missing file", async () => {
    await expect(designDataUri("t", undefined, base)).rejects.toThrow(/is undefined/);
    await expect(designDataUri("t", { width: 1 }, base)).rejects.toThrow(/not an image import/);
    await expect(designDataUri("t", "/home.jpg", base)).rejects.toThrow(/is not a PNG/);
    await expect(designDataUri("t", "data:image/jpeg;base64,/9j/4AAQ", base)).rejects.toThrow(/not a PNG data URI/);
    await expect(designDataUri("t", "data:image/png;base64,/9j/4AAQSkZJRgABAQ==", base)).rejects.toThrow(
      /not a PNG data URI/,
    );
    await expect(designDataUri("t", "data:image/png;base64,!!!!", base)).rejects.toThrow(/not a PNG data URI/);
    await expect(designDataUri("t", "/missing.png", base)).rejects.toThrow(/HTTP 404/);
  });
});
