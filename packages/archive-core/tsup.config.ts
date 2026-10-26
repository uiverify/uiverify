import { defineConfig } from "tsup";

// Internal shared build: ESM + SELF-CONTAINED bundled declarations for each entry (the Node-side archive
// writer, and `browser/index` - the in-page capture code). Consumers bundle the JS into their own dist and
// inline these declarations into their public `.d.ts` via tsup's `dts.resolve`, so a published SDK never
// references this private, unpublished package at type level. `@rrweb/types` is types-only (a peer of the
// consumers) and `rrweb-snapshot` is the consumers' own dependency, so both stay external.
export default defineConfig({
  entry: { index: "src/index.ts", "browser/index": "src/browser/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@rrweb/types", "rrweb-snapshot"],
});
