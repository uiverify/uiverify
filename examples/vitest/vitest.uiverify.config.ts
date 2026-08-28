import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { uiverifyPlugin } from "@uiverify/vitest/plugin";
import { defineConfig } from "vitest/config";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");

/**
 * Visual + interaction tests: render real components in a real browser (Vitest browser mode) and archive
 * the result with @uiverify/vitest. Some tests drive an interaction (click, toggle) before `takeSnapshot()`
 * so the archived state is post-interaction.
 *
 *   npm run test:uiverify                         # archives -> uiverify-archive/
 *   UIVERIFY_API_KEY=… npx uiverify upload --static-dir uiverify-archive --only-changed
 */
export default defineConfig({
  plugins: [react(), uiverifyPlugin()],
  resolve: { alias: { "@": srcDir } },
  // The SDK's injected browser-setup and the test's `@uiverify/vitest` import must be ONE module instance
  // so they share per-test capture state; pre-bundling would split them and `takeSnapshot()` sees no test.
  optimizeDeps: { exclude: ["@uiverify/vitest", "@uiverify/vitest/browser-setup"] },
  test: {
    include: ["**/*.visual.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      viewport: { width: 1280, height: 900 },
      instances: [{ browser: "chromium" }],
    },
  },
});
