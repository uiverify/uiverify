import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests that drive Shoppy in a real browser and archive states with @uiverify/playwright. Some tests
 * take explicit `uiVerify.snapshot(name)` calls after an interaction (the interaction-then-screenshot
 * pattern); the SDK skips its end-of-test auto-archive when a test snapshots explicitly.
 *
 *   npm run test:e2e                              # archives -> uiverify-archive/
 *   UIVERIFY_API_KEY=… npx uiverify upload --static-dir uiverify-archive --only-changed
 */
const PORT = process.env.PORT ?? "5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    port: Number(PORT),
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
