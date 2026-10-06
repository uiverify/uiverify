import { defineConfig } from "vitest/config";

// The package's tests run in Node. The browser half is exercised by `e2e/capture.test.ts`, which runs the
// fixture suite in `e2e/fixture` in real headless Chromium; its own files don't match `*.test.ts`.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    globals: false,
  },
});
