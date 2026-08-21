/**
 * @uiverify/vitest — the client capture SDK for Vitest browser mode. Add `uiverifyPlugin()` to your
 * `vitest.config` and every browser-mode test archives its final DOM (serialized DOM + resource bytes)
 * for UI Verify to replay + diff:
 *
 *   // vitest.config.ts
 *   import { uiverifyPlugin } from "@uiverify/vitest/plugin";
 *   export default defineConfig({ plugins: [uiverifyPlugin()], test: { browser: { ... } } });
 *
 * In a test, `takeSnapshot("name")` adds an intermediate checkpoint; `disableAutoSnapshot()` opts the
 * current test out of the automatic end-of-test snapshot. After `vitest run`, `uiverify upload
 * --static-dir <dir>` ships the archive.
 */
export { takeSnapshot, disableAutoSnapshot } from "./runtime";
export { preloadFonts } from "./settle";
export type { UiverifyPluginOptions } from "./options";
