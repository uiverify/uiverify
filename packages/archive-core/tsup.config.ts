import { defineConfig } from "tsup";

// Internal shared build: ESM + a SELF-CONTAINED bundled `dist/index.d.ts` (all format types inlined into
// one file). Consumers (@uiverify/playwright, @uiverify/vitest) bundle the JS into their own dist, and
// @uiverify/playwright additionally inlines these declarations into its public `.d.ts` via tsup's
// `dts.resolve` - so a published SDK never references this private, unpublished package at type level.
// `@rrweb/types` is types-only (a peer of the consumers), left external so it isn't inlined here.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@rrweb/types"],
});
