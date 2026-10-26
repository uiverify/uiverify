import { defineConfig } from "tsup";

// Two builds. The Bun side (`index`, `run`): ESM + types, with `@uiverify/archive-core` bundled and its
// declarations inlined, so the package depends on no unpublished workspace package. The page script: one
// browser IIFE (`dist/page-script.js`) with rrweb-snapshot and archive-core's in-page code bundled in; the Bun
// side reads it from next to itself and installs it in every document.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/run.ts"],
    format: ["esm"],
    platform: "node",
    target: "esnext",
    dts: { resolve: [/^@uiverify\/archive-core(\/browser)?$/] },
    sourcemap: false,
    external: ["bun:test", "bun"],
    noExternal: [/^@uiverify\/archive-core/],
  },
  {
    entry: { "page-script": "src/page/main.ts" },
    format: ["iife"],
    platform: "browser",
    target: "es2022",
    dts: false,
    sourcemap: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
  },
]);
