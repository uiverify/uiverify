import type { serializedNodeWithId } from "@rrweb/types";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inlineBlobs", () => {
  /** Catches a blob read that never finishes holding the capture past its deadline instead of warning. */
  it("gives up on a blob still being read at the deadline, and says so", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { inlineBlobs } = await import("./capture-dom");
    const img = { type: 2, id: 2, tagName: "img", attributes: { src: "blob:http://localhost/1" }, childNodes: [] };
    const dom = { type: 2, id: 1, tagName: "div", attributes: {}, childNodes: [img] } satisfies serializedNodeWithId;
    const warnings: string[] = [];
    const started = performance.now();
    await inlineBlobs("story", dom, { deadline: performance.now() + 50, warn: (message) => warnings.push(message) });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(img.attributes.src).toBe("blob:http://localhost/1");
    expect(warnings).toEqual([
      `[uiverify] "story": could not archive blob:http://localhost/1 (the blob: URL can't be read). UI Verify will replay this snapshot without it.`,
    ]);
  });
});
