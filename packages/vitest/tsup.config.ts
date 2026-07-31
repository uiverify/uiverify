import { defineConfig } from "tsup";

// Library build: ESM + types for the three entries. `index`/`browser-setup` run in the browser test
// realm; `plugin` runs in Node (Vite config). The runner deps stay external (resolved by Vite/Vitest at
// runtime); `@uiverify/archive-core` is intentionally NOT external so its Node writer is bundled into
// `plugin.js` and the package needs no runtime dependency on an unpublished workspace package.
export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/browser-setup.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: [
    "vitest",
    "vitest/config",
    "vitest/node",
    "@vitest/browser",
    "@vitest/browser/context",
    "rrweb-snapshot",
    "@rrweb/types",
    "vite",
  ],
});
