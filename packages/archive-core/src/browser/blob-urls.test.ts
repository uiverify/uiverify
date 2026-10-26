import type { serializedNodeWithId } from "@rrweb/types";
import { describe, expect, it } from "vitest";
import { inlineBlobImages } from "./blob-urls";

const ELEMENT = 2;

function element(tagName: string, attributes: Record<string, string>, childNodes: serializedNodeWithId[] = []) {
  return { type: ELEMENT, id: 0, tagName, attributes, childNodes } satisfies serializedNodeWithId;
}

describe("inlineBlobImages", () => {
  /** Catches an object-URL image (a generated or uploaded picture) reaching the archive as a `blob:` source,
   *  which no replay can load. */
  it("replaces a nested <img> blob: source with the data URI it reads", async () => {
    const img = element("img", { src: "blob:http://localhost/1" });
    const root = element("div", {}, [element("span", {}, [img])]);
    await inlineBlobImages(root, async (url) => `data:image/png;base64,${btoa(url)}`);
    expect(img.attributes.src).toBe(`data:image/png;base64,${btoa("blob:http://localhost/1")}`);
  });

  it("leaves other sources alone and keeps a blob: source it can't read", async () => {
    const http = element("img", { src: "http://localhost/a.png" });
    const unreadable = element("img", { src: "blob:http://localhost/gone" });
    const notImg = element("video", { src: "blob:http://localhost/v" });
    const failed = await inlineBlobImages(element("div", {}, [http, unreadable, notImg]), async () => {
      throw new Error("revoked");
    });
    expect(failed).toEqual(["blob:http://localhost/gone"]);
    expect(http.attributes.src).toBe("http://localhost/a.png");
    expect(unreadable.attributes.src).toBe("blob:http://localhost/gone");
    expect(notImg.attributes.src).toBe("blob:http://localhost/v");
  });

  /** Catches an image picked from `srcset` keeping its `blob:` candidate, which the replay can't load. */
  it("replaces blob: candidates in an <img> srcset and keeps the rest", async () => {
    const img = element("img", { src: "/fallback.png", srcset: "/a.png 1x, blob:http://localhost/2 2x" });
    await inlineBlobImages(element("div", {}, [img]), async () => "data:image/png;base64,AA==");
    expect(img.attributes.srcset).toBe("/a.png 1x, data:image/png;base64,AA== 2x");
    expect(img.attributes.src).toBe("/fallback.png");
  });
});
