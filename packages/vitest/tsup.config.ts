import { defineConfig } from "tsup";

// Library build: ESM + types for the three entries. `index`/`browser-setup` run in the browser test
// realm; `plugin` runs in Node (Vite config). The runner deps stay external (resolved by Vite/Vitest at
// runtime); `@uiverify/archive-core` is intentionally NOT external so its Node writer is bundled into
// `plugin.js` (and its `/browser` capture code into the browser entries) and the package needs no runtime
// dependency on an unpublished workspace package. Its declarations are inlined for the same reason: the
// public `preloadFonts` is archive-core's.
export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/browser-setup.ts"],
  format: ["esm"],
  dts: { resolve: [/^@uiverify\/archive-core(\/browser)?$/] },
  clean: true,
  sourcemap: false,
  external: [
    "vitest",
    "vitest/config",
    "vitest/node",
    "vitest/browser",
    "@vitest/browser",
    "rrweb-snapshot",
    "@rrweb/types",
    "vite",
  ],
});
