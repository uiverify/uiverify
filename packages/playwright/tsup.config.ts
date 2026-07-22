import { defineConfig } from "tsup";

// Library build: ESM + type declarations for both entry points (ESM only — see the format note below).
// The peer/runtime deps stay external so the published artifact carries no bundled Playwright/rrweb
// copy; `rrweb-snapshot` is resolved at runtime (its UMD is read + injected into the page — see
// rrweb-runtime.ts).
export default defineConfig({
  entry: ["src/index.ts", "src/finalize.ts"],
  // ESM only: the runtime resolves rrweb-snapshot via `createRequire(import.meta.url)`, which a CJS
  // build can't provide (import.meta is empty there). Playwright's runner supports ESM deps.
  format: ["esm"],
  dts: true,
  clean: true,
  // No published sourcemaps: they'd embed the full original source in the npm tarball for no consumer
  // benefit (and roughly double its size). The readable source lives in the repo.
  sourcemap: false,
  external: ["@playwright/test", "rrweb-snapshot", "@rrweb/types"],
});
