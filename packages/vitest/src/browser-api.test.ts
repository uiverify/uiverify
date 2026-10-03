import { describe, expect, it } from "vitest";
import { resolveBrowserApi } from "./browser-api";

/** Stands in for Vite's `this.resolve`: resolves the ids in `known`, and rejects anything else the way Vite
 *  rejects an import of a package export that doesn't exist. */
function resolver(known: string[]) {
  const asked: string[] = [];
  const resolve = async (id: string) => {
    asked.push(id);
    if (known.includes(id)) return { id: `\0${id}` };
    throw new Error(`Missing "${id}" specifier`);
  };
  return { resolve, asked };
}

describe("resolveBrowserApi", () => {
  it("uses vitest/browser when the running Vitest provides it (Vitest 4 and 5)", async () => {
    const { resolve, asked } = resolver(["vitest/browser", "@vitest/browser/context"]);
    expect(await resolveBrowserApi("vitest/browser", resolve)).toEqual({ id: "\0vitest/browser" });
    expect(asked).toEqual(["vitest/browser"]);
  });

  it("falls back to @vitest/browser/context when vitest/browser does not exist (Vitest 3)", async () => {
    const { resolve } = resolver(["@vitest/browser/context"]);
    expect(await resolveBrowserApi("vitest/browser", resolve)).toEqual({ id: "\0@vitest/browser/context" });
  });

  it("falls back when vitest/browser resolves to nothing", async () => {
    const resolve = async (id: string) => (id === "@vitest/browser/context" ? { id } : null);
    expect(await resolveBrowserApi("vitest/browser", resolve)).toEqual({ id: "@vitest/browser/context" });
  });

  it("leaves every other import to the rest of the resolver chain", async () => {
    const { resolve, asked } = resolver(["vitest/browser"]);
    expect(await resolveBrowserApi("react", resolve)).toBeNull();
    expect(asked).toEqual([]);
  });
});
