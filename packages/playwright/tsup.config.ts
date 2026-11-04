import { defineConfig } from "tsup";

// Two builds. The library: ESM + type declarations for both entry points (ESM only — see the format note
// below). The peer/runtime deps stay external so the published artifact carries no bundled Playwright/rrweb
// copy; `rrweb-snapshot` is resolved at runtime (its UMD is read + injected into the page — see
// rrweb-runtime.ts). And the page script, below. Neither cleans `dist/` (the `build` script does), so one
// can't delete the other's output.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/finalize.ts"],
    // ESM only: the runtime resolves rrweb-snapshot via `createRequire(import.meta.url)`, which a CJS
    // build can't provide (import.meta is empty there). Playwright's runner supports ESM deps.
    format: ["esm"],
    // Inline @uiverify/archive-core's declarations into our public .d.ts: the JS bundles it (it's not
    // external), but the dts pass leaves a bare specifier by default, which would make a consumer's tsc
    // fail to find the private, unpublished package. `resolve` pulls its self-contained dist/index.d.ts in.
    dts: { resolve: [/^@uiverify\/archive-core$/] },
    // No published sourcemaps: they'd embed the full original source in the npm tarball for no consumer
    // benefit (and roughly double its size). The readable source lives in the repo.
    sourcemap: false,
    external: ["@playwright/test", "rrweb-snapshot", "@rrweb/types"],
  },
  // The page script (`src/page/main.ts`): one browser IIFE with archive-core's in-page settle code bundled
  // in, read from next to the Node bundle and installed in every document the test opens.
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
