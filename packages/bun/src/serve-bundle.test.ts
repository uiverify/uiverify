import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBundle } from "./serve-bundle";

describe("serveBundle", () => {
  let preview: Awaited<ReturnType<typeof serveBundle>>;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "uiverify-serve-bundle-"));
    writeFileSync(join(dir, "mount.html"), '<!doctype html><body><script type="module" src="./mount.ts"></script></body>');
    writeFileSync(join(dir, "mount.ts"), 'document.body.append("mounted");');
    preview = await serveBundle({ entrypoint: join(dir, "mount.html") });
  });
  afterAll(() => preview.stop());

  /** Catches `/` answering only an entry named index.html. */
  test("serves an entry not named index.html at /, with or without a query", async () => {
    for (const path of ["/", "/?story=x"]) {
      const response = await fetch(preview.url + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("text/html");
      expect(await response.text()).toContain("<script");
    }
    expect((await fetch(`${preview.url}/mount.html`)).status).toBe(200);
    expect((await fetch(`${preview.url}/index.html`)).status).toBe(404);
  });
});
